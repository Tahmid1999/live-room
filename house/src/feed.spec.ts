import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Coalescer, parseSse, toBandwidthUpdate } from './feed';

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
