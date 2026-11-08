import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer, Server } from 'node:http';
import { Coalescer, Feed, parseSse, toBandwidthUpdate } from './feed';

const join = { type: 'join', roomId: 'r1', name: 'Ana', t: 1 };
const viewers = (count: number, roomId = 'r1') => ({ type: 'viewers', roomId, count, t: count });

describe('parseSse', () => {
  it('reads one event per blank line', () => {
    const out = parseSse(`data: ${JSON.stringify(join)}\n\ndata: ${JSON.stringify(viewers(3))}\n\n`, '');
    assert.deepEqual(out.events, [join, viewers(3)]);
    assert.equal(out.carry, '');
  });

  it('joins an event split across chunks', () => {
    const text = `data: ${JSON.stringify(join)}\n\n`;
    const cut = 12;
    const first = parseSse(text.slice(0, cut), '');
    assert.deepEqual(first.events, []);
    const second = parseSse(text.slice(cut), first.carry);
    assert.deepEqual(second.events, [join]);
    assert.equal(second.carry, '');
  });

  it('handles a boundary that falls between the two newlines and CRLF', () => {
    const first = parseSse(`data: ${JSON.stringify(join)}\r\n`, '');
    assert.deepEqual(first.events, []);
    assert.deepEqual(parseSse('\r\n', first.carry).events, [join]);
  });

  it('ignores comments and heartbeats', () => {
    const out = parseSse(`: hi\n\n:keepalive\n\nevent: ping\n\ndata: ${JSON.stringify(join)}\n\n`, '');
    assert.deepEqual(out.events, [join]);
  });

  it('skips a data line that is not JSON', () => {
    const out = parseSse(`data: {oops\n\ndata: ${JSON.stringify(join)}\n\n`, '');
    assert.deepEqual(out.events, [join]);
  });
});

describe('toBandwidthUpdate', () => {
  const body = {
    series: [
      { t: 1, livekitBps: 100 },
      { t: 2, livekitBps: 4_000_000 },
    ],
    transfer: { usedBytes: 5_000, budgetBytes: 9_000, paused: false },
  };

  it('takes bps from the last series point and the bytes from transfer', () => {
    assert.deepEqual(toBandwidthUpdate(body), {
      type: 'bandwidth',
      bps: 4_000_000,
      usedBytes: 5_000,
      budgetBytes: 9_000,
    });
  });

  it('reads an unmeasured or missing last point as zero bps', () => {
    assert.deepEqual(toBandwidthUpdate({ ...body, series: [{ t: 1, livekitBps: null }] }), { type: 'bandwidth', bps: 0, usedBytes: 5_000, budgetBytes: 9_000 });
    assert.deepEqual(toBandwidthUpdate({ ...body, series: [] }), { type: 'bandwidth', bps: 0, usedBytes: 5_000, budgetBytes: 9_000 });
  });

  it('returns null for a malformed body', () => {
    assert.equal(toBandwidthUpdate(null), null);
    assert.equal(toBandwidthUpdate('x'), null);
    assert.equal(toBandwidthUpdate({}), null);
    assert.equal(toBandwidthUpdate({ series: [] }), null);
    assert.equal(toBandwidthUpdate({ ...body, transfer: { usedBytes: 'a', budgetBytes: 1 } }), null);
    assert.equal(toBandwidthUpdate({ ...body, series: 'no' }), null);
  });
});

describe('Coalescer', () => {
  it('passes gifts and joins straight through', () => {
    const out: unknown[] = [];
    const c = new Coalescer((u) => out.push(u), 20);
    c.push(join as never);
    assert.deepEqual(out, [join]);
    c.stop();
  });

  it('keeps only the latest viewer count per room within a window', async () => {
    const out: unknown[] = [];
    const c = new Coalescer((u) => out.push(u), 20);
    for (let i = 1; i <= 50; i++) c.push(viewers(i) as never);
    c.push(viewers(7, 'r2') as never);
    assert.deepEqual(out, []);
    await sleep(60);
    assert.deepEqual(out, [viewers(50), viewers(7, 'r2')]);
    c.stop();
  });

  it('flushes at most once per window and goes quiet when idle', async () => {
    const out: unknown[] = [];
    const c = new Coalescer((u) => out.push(u), 20);
    c.push(viewers(1) as never);
    await sleep(40);
    c.push(viewers(2) as never);
    await sleep(40);
    assert.deepEqual(out, [viewers(1), viewers(2)]);
    c.stop();
  });

  it('drops pending counts on stop', async () => {
    const out: unknown[] = [];
    const c = new Coalescer((u) => out.push(u), 20);
    c.push(viewers(1) as never);
    c.stop();
    await sleep(40);
    assert.deepEqual(out, []);
  });
});

describe('Feed', () => {
  const servers: Server[] = [];
  after(() => servers.forEach((s) => (s.closeAllConnections(), s.close())));

  async function serve(onFeed: (n: number, res: import('node:http').ServerResponse) => void) {
    const hits = { feed: 0, bandwidth: 0 };
    const server = createServer((req, res) => {
      if (req.url === '/bandwidth') {
        hits.bandwidth++;
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ series: [{ livekitBps: 5 }], transfer: { usedBytes: 1, budgetBytes: 2 } }));
      }
      assert.equal(req.headers['x-house-key'], 'k');
      onFeed(++hits.feed, res);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { hits, apiUrl, server };
  }

  const open = (res: import('node:http').ServerResponse) => res.writeHead(200, { 'content-type': 'text/event-stream' });

  it('reconnects after a drop and delivers the next event', async () => {
    const { hits, apiUrl } = await serve((n, res) => {
      open(res);
      res.write(`data: ${JSON.stringify({ type: 'join', roomId: 'r', name: `n${n}`, t: n })}

`);
      if (n === 1) setTimeout(() => res.end(), 30);
    });
    const names: string[] = [];
    const states: string[] = [];
    const feed = new Feed({ apiUrl, houseKey: 'k', onState: (s) => states.push(s), reconnectMs: 40, bandwidthMs: 1000 });
    feed.start((u) => u.type === 'join' && names.push(u.name));
    while (names.length < 2) await sleep(10);
    feed.stop();
    assert.deepEqual(names, ['n1', 'n2']);
    assert.deepEqual(states, ['connected', 'lost', 'connected']);
    assert.equal(hits.feed, 2);
  });

  it('push() sends a count the stream never carried, coalesced with the stream counts', async () => {
    const { apiUrl } = await serve((_n, res) => open(res));
    const feed = new Feed({ apiUrl, houseKey: 'k', onState: () => {}, bandwidthMs: 1000 });
    const counts: number[] = [];
    feed.push(viewers(9) as never);
    feed.start((u) => u.type === 'viewers' && counts.push(u.count));
    feed.push(viewers(1) as never);
    feed.push(viewers(1) as never);
    while (counts.length < 1) await sleep(10);
    feed.stop();
    assert.deepEqual(counts, [1]);
  });

  it('stop() ends the stream and the poll: no later request, no timers left', async () => {
    const { hits, apiUrl } = await serve((_n, res) => open(res));
    const feed = new Feed({ apiUrl, houseKey: 'k', onState: () => {}, reconnectMs: 20, bandwidthMs: 20 });
    const updates: string[] = [];
    feed.start((u) => updates.push(u.type));
    while (hits.bandwidth < 2 || hits.feed < 1) await sleep(10);
    feed.stop();
    await sleep(30);
    const after = { ...hits, updates: updates.length };
    await sleep(150);
    assert.deepEqual({ ...hits, updates: updates.length }, after);
    // The stream was cut by stop(), not left to the server.
    const timers = (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo();
    assert.equal(timers.filter((r) => r === 'Timeout').length, 0);
  });
});
