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
