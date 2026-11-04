import { RoomKind } from '@prisma/client';

// Well above what a phone receives from either kind of room. A bigger number
// is a client bug or a forged report; clamped, one report can only move a
// room's total so far.
export const MAX_REPORT_BPS: Record<RoomKind, number> = { VIDEO: 3e6, AUDIO: 3e5 };

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// What one viewer costs right now, or null when nobody is receiving. The
// median and not the mean: a forged report among honest ones moves a mean by
// its whole size and a median hardly at all. The node's byte counter covers
// both kinds at once and cannot be split between them, so it is not used
// here; it counts against the monthly budget instead.
export function liveRate(rates: number[]): number | null {
  return rates.length === 0 ? null : Math.round(median(rates));
}
