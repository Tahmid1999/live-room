// Usage: node smoke.mjs https://live.tahmidalavi.com
// One line per check; exit code 1 if any failed. Makes one guest, joins the
// audio house room and sends one 10-coin tea, so it counts against the
// per-network limits (5 new guests and 12 joins an hour) like any visitor.
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('usage: node smoke.mjs <base url>');
  process.exit(2);
}

let failed = 0;
async function check(name, run) {
  try {
    const detail = await run();
    console.log(`ok    ${name}${detail ? ` (${detail})` : ''}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

async function json(path, init) {
  const res = await fetch(`${base}/api${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} answered ${res.status}`);
  return { body: await res.json(), res };
}

// The first chunk of the event stream is a keep-alive comment. If a proxy
// buffered or compressed the stream it would not arrive before the timeout.
async function openStream() {
  const abort = new AbortController();
  const res = await fetch(`${base}/api/events/stream`, { signal: abort.signal });
  expect(res.ok, `stream answered ${res.status}`);
  expect(res.headers.get('content-type')?.includes('text/event-stream'), 'not an event stream');
  expect(!res.headers.get('content-encoding'), `stream is ${res.headers.get('content-encoding')}-encoded`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const state = { text: '' };
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      state.text += decoder.decode(value, { stream: true });
    }
  })();
  const until = async (pattern, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pattern.test(state.text)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`nothing matching ${pattern} within ${ms} ms`);
  };
  return { until, close: () => abort.abort(), pump };
}

function waitForEvent(socket, event, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event} within ${ms} ms`)), ms);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

let stream;
let cookie = '';
let audio;
let socket;

await check('/api/health reports mongo and redis ok', async () => {
  const { body } = await json('/health');
  expect(body.mongo === 'ok' && body.redis === 'ok', JSON.stringify(body));
});

await check('/api/rooms lists the two house rooms', async () => {
  const { body } = await json('/rooms');
  const house = body.filter((r) => r.house);
  expect(house.length === 2, `${house.length} house rooms`);
  audio = house.find((r) => r.kind === 'AUDIO');
  expect(audio && house.some((r) => r.kind === 'VIDEO'), 'need one video and one audio room');
  return house.map((r) => `${r.kind} ${r.engine}`).join(', ');
});

await check('event stream arrives unbuffered and uncompressed', async () => {
  stream = await openStream();
  await stream.until(/keep-alive/, 3000);
});

await check('guest cookie is issued and marked Secure', async () => {
  const { res } = await json('/me');
  const set = res.headers.getSetCookie().find((c) => c.startsWith('lr_guest='));
  expect(set, 'no lr_guest cookie');
  cookie = set.split(';')[0];
  // Secure is only set when the API trusts the proxy's X-Forwarded-Proto, the
  // same setting that lets the per-network limits see the visitor, not Caddy.
  if (base.startsWith('https')) {
    expect(/;\s*secure/i.test(set), 'cookie is not Secure: the API does not trust the proxy');
  }
});

await check('joining the audio room mints a LiveKit token', async () => {
  expect(audio && cookie, 'needs the rooms and the guest above');
  const { body } = await json(`/rooms/${audio.id}/join`, { method: 'POST', headers: { cookie } });
  expect(body.engine === 'livekit' && body.token, 'not a livekit join');
  expect(body.url.startsWith(base.startsWith('https') ? 'wss://' : 'ws://'), `LiveKit url is ${body.url}`);
});

await check('socket connects and joins the room', async () => {
  expect(audio && cookie, 'needs the rooms and the guest above');
  socket = io(base, { transports: ['websocket'], extraHeaders: { cookie }, reconnection: false });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', (err) => reject(new Error(err.message)));
  });
  // The leaderboard is the first thing the server sends after a join.
  const lb = waitForEvent(socket, 'lb', 5000);
  socket.emit('room:join', { roomId: audio.id });
  await lb;
  return socket.io.engine.transport.name;
});

await check('a gift reaches the socket and the wallet', async () => {
  expect(socket?.connected, 'needs the socket above');
  const gift = waitForEvent(socket, 'gift', 5000);
  const { body } = await json(`/rooms/${audio.id}/gifts`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ giftId: 'tea', tapId: randomUUID() }),
  });
  expect(body.balance === 990 && body.duplicate === false, `wallet answered ${JSON.stringify(body)}`);
  const seen = await gift;
  expect(seen.giftId === 'tea' && seen.coins === 10, `socket saw ${JSON.stringify(seen)}`);
  return `balance ${body.balance}, lock ${Math.round(body.lockMs)} ms`;
});

await check('the gift shows up on the event stream', async () => {
  expect(stream, 'needs the stream above');
  await stream.until(/"kind":"gift"/, 5000);
});

await check('/api/bandwidth returns a projection', async () => {
  const { body } = await json('/bandwidth');
  expect(Array.isArray(body.projection?.lines), 'no projection.lines');
  expect(body.budgetBps > 0, `budgetBps is ${body.budgetBps}`);
  return `budget ${Math.round(body.budgetBps / 1e6)} Mbps, ${body.series.length} samples`;
});

socket?.close();
stream?.close();
await stream?.pump;
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
