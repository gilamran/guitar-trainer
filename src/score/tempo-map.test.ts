import { describe, expect, it } from 'vitest';
import { PPQ, TempoMap } from './tempo-map';

describe('TempoMap', () => {
  it('converts at a constant tempo', () => {
    const map = new TempoMap([{ tick: 0, bpm: 120 }]);
    expect(map.tickToMs(PPQ)).toBe(500); // one quarter at 120 bpm
    expect(map.tickToMs(4 * PPQ)).toBe(2000);
    expect(map.msToTick(750)).toBe(1.5 * PPQ);
  });

  it('integrates across tempo changes', () => {
    const map = new TempoMap([
      { tick: 0, bpm: 120 },
      { tick: 4 * PPQ, bpm: 60 },
    ]);
    expect(map.tickToMs(4 * PPQ)).toBe(2000);
    expect(map.tickToMs(5 * PPQ)).toBe(3000);
    expect(map.msToTick(3000)).toBe(5 * PPQ);
    expect(map.bpmAt(4 * PPQ - 1)).toBe(120);
    expect(map.bpmAt(4 * PPQ)).toBe(60);
  });

  it('round-trips', () => {
    const map = new TempoMap([
      { tick: 0, bpm: 100 },
      { tick: 1000, bpm: 150 },
      { tick: 5000, bpm: 72 },
    ]);
    for (const t of [0, 500, 1000, 3333, 5000, 9000]) expect(map.msToTick(map.tickToMs(t))).toBeCloseTo(t);
  });

  it('tolerates unsorted, duplicate and missing-start changes', () => {
    const map = new TempoMap([
      { tick: 960, bpm: 60 },
      { tick: 960, bpm: 90 },
    ]);
    // before the first change the first tempo applies; later duplicate wins
    expect(map.tickToMs(960)).toBe(1000);
    expect(map.bpmAt(960)).toBe(90);
    expect(new TempoMap([]).tickToMs(960)).toBe(500);
  });
});
