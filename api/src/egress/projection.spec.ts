import { budgetBps, project } from './projection';

describe('projection', () => {
  it('turns TB per month into bits per second, floored', () => {
    expect(budgetBps(20)).toBe(61728395);
  });

  it('names the viewer count where each kind crosses the budget', () => {
    const budget = budgetBps(1);
    const { lines, crossing } = project({ video: 1.5e6, audio: 48e3 }, budget);
    expect(lines.map((l) => l.kind)).toEqual(['video', 'audio']);
    expect(crossing.video).toBe(Math.floor(budget / 1.5e6));
    expect(crossing.audio).toBe(Math.floor(budget / 48e3));
  });

  it('draws each line from zero viewers to the cap at its own per-viewer rate', () => {
    const { lines } = project({ audio: 48e3 }, budgetBps(20), 1000);
    expect(lines).toEqual([
      { kind: 'audio', points: [[0, 0], [1000, 48e6]] },
    ]);
  });

  it('leaves out a kind nobody has reported for, rather than crossing at infinity', () => {
    const out = project({ video: 1.4e6 }, budgetBps(20));
    expect(out.crossing).toEqual({ video: 44 });
    expect(out.lines.map((l) => l.kind)).toEqual(['video']);
    expect(project({ video: 0 }, budgetBps(20))).toEqual({ lines: [], crossing: {} });
  });
});
