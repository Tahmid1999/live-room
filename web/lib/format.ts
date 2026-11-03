import type { Bandwidth } from './api';

export function rate(bps: number): string {
  return bps < 1e5 ? `${Math.round(bps / 1000)} kbps` : `${(bps / 1e6).toFixed(1)} Mbps`;
}

// Every number comes from /bandwidth; nothing here computes a rate of its own.
export function engineLine(engine: 'agora' | 'livekit', bw: Bandwidth | null): string {
  const per = bw?.projection.perViewer[engine];
  const last = bw?.series.at(-1);
  const perText = !per
    ? '— per viewer'
    : per.source === 'last'
      ? `last measured ${rate(per.bps)} per viewer`
      : `${rate(per.bps)} per viewer`;

  if (engine === 'agora') {
    const now = last ? rate(last.wouldBeVideoBps) : '—';
    return `video · Agora · ${perText} · would cost my server ${now} right now`;
  }
  const now = last?.livekitBps == null ? '—' : rate(last.livekitBps);
  return `audio · my LiveKit server · ${perText} · ${now} out right now`;
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
