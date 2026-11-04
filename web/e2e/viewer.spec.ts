import { expect, Page, test, WebSocketRoute } from '@playwright/test';
import Redis from 'ioredis';
import { clearIpLimits } from './limits';

test.beforeEach(clearIpLimits);

test('a visitor joins the audio room, gifts, and breaks the wallet with x20', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Desk camera')).toBeVisible();
  await expect(page.getByText('Late radio')).toBeVisible();
  await expect(page.getByText('starts when you open it')).toBeVisible();
  // The badge names the kind; both rooms run on the same node, so it never names an engine.
  await expect(page.locator('.badge')).toHaveText(['video', 'audio']);
  const who = page.locator('.who').first();
  await expect(who).toHaveText(/^guest-\d{4} · 1,000 coins$/);

  await page.getByRole('link', { name: /Late radio/ }).click();

  await expect(page.getByText('1 watching')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/^audio · self-hosted LiveKit · .+ per viewer · this room costs my server .+ right now$/)).toBeVisible();
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

test('a paused video room says why and leaves chat and gifts switched off', async ({ page }) => {
  const error = 'video paused until the 1st: monthly transfer budget 80% used';
  await page.route('**/api/rooms/*/join', (route) => route.fulfill({ status: 503, json: { error } }));
  await page.goto('/');
  await page.getByRole('link', { name: /Desk camera/ }).click();

  await expect(page.locator('.stage-note.err')).toHaveText(error);
  await expect(page.getByPlaceholder('Say something')).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Tea/ })).toBeDisabled();
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

test('a video room names its kind, and takes the seat away when the join proof lapses', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /Desk camera/ }).click();
  await expect(page.getByText(/^video · self-hosted LiveKit · .+ per viewer · this room costs my server .+ right now$/)).toBeVisible();
  await expect(page.getByText('1 watching')).toBeVisible({ timeout: 10_000 });

  // The server's sweep (every 10 s) removes a seat with no join proof. Deleting
  // the proof stands in for the 15 minutes; doing it on every poll covers the
  // case where the browser had not finished connecting to the node yet.
  const roomId = page.url().split('/').pop()!;
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6383/0');
  try {
    await expect
      .poll(
        async () => {
          const keys = await redis.keys(`joined:${roomId}:*`);
          if (keys.length) await redis.del(...keys);
          return page.getByText('still watching? reopen the room').count();
        },
        { timeout: 45_000, intervals: [2000] },
      )
      .toBe(1);
  } finally {
    await redis.quit();
  }
  await expect(page.getByRole('button', { name: 'reopen' })).toBeVisible();
  await expect(page.getByPlaceholder('Say something')).toBeDisabled();
});

// The player renews every 10 minutes; the fake clock gets there without waiting.
async function renewAfterTenMinutes(page: Page, room: RegExp) {
  await page.clock.install();
  let renews = 0;
  page.on('request', (req) => req.method() === 'POST' && /\/rooms\/\w+\/renew$/.test(req.url()) && renews++);
  await page.goto('/');
  const node = page.waitForEvent('websocket', (ws) => ws.url().includes(':7890'));
  await page.getByRole('link', { name: room }).click();
  await expect(page.getByText('1 watching')).toBeVisible({ timeout: 10_000 });
  // A jump in time while the client is still connecting would fire its connect
  // timeout, so wait for the node to answer and for the handshake to finish.
  await (await node).waitForEvent('framereceived');
  await page.waitForTimeout(3000);
  await expect
    .poll(
      async () => {
        await page.clock.fastForward('10:00');
        return renews;
      },
      { intervals: [1000], timeout: 30_000 },
    )
    .toBeGreaterThan(0);
}

for (const [status, error] of [
  [403, 'still watching? reopen the room'],
  [503, 'video paused until the 1st: monthly transfer budget 80% used'],
] as const) {
  test(`a ${status} on the video renewal asks the viewer to reopen the room`, async ({ page }) => {
    await page.route('**/api/rooms/*/renew', (route) => route.fulfill({ status, json: { error } }));
    await renewAfterTenMinutes(page, /Desk camera/);
    await expect(page.locator('.stage-note.err')).toHaveText(error);
    await expect(page.getByRole('button', { name: 'reopen' })).toBeVisible();
    await expect(page.getByPlaceholder('Say something')).toBeDisabled();
  });
}

test('a granted renewal changes nothing on screen, and comes round again ten minutes later', async ({ page }) => {
  // Mocked: jumping ten minutes also trips the socket's ping timeout, so the
  // server has already dropped this viewer's presence and would refuse the
  // real one. The API suite covers the real renewal.
  let granted = 0;
  await page.route('**/api/rooms/*/renew', (route) => {
    granted++;
    return route.fulfill({ json: { kind: 'AUDIO', url: 'ws://127.0.0.1:7890', room: 'x', identity: 'y', token: 'z' } });
  });
  await renewAfterTenMinutes(page, /Late radio/);
  const first = granted;
  await page.clock.fastForward('10:00');
  await expect.poll(() => granted).toBeGreaterThan(first);
  await expect(page.locator('.stage-note.err')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'reopen' })).toHaveCount(0);
});
