import { Engine } from '@prisma/client';

// Well above what a phone receives from either engine. A bigger number is a
// client bug or a forged report; clamped, one report can only move a room's
// total so far.
export const MAX_REPORT_BPS: Record<Engine, number> = { agora: 3e6, livekit: 3e5 };

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// What one viewer costs right now, or null when nobody is receiving. The
// median and not the mean: a forged report among honest ones moves a mean by
// its whole size and a median hardly at all. A byte count read from the
// server itself beats any report, so for LiveKit a fresh reading is divided
// over the viewers receiving audio instead.
export function liveRate(rates: number[], measuredBps: number | null): number | null {
  if (rates.length === 0) return null;
  if (measuredBps !== null) return Math.round(measuredBps / rates.length);
  return Math.round(median(rates));
}
