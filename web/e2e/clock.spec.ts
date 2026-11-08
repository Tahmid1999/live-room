import { expect, test } from '@playwright/test';
import { clockOffset, pictureAge, StampFilter } from '../lib/clock';

test('the offset uses the midpoint of the request', () => {
  // Sent at 1000, answered at 1200: the server read its clock at about 1100.
  expect(clockOffset(1000, 1200, 5100)).toBe(4000);
  expect(clockOffset(1000, 1200, 1100)).toBe(0);
});

test('a phone clock three minutes fast still gets the true age', () => {
  const fast = 3 * 60_000;
  const serverNow = 1_000_000;
  const offset = clockOffset(serverNow + fast, serverNow + fast + 100, serverNow + 50);
  expect(offset).toBeCloseTo(-fast, 5);
  const stamp = serverNow + 2000;
  const phoneNow = serverNow + 2000 + 1500 + fast;
  expect(pictureAge(stamp, phoneNow, offset)).toBeCloseTo(1500, 5);
});

test('an age below 0 or above 60 s is not shown', () => {
  expect(pictureAge(1000, 999, 0)).toBeNull();
  expect(pictureAge(1000, 61_001, 0)).toBeNull();
  expect(pictureAge(1000, 61_000, 0)).toBe(60_000);
  expect(pictureAge(1000, 1000, 0)).toBe(0);
});

test('a time that jumps more than 5 s is ignored until a second one agrees', () => {
  const f = new StampFilter();
  expect(f.accept({ ms: 100_000, tap: null }, 0)?.ms).toBe(100_000);
  expect(f.accept({ ms: 101_000, tap: null }, 1000)?.ms).toBe(101_000);
  expect(f.accept({ ms: 900_000, tap: null }, 2000)).toBeNull();
  // The next sample is back on track: the jump was a misread.
  expect(f.accept({ ms: 103_000, tap: null }, 3000)?.ms).toBe(103_000);
  // Two in a row that agree with each other: the house moved.
  expect(f.accept({ ms: 900_000, tap: null }, 4000)).toBeNull();
  expect(f.accept({ ms: 901_000, tap: null }, 5000)?.ms).toBe(901_000);
});

test('a tap code needs two samples in a row before it counts', () => {
  const f = new StampFilter();
  expect(f.accept({ ms: 1000, tap: 'ab12' }, 10)?.tap).toBeNull();
  const second = f.accept({ ms: 2000, tap: 'ab12' }, 1010);
  expect(second?.tap).toEqual({ code: 'ab12', firstSeenAt: 10 });
  // Still on screen: same first sighting, not a new one.
  expect(f.accept({ ms: 3000, tap: 'ab12' }, 2010)?.tap?.firstSeenAt).toBe(10);
  // A different code starts over, and so does a gap.
  expect(f.accept({ ms: 4000, tap: 'cd34' }, 3010)?.tap).toBeNull();
  expect(f.accept({ ms: 5000, tap: null }, 4010)?.tap).toBeNull();
  expect(f.accept({ ms: 6000, tap: 'cd34' }, 5010)?.tap).toBeNull();
});
