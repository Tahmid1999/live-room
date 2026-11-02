import { budgetBps, project } from './projection';

describe('projection', () => {
  it('turns TB per month into bits per second, floored', () => {
    expect(budgetBps(20)).toBe(61728395);
  });

  it('names the viewer count where each engine crosses the budget', () => {
    const { crossing } = project({ agora: 1.4e6, livekit: 48e3 }, budgetBps(20));
    expect(crossing).toEqual({ agora: 44, livekit: 1286 });
  });

  it('draws each line from zero viewers to the cap at its own per-viewer rate', () => {
    const { lines } = project({ livekit: 48e3 }, budgetBps(20), 1000);
    expect(lines).toEqual([
      { engine: 'livekit', points: [[0, 0], [1000, 48e6]] },
    ]);
  });

  it('leaves out an engine nobody has reported for, rather than crossing at infinity', () => {
    const out = project({ agora: 1.4e6 }, budgetBps(20));
    expect(out.crossing).toEqual({ agora: 44 });
    expect(out.lines.map((l) => l.engine)).toEqual(['agora']);
    expect(project({ agora: 0 }, budgetBps(20)).lines).toEqual([]);
  });
});
