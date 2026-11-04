import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bitsPerSecond, bytesSent, outgoingBytes } from './livekit-metrics';

// Captured from livekit-server 1.13.11 with one publisher and one subscriber.
const captured = readFileSync(join(__dirname, 'fixtures', 'livekit-metrics.txt'), 'utf8');

describe('outgoingBytes', () => {
  it('reads the outgoing counter and not the incoming one or the packet count', () => {
    expect(outgoingBytes(captured)).toBe(210660);
  });

  it('adds up every outgoing series, whatever the other labels are', () => {
    const text = [
      'livekit_packet_bytes{country="",direction="outgoing",node_type="SERVER",transmission="initial"} 1000',
      'livekit_packet_bytes{country="",direction="outgoing",node_type="SERVER",transmission="udp"} 2.5e+06',
      'livekit_packet_bytes{country="",direction="incoming",node_type="SERVER",transmission="udp"} 99999',
    ].join('\n');
    expect(outgoingBytes(text)).toBe(2501000);
  });

  it('is null when the metric is not there at all, so a renamed one shows as a gap', () => {
    expect(outgoingBytes('livekit_participant_total 0\nlivekit_node_packet_total 3\n')).toBeNull();
    expect(outgoingBytes('')).toBeNull();
  });

  it('is zero when the counter is declared but nothing has moved', () => {
    expect(outgoingBytes('# TYPE livekit_packet_bytes counter\nlivekit_participant_total 0\n')).toBe(0);
  });
});

describe('bitsPerSecond', () => {
  const at = (bytes: number, t: number) => ({ bytes, t });

  it('is the counter delta times eight over the elapsed seconds', () => {
    expect(bitsPerSecond(at(210660, 0), at(270660, 10000))).toBe(48000);
  });

  it('has no value for the first sample', () => {
    expect(bitsPerSecond(null, at(5, 0))).toBeNull();
  });

  it('has no value after a counter reset, never a negative one', () => {
    expect(bitsPerSecond(at(900000, 0), at(1200, 10000))).toBeNull();
  });

  it('has no value when time did not move forward', () => {
    expect(bitsPerSecond(at(1, 5000), at(9, 5000))).toBeNull();
    expect(bitsPerSecond(at(1, 5000), at(9, 4000))).toBeNull();
  });
});

describe('bytesSent', () => {
  it('is the counter delta between two samples', () => {
    expect(bytesSent({ bytes: 100, t: 1000 }, { bytes: 1100, t: 11000 })).toBe(1000);
  });

  it('has no value for the first sample', () => {
    expect(bytesSent(null, { bytes: 5, t: 0 })).toBeNull();
  });

  it('has no value after a counter reset, never a negative one', () => {
    expect(bytesSent({ bytes: 100, t: 1 }, { bytes: 50, t: 2 })).toBeNull();
  });

  it('has no value when time did not move forward', () => {
    expect(bytesSent({ bytes: 1, t: 5000 }, { bytes: 9, t: 5000 })).toBeNull();
  });
});
