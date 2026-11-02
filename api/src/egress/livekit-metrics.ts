// Checked against livekit-server 1.13.11: bytes the node has sent, as a
// counter. It carries country, node and transmission labels besides
// direction, so every outgoing series is added up. The series only appears
// once the first packet moves.
export const OUTGOING_BYTES_METRIC = 'livekit_packet_bytes';
export const METRICS_PORT = 6789;

const SERIES = new RegExp(`^${OUTGOING_BYTES_METRIC}[{]([^}]*)[}]\\s+(\\S+)`, 'gm');

export function outgoingBytes(text: string): number {
  let total = 0;
  for (const [, labels, value] of text.matchAll(SERIES)) {
    if (labels.includes('direction="outgoing"')) total += Number(value);
  }
  return total;
}

export type ByteSample = { bytes: number; t: number };

// Null rather than 0 when there is nothing honest to report: a first sample
// has no baseline, and a counter that went down means LiveKit restarted.
export function bitsPerSecond(prev: ByteSample | null, now: ByteSample): number | null {
  if (!prev || now.t <= prev.t || now.bytes < prev.bytes) return null;
  return Math.round(((now.bytes - prev.bytes) * 8) / ((now.t - prev.t) / 1000));
}

export async function fetchOutgoingBytes(host: string): Promise<number | null> {
  try {
    const res = await fetch(`http://${host}:${METRICS_PORT}/metrics`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? outgoingBytes(await res.text()) : null;
  } catch {
    // The sampler runs every 10 s; a LiveKit that is down just means a gap.
    return null;
  }
}
