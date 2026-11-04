import { liveRate, MAX_REPORT_BPS, median } from './rate';

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
  it('is null with nobody receiving', () => {
    expect(liveRate([])).toBeNull();
  });

  it('takes the median of the reports, so one forged report does not move it', () => {
    expect(liveRate([1, 2, 100])).toBe(2);
    expect(liveRate([40_000, 48_000, 3e5])).toBe(48_000);
  });
});

describe('MAX_REPORT_BPS', () => {
  it('allows 3 Mbps for video and 300 kbps for audio', () => {
    expect(MAX_REPORT_BPS.VIDEO).toBe(3e6);
    expect(MAX_REPORT_BPS.AUDIO).toBe(3e5);
  });
});
