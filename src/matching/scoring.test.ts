import { describe, expect, it } from 'vitest';
import { matchEvents } from './matcher';
import { scorePass } from './scoring';
import { detectedNotes, expectedNotes } from './test-helpers';
import type { MatchResult } from './types';

describe('scorePass', () => {
  it('counts verdicts and computes percentages', () => {
    const exp = expectedNotes([
      [0, 40],
      [500, 45],
      [1000, 50],
      [1500, 55],
      [2000, 59],
    ]);
    const det = detectedNotes([
      [10, 40], // hit +10
      [520, 45], // hit +20
      [1200, 50], // late +200
      [1500, 60], // wrong
      // 59 missed
    ]);
    const s = scorePass(matchEvents(exp, det));
    expect(s.total).toBe(5);
    expect(s.counts).toMatchObject({ hit: 2, late: 1, early: 0, wrong: 1, missed: 1 });
    expect(s.percentHit).toBe(40);
    expect(s.percentRightPitch).toBe(60);
    expect(s.medianTimingErrorMs).toBe(20);
  });

  it('excludes pending events from the total', () => {
    const exp = expectedNotes([
      [0, 40],
      [5000, 45],
    ]);
    const s = scorePass(matchEvents(exp, detectedNotes([[0, 40]]), undefined, 1000));
    expect(s.total).toBe(1);
    expect(s.counts.pending).toBe(1);
    expect(s.percentHit).toBe(100);
  });

  it('handles an empty pass', () => {
    const empty: MatchResult = { results: [], extraDetectionIds: [] };
    const s = scorePass(empty);
    expect(s.total).toBe(0);
    expect(s.percentHit).toBe(0);
    expect(s.medianTimingErrorMs).toBeNull();
  });

  it('uses the mean of the two middle values for an even count', () => {
    const exp = expectedNotes([
      [0, 40],
      [1000, 40],
    ]);
    const det = detectedNotes([
      [10, 40],
      [1030, 40],
    ]);
    expect(scorePass(matchEvents(exp, det)).medianTimingErrorMs).toBe(20);
  });
});
