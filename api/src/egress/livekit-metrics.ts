// Checked against livekit-server 1.13.11: bytes the node has sent, as a
// counter. It carries country, node and transmission labels besides
// direction, so every outgoing series is added up. The series only appears
// once the first packet moves.
export const OUTGOING_BYTES_METRIC = 'livekit_packet_bytes';

const SERIES = new RegExp(`^${OUTGOING_BYTES_METRIC}[{]([^}]*)[}]\\s+(\\S+)`, 'gm');

// Null when the metric is not in the text at all (no sample and no TYPE line):
// that is what a renamed metric or a different server looks like, and a
// measured 0 there would be a lie. A TYPE line without samples is a real
// counter that nothing has incremented, which is 0.
export function outgoingBytes(text: string): number | null {
  let total = 0;
  let seen = false;
  for (const [, labels, value] of text.matchAll(SERIES)) {
    seen = true;
    if (labels.includes('direction="outgoing"')) total += Number(value);
  }
  if (!seen && !text.includes(`# TYPE ${OUTGOING_BYTES_METRIC} `)) return null;
  return total;
}

export type ByteSample = { bytes: number; t: number };

// Null rather than 0 when there is nothing honest to report: a first sample
// has no baseline, and a counter that went down means LiveKit restarted.
export function bitsPerSecond(prev: ByteSample | null, now: ByteSample): number | null {
  if (!prev || now.t <= prev.t || now.bytes < prev.bytes) return null;
  return Math.round(((now.bytes - prev.bytes) * 8) / ((now.t - prev.t) / 1000));
}

export async function fetchOutgoingBytes(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? outgoingBytes(await res.text()) : null;
  } catch {
    // The sampler runs every 10 s; a LiveKit that is down just means a gap.
    return null;
  }
}
