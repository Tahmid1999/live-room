import type { Bandwidth } from './api';

export function rate(bps: number): string {
  return bps < 1e5 ? `${Math.round(bps / 1000)} kbps` : `${(bps / 1e6).toFixed(1)} Mbps`;
}

// Every number comes from /bandwidth; nothing here computes a rate of its own.
export function kindLine(kind: 'VIDEO' | 'AUDIO', bw: Bandwidth | null, roomBps: number | null): string {
  const name = kind === 'VIDEO' ? 'video' : 'audio';
  const per = bw?.projection.perViewer[name];
  const perText = !per
    ? '— per viewer'
    : per.source === 'last'
      ? `last measured ${rate(per.bps)} per viewer`
      : `${rate(per.bps)} per viewer`;
  const now = roomBps == null ? '—' : rate(roomBps);
  return `${name} · self-hosted LiveKit · ${perText} · this room costs my server ${now} right now`;
}

// TB from a terabyte up, GB below it, so a month's first gigabytes and the
// budget read on the same scale.
export function bytes(n: number): string {
  const [value, unit] = n >= 1e12 ? [n / 1e12, 'TB'] : [n / 1e9, 'GB'];
  return `${+value.toFixed(1)} ${unit}`;
}

export const count = (n: number) => n.toLocaleString('en-US');

export function age(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 90) return `${sec} s`;
  if (sec < 90 * 60) return `${Math.round(sec / 60)} min`;
  return `${Math.round(sec / 3600)} h`;
}

export const clock = (t: number) =>
  new Date(t).toLocaleTimeString('en-GB', { hour12: false });

// Axis labels only; the values are the server's.
export function axisRate(bps: number): string {
  if (bps >= 1e9) return `${+(bps / 1e9).toFixed(1)} Gbps`;
  if (bps >= 1e6) return `${Math.round(bps / 1e6)} Mbps`;
  return `${Math.round(bps / 1000)} kbps`;
}
