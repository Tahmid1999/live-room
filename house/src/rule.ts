export const EMPTY_STOP_MS = 60_000;

export type HouseState = {
  running: boolean;
  viewers: number;
  // When the room was first seen empty while running; the caller clears it as
  // soon as a viewer is back, so the 60 s always counts an unbroken stretch.
  emptySince: number | null;
  paused: boolean;
  now: number;
};

// Chromium encoding costs the worker's CPU and the upload costs the node's
// ingress, so the video host only runs while somebody watches, and never while
// the transfer budget is paused.
export function decide(s: HouseState): 'start' | 'stop' | 'keep' {
  if (!s.running) return s.viewers > 0 && !s.paused ? 'start' : 'keep';
  if (s.paused) return 'stop';
  const emptyFor = s.viewers === 0 && s.emptySince !== null ? s.now - s.emptySince : 0;
  return emptyFor >= EMPTY_STOP_MS ? 'stop' : 'keep';
}
