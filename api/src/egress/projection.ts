export type PerViewerBps = { video?: number; audio?: number };

// 30-day month, so the budget is the same whichever month it is asked in.
export function budgetBps(tbPerMonth: number): number {
  return Math.floor((tbPerMonth * 1e12 * 8) / (30 * 86400));
}

// Egress is linear in viewers, so each line needs only its two ends; the chart
// does not need a point per viewer to draw a straight line.
export function project(perViewer: PerViewerBps, budget: number, maxViewers = 5000) {
  const lines: { kind: 'video' | 'audio'; points: [number, number][] }[] = [];
  const crossing: PerViewerBps = {};
  for (const kind of ['video', 'audio'] as const) {
    const bps = perViewer[kind];
    // No report yet (or a silent one): a crossing would divide by zero.
    if (!bps || bps <= 0) continue;
    lines.push({ kind, points: [[0, 0], [maxViewers, maxViewers * bps]] });
    crossing[kind] = Math.floor(budget / bps);
  }
  return { lines, crossing };
}
