import { expect, Page, test, WebSocketRoute } from '@playwright/test';
import Redis from 'ioredis';
import { clearIpLimits } from './limits';

test.beforeEach(clearIpLimits);

test('a visitor joins the audio room, gifts, and breaks the wallet with x20', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Desk camera')).toBeVisible();
  await expect(page.getByText('Late radio')).toBeVisible();
  await expect(page.getByText('starts when you open it')).toBeVisible();
  const who = page.locator('.who').first();
  await expect(who).toHaveText(/^guest-\d{4} · 1,000 coins$/);

  await page.getByRole('link', { name: /Late radio/ }).click();

  await expect(page.getByText('1 watching')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/^audio · my LiveKit server/)).toBeVisible();
  await expect(who).toHaveText(/ 1,000 coins$/);

  await page.getByRole('button', { name: /^Tea/ }).click();
  await expect(who).toHaveText(/ 990 coins$/);
  await expect(page.getByText(/guest-\d{4} sent Tea · 10/)).toBeVisible();

  await page.getByRole('button', { name: /^Clap/ }).click();
  await expect(who).toHaveText(/ 890 coins$/);

  await page.getByRole('button', { name: 'Send x20' }).click();
  const result = page.locator('.result');
  await expect(result).toHaveText(/^20 sent · \d+ ok · \d+ refused/);

  const [, ok, refused, balance] = (await result.textContent())!.match(
    /20 sent · (\d+) ok · (\d+) refused.* · balance (\d+)$/,
  )!.map((v, i) => (i ? Number(v) : v)) as [string, number, number, number];
  expect(ok + refused).toBe(20);
  // 890 left, 100 a tap: the wallet stops at 8 and the rest are refused.
  expect(ok).toBe(8);
  expect(balance).toBe(890 - ok * 100);
  await expect(who).toHaveText(new RegExp(` ${balance} coins$`));
  await expect(result).toContainText('not enough coins');

  await expect(page.getByText(/^1\. guest-\d{4}/)).toBeVisible({ timeout: 5_000 });
});

test('a refused join leaves chat and gifts switched off', async ({ page }) => {
  await page.route('**/api/rooms/*/join', (route) =>
    route.fulfill({ status: 409, json: { error: 'room is full' } }),
  );
  await page.goto('/');
  await page.getByRole('link', { name: /Late radio/ }).click();

  await expect(page.getByText('room is full')).toBeVisible();
  await expect(page.getByPlaceholder('Say something')).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Tea/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send x20' })).toBeDisabled();
});

// The server forgets a join 15 minutes after the phone's last report. Deleting
// the marker and cutting the socket is that, without waiting a quarter hour.
async function lapseJoin(page: Page, sockets: WebSocketRoute[]) {
  const roomId = page.url().split('/').pop()!;
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6383/0');
  await redis.del(...(await redis.keys(`joined:${roomId}:*`)));
  await redis.quit();
  await sockets[0].close();
}

test('a reconnect after the join lapsed joins again instead of locking the room', async ({ page }) => {
  const sockets: WebSocketRoute[] = [];
  // The server sends the chat history as the last step of a successful room:join.
  let histories = 0;
  await page.routeWebSocket(/socket\.io/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((frame) => {
      if (String(frame).includes('chat:history')) histories++;
      ws.send(frame);
    });
    sockets.push(ws);
  });
  let joins = 0;
  page.on('request', (req) => req.method() === 'POST' && /\/rooms\/\w+\/join$/.test(req.url()) && joins++);

  await page.goto('/');
  await page.getByRole('link', { name: /Late radio/ }).click();
  await expect(page.getByText('1 watching')).toBeVisible({ timeout: 10_000 });
  expect(joins).toBe(1);
  expect(histories).toBe(1);

  await lapseJoin(page, sockets);

  // Back in the room: a second join over HTTP, then a second history.
  await expect.poll(() => histories, { timeout: 10_000 }).toBe(2);
  expect(joins).toBe(2);
  // Only a socket that is in the room hears its own message echoed.
  // Chat history outlives the run, so an earlier run's line must not match.
  const said = `still here ${Date.now()}`;
  await page.getByPlaceholder('Say something').fill(said);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.chat').getByText(said)).toHaveCount(1);
  await expect(page.locator('.stage-note.err')).toHaveCount(0);
});

test('a reconnect whose repair join is refused locks the room', async ({ page }) => {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/socket\.io/, (ws) => {
    ws.connectToServer();
    sockets.push(ws);
  });
  let joins = 0;
  await page.route('**/api/rooms/*/join', (route) =>
    ++joins === 1 ? route.continue() : route.fulfill({ status: 409, json: { error: 'room is full' } }),
  );

  await page.goto('/');
  await page.getByRole('link', { name: /Late radio/ }).click();
  await expect(page.getByText('1 watching')).toBeVisible({ timeout: 10_000 });

  await lapseJoin(page, sockets);

  await expect(page.getByText('room is full')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByPlaceholder('Say something')).toBeDisabled();
  expect(joins).toBe(2);
});
