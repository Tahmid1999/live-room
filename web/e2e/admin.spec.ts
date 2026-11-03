import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Redis from 'ioredis';
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
  // The API only takes a handshake from the web origin, as a browser on the page would send it.
  const socket = io(API, { transports: ['websocket'], extraHeaders: { cookie, origin: 'http://localhost:3130' } });
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  const inRoom = new Promise<void>((resolve) => socket.once('chat:history', () => resolve()));
  socket.emit('room:join', { roomId: room.id });
  await inRoom;
  socket.emit('stats', { bps });
  return socket;
}

// Test reports are fake bitrates; eg:last:* never expires, so left behind they
// would feed the dev API's projection as if a viewer had measured them. The
// 60 s LiveKit byte baseline is not ours and is left alone.
async function clearEgress() {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6383/0');
  const keys = (await redis.keys('eg:*')).filter((k) => k !== 'eg:lk:prev');
  if (keys.length) await redis.del(...keys);
  await redis.quit();
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
    // 'last' would mean the numbers came from an earlier run, not these watchers.
    expect(projection.perViewer.agora.source).toBe('live');
    expect(projection.perViewer.livekit.source).toBe('live');
    await expect(page.getByText('video crosses at ~44 viewers · audio at ~1,286')).toBeVisible();
    await expect(page.getByText('projection from measured bitrate')).toBeVisible();
    await expect(page.getByText(/^audio · LiveKit · 48 kbps per viewer$/)).toBeVisible();
    await expect(page.getByText(/^\d[\d,]* \/ 10,000$/)).toBeVisible();
    // Two charts: the 60-minute series and the projection.
    await expect(page.locator('.recharts-wrapper')).toHaveCount(2);
    await expect(page.getByText('audio egress, measured at LiveKit')).toBeVisible();
    await expect(page.getByText('audio egress, viewer reports (cross-check)')).toBeVisible();
  } finally {
    watchers.forEach((s) => s.close());
    // Let the server see the disconnects before the keys go, or a leave could write one back.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await clearEgress();
  }
});

test('the bandwidth page draws the empty projection when nothing is measured', async ({ page, request }) => {
  const real = await (await request.get(`${API}/bandwidth`)).json();
  const empty = { ...real, projection: { lines: [], crossing: {}, perViewer: {} } };
  await page.route('**/api/bandwidth', (route) => route.fulfill({ json: empty }));
  await page.goto('/admin/bandwidth');
  await expect(page.getByText('no measured bitrate yet, so nothing to project')).toBeVisible();
  await expect(page.getByText('video · Agora · not measured yet')).toBeVisible();
  await expect(page.getByText('audio · LiveKit · not measured yet')).toBeVisible();
  // Both charts keep their axes, and the projection keeps its budget line.
  await expect(page.locator('.recharts-wrapper')).toHaveCount(2);
  await expect(page.getByText(/server budget 61\.7 Mbps/)).toBeVisible();
  await expect(page.getByText('concurrent viewers, √ scale')).toBeVisible();
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

test('/hood opens a new stream after the server refuses one', async ({ page }) => {
  let streams = 0;
  await page.route('**/api/events/stream', (route) => {
    streams++;
    const ev = { t: 5000, kind: 'engine', replica: 'a', text: 'back again' };
    // A 502 leaves an EventSource closed for good; only a new one can recover.
    return streams === 1
      ? route.fulfill({ status: 502, body: 'bad gateway' })
      : route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: 'retry: 60000\n\ndata: ' + JSON.stringify(ev) + '\n\n',
        });
  });
  await page.goto('/hood');
  await expect(page.getByText('reconnecting')).toBeVisible();
  await expect(page.getByText('back again')).toBeVisible({ timeout: 8000 });
  expect(streams).toBe(2);
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

test('sign-in says so when the browser did not keep the cookie', async ({ page }) => {
  // What a cross-site iframe looks like from the page: the login succeeds, /me still says no.
  await page.route('**/api/admin/me', (route) => route.fulfill({ json: { admin: false } }));
  await page.goto('/admin/login');
  await page.getByLabel('Password').fill(adminPassword());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('sign in from the full-size page')).toBeVisible();
  await expect(page.getByRole('link', { name: 'open the sign-in page in a new tab' })).toHaveAttribute(
    'target',
    '_blank',
  );
  await expect(page).toHaveURL(/\/admin\/login$/);
});
