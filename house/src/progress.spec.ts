import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SendProgress, STALL_MS } from './progress';

const start = 1_000_000;

describe('SendProgress', () => {
  it('is moving while the byte count grows', () => {
    const p = new SendProgress(start);
    assert.equal(p.moving(5_000, start + 2_000), true);
    assert.equal(p.moving(9_000, start + 2_000 + STALL_MS - 1), true);
  });

  it('is stalled after ten seconds without a new byte', () => {
    const p = new SendProgress(start);
    assert.equal(p.moving(5_000, start + 2_000), true);
    assert.equal(p.moving(5_000, start + 2_000 + STALL_MS), false);
  });

  it('is stalled when nothing was ever sent', () => {
    const p = new SendProgress(start);
    assert.equal(p.moving(0, start + STALL_MS), false);
  });

  it('takes a drop, as when a closed connection leaves the sum, as a new baseline', () => {
    const p = new SendProgress(start);
    assert.equal(p.moving(2_000_000, start + 2_000), true);
    // The old connection is gone; the new one has sent far less so far.
    assert.equal(p.moving(40_000, start + 9_000), true);
    assert.equal(p.moving(80_000, start + 18_000), true);
    assert.equal(p.moving(80_000, start + 18_000 + STALL_MS), false);
  });
});
