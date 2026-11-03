import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { io, Socket } from 'socket.io-client';
import { clearIpLimits } from './limits';

const API = 'http://127.0.0.1:4110';
const PORTFOLIO =
  'frame-ancestors https://tahmidalavi.netlify.app https://*--tahmidalavi.netlify.app https://tahmidalavi.com';

test.beforeEach(clearIpLimits);

type Card = { id: string; kind: 'VIDEO' | 'AUDIO'; title: string };

// A guest with its own cookie, outside the browser: the stats limit is one
// report per two seconds per guest, so each watcher needs its own.
async function newGuest() {
  const res = await fetch(`${API}/me`);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

async function houseRoom(kind: Card['kind']) {
  const rooms: Card[] = await (await fetch(`${API}/rooms`)).json();
  return rooms.find((r) => r.kind === kind)!;
}

async function watch(room: Card, bps: number): Promise<Socket> {
  const cookie = await newGuest();
  const joined = await fetch(`${API}/rooms/${room.id}/join`, { method: 'POST', headers: { cookie } });
  expect(joined.ok).toBe(true);
  const socket = io(API, { transports: ['websocket'], extraHeaders: { cookie } });
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  const inRoom = new Promise<void>((resolve) => socket.once('chat:history', () => resolve()));
  socket.emit('room:join', { roomId: room.id });
  await inRoom;
  socket.emit('stats', { bps });
  return socket;
}

const adminPassword = () =>
  /^ADMIN_PASSWORD=(.*)$/m.exec(readFileSync(path.resolve(__dirname, '..', '..', 'api', '.env'), 'utf8'))![1];

test('the rooms table lists both house rooms', async ({ page }) => {
  await page.goto('/admin');
  const table = page.getByRole('table');
  await expect(table.getByRole('row', { name: /Desk camera.*house stream.*VIDEO.*Agora/ })).toBeVisible();
  await expect(table.getByRole('row', { name: /Late radio.*house stream.*AUDIO.*LiveKit/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kill' })).toHaveCount(0);
});

test('the bandwidth page shows the crossing the API computed', async ({ page, request }) => {
  const watchers = [await watch(await houseRoom('VIDEO'), 1_400_000), await watch(await houseRoom('AUDIO'), 48_000)];
  try {
    await expect
      .poll(async () => (await (await request.get(`${API}/bandwidth`)).json()).projection.crossing)
      .toMatchObject({ agora: expect.any(Number), livekit: expect.any(Number) });
    const { projection, budgetBps } = await (await request.get(`${API}/bandwidth`)).json();

    await page.goto('/admin/bandwidth');
    // 20 TB a month is 61,728,395 bps, which 1.4 Mbps and 48 kbps cross at 44 and 1,286.
    expect(budgetBps).toBe(61_728_395);
    expect(projection.crossing).toEqual({ agora: 44, livekit: 1286 });
    await expect(page.getByText('video crosses at ~44 viewers · audio at ~1,286')).toBeVisible();
    await expect(page.getByText('projection from measured bitrate')).toBeVisible();
    await expect(page.getByText(/^audio · LiveKit · 48 kbps per viewer$/)).toBeVisible();
    await expect(page.getByText(/^\d[\d,]* \/ 10,000$/)).toBeVisible();
    // Two charts: the 60-minute series and the projection.
    await expect(page.locator('.recharts-wrapper')).toHaveCount(2);
  } finally {
    watchers.forEach((s) => s.close());
  }
});

test('a gift shows on /hood within 3 seconds', async ({ page }) => {
  await page.goto('/hood');
  await expect(page.locator('.hood')).toBeVisible();

  const audio = await houseRoom('AUDIO');
  const cookie = await newGuest();
  await fetch(`${API}/rooms/${audio.id}/join`, { method: 'POST', headers: { cookie } });
  const tapId = randomUUID();
  const sent = await fetch(`${API}/rooms/${audio.id}/gifts`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ giftId: 'tea', tapId }),
  });
  expect(sent.status).toBe(200);

  await expect(page.getByText(new RegExp(`gift tap-${tapId.slice(0, 4)} · lock \\d+ ms`))).toBeVisible({
    timeout: 3000,
  });
});

test('/hood keeps newest on top and shows a replayed line once', async ({ page }) => {
  const lines = (n: number) =>
    Array.from({ length: n }, (_, i) => `data: ${JSON.stringify({ t: 1000 + i, kind: 'engine', replica: 'a', text: `line ${i}` })}\n\n`).join('');
  let streams = 0;
  await page.route('**/api/events/stream', (route) => {
    streams++;
    // Closing right after the backlog makes EventSource reconnect and ask again.
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: 'retry: 200\n\n' + lines(3),
    });
  });
  await page.goto('/hood');
  await expect.poll(() => streams).toBeGreaterThan(1);
  const items = page.locator('.hood li');
  await expect(items).toHaveCount(3);
  await expect(items.first()).toContainText('line 2');
  await expect(items.last()).toContainText('line 0');
});

test('the CSP differs between the embeddable pages and the rest', async ({ request }) => {
  const csp = async (url: string) => (await request.get(url)).headers()['content-security-policy'];
  expect(await csp('/')).toBe("frame-ancestors 'none'");
  expect(await csp('/admin')).toBe(PORTFOLIO);
  expect(await csp('/admin/bandwidth')).toBe(PORTFOLIO);
  expect(await csp('/hood')).toBe(PORTFOLIO);
});

test('signing in adds the kill button, and it asks before killing', async ({ page }) => {
  await page.goto('/admin/login');
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('wrong password')).toBeVisible();

  await page.getByLabel('Password').fill(adminPassword());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  const kill = page.getByRole('button', { name: 'Kill' });
  await expect(kill).toHaveCount(2);

  await kill.first().click();
  await expect(page.getByText(/^Kill (Desk camera|Late radio)\?$/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('row', { name: /LIVE/ })).toHaveCount(2);
});
