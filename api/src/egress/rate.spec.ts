import { liveRate, median } from './rate';

describe('median', () => {
  it('takes the middle value, or the mean of the middle two', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it('is not moved by one outlier', () => {
    expect(median([1.2e6, 1.3e6, 3e6])).toBe(1.3e6);
    expect(median([48_000, 48_000, 48_000, 3e5])).toBe(48_000);
  });
});

describe('liveRate', () => {
  it('is null with nobody receiving, whatever was measured', () => {
    expect(liveRate([], null)).toBeNull();
    expect(liveRate([], 96_000)).toBeNull();
  });

  it('takes the median of the reports when nothing was measured', () => {
    expect(liveRate([40_000, 48_000, 3e5], null)).toBe(48_000);
  });

  it('divides a measured rate over the receiving viewers, ignoring what they report', () => {
    expect(liveRate([20_000, 3e5], 96_000)).toBe(48_000);
  });
});
