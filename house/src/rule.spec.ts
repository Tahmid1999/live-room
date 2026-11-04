import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decide, videoPaused } from './rule';

const now = 1_000_000;
const idle = { running: false, viewers: 0, emptySince: null, paused: false, now };

describe('decide', () => {
  it('starts when someone is watching and the house is not running', () => {
    assert.equal(decide({ ...idle, viewers: 1 }), 'start');
  });

  it('keeps waiting while nobody is watching', () => {
    assert.equal(decide(idle), 'keep');
  });

  it('keeps running while viewers are present', () => {
    assert.equal(decide({ ...idle, running: true, viewers: 3 }), 'keep');
  });

  it('keeps running 59 s after the last viewer left', () => {
    assert.equal(decide({ ...idle, running: true, emptySince: now - 59_000 }), 'keep');
  });

  it('stops 60 s after the last viewer left', () => {
    assert.equal(decide({ ...idle, running: true, emptySince: now - 60_000 }), 'stop');
  });

  it('stops at once when video is paused, even with viewers', () => {
    assert.equal(decide({ ...idle, running: true, viewers: 2, paused: true }), 'stop');
  });

  it('does not start while video is paused', () => {
    assert.equal(decide({ ...idle, viewers: 2, paused: true }), 'keep');
  });
});

describe('videoPaused', () => {
  it('follows the API when it reports the transfer budget', () => {
    assert.equal(videoPaused({ transfer: { paused: false } }), false);
    assert.equal(videoPaused({ transfer: { paused: true } }), true);
  });

  it('treats a missing transfer field as paused', () => {
    assert.equal(videoPaused({}), true);
    assert.equal(videoPaused({ transfer: {} }), true);
  });
});
