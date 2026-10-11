import { describe, expect, it } from 'vitest';
import { matchEvents } from './matcher';
import { detectedNotes, expectedNotes, seededRandom } from './test-helpers';
import { DEFAULT_MATCH_OPTIONS, type ExpectedEvent, type MatchOptions } from './types';

const opts: MatchOptions = DEFAULT_MATCH_OPTIONS; // ±120 ms, outer 300 ms, ±50 cents

const verdicts = (r: ReturnType<typeof matchEvents>) => r.results.map((x) => x.verdict);

// E2 A2 D3 G3 B3 E4 – open strings, handy distinct pitches.
const E2 = 40;
const A2 = 45;
const D3 = 50;
const G3 = 55;
const B3 = 59;

describe('matchEvents – basics', () => {
  it('marks a perfect performance as all hits', () => {
    const exp = expectedNotes([
      [0, E2],
      [500, A2],
      [1000, D3],
      [1500, G3],
    ]);
    const det = detectedNotes([
      [0, E2],
      [500, A2],
      [1000, D3],
      [1500, G3],
    ]);
    const r = matchEvents(exp, det, opts);
    expect(verdicts(r)).toEqual(['hit', 'hit', 'hit', 'hit']);
    expect(r.extraDetectionIds).toEqual([]);
    expect(r.results.map((x) => x.detectedId)).toEqual([0, 1, 2, 3]);
  });

  it('marks everything missed when nothing is played', () => {
    const exp = expectedNotes([
      [0, E2],
      [500, A2],
    ]);
    expect(verdicts(matchEvents(exp, [], opts))).toEqual(['missed', 'missed']);
  });

  it('handles empty expected input', () => {
    const r = matchEvents([], detectedNotes([[0, E2]]), opts);
    expect(r.results).toEqual([]);
    expect(r.extraDetectionIds).toEqual([0]);
  });

  it('classifies timing against the window: hit / early / late / missed', () => {
    const exp = expectedNotes([
      [0, E2],
      [1000, A2],
      [2000, D3],
      [3000, G3],
      [4000, B3],
    ]);
    const det = detectedNotes([
      [119, E2], // just inside +120
      [1000 - 120, A2], // boundary counts as on time
      [2000 + 180, D3], // late, inside outer window
      [3000 - 250, G3], // early, inside outer window
      [4000 + 450, B3], // beyond outer window → missed + extra
    ]);
    const r = matchEvents(exp, det, opts);
    expect(verdicts(r)).toEqual(['hit', 'hit', 'late', 'early', 'missed']);
    expect(r.results[2].timingErrorMs).toBe(180);
    expect(r.results[3].timingErrorMs).toBe(-250);
    expect(r.extraDetectionIds).toEqual([4]);
  });

  it('respects a custom timing window', () => {
    const exp = expectedNotes([[0, E2]]);
    const det = detectedNotes([[80, E2]]);
    expect(verdicts(matchEvents(exp, det, { ...opts, timingWindowMs: 50 }))).toEqual(['late']);
    expect(verdicts(matchEvents(exp, det, { ...opts, timingWindowMs: 100 }))).toEqual(['hit']);
  });
});

describe('matchEvents – pitch', () => {
  it('accepts pitch within tolerance and rejects beyond it', () => {
    const exp = expectedNotes([
      [0, A2],
      [1000, A2],
      [2000, A2],
    ]);
    const det = detectedNotes([
      [0, A2 + 0.4], // +40 cents
      [1000, A2 - 0.49], // -49 cents
      [2000, A2 + 0.6], // +60 cents → wrong
    ]);
    const r = matchEvents(exp, det, opts);
    expect(verdicts(r)).toEqual(['hit', 'hit', 'wrong']);
    expect(r.results[0].centsError).toBeCloseTo(40);
    expect(r.results[1].centsError).toBeCloseTo(-49);
  });

  it('treats an octave error on a single note as wrong', () => {
    const r = matchEvents(expectedNotes([[0, A2]]), detectedNotes([[0, A2 + 12]]), opts);
    expect(verdicts(r)).toEqual(['wrong']);
  });

  it('only reports wrong-pitch onsets inside the tight timing window', () => {
    const exp = expectedNotes([
      [0, E2],
      [1000, A2],
    ]);
    const det = detectedNotes([
      [50, G3], // wrong pitch, on time → wrong
      [1200, G3], // wrong pitch, late → not associated → missed
    ]);
    const r = matchEvents(exp, det, opts);
    expect(verdicts(r)).toEqual(['wrong', 'missed']);
    expect(r.extraDetectionIds).toEqual([1]);
  });

  it('prefers a right-pitch late onset over a wrong-pitch on-time onset', () => {
    const exp = expectedNotes([[0, E2]]);
    const det = detectedNotes([
      [10, G3],
      [200, E2],
    ]);
    const r = matchEvents(exp, det, opts);
    expect(verdicts(r)).toEqual(['late']);
    expect(r.results[0].detectedId).toBe(1);
  });

  it('treats an onset without a clear pitch as wrong for single notes', () => {
    const exp = expectedNotes([[0, E2]]);
    const r = matchEvents(exp, [{ id: 0, timeMs: 5, pitches: [], confidence: 0.2 }], opts);
    expect(verdicts(r)).toEqual(['wrong']);
  });
});

describe('matchEvents – chords', () => {
  // E5 power chord with octave: E2 B2 E3
  const chord: ExpectedEvent[] = [{ id: 'c', timeMs: 0, pitches: [40, 47, 52] }];
  const at = (pitches: number[]) => [{ id: 0, timeMs: 10, pitches, confidence: 1 }];

  it('any-tone: accepts any chord tone in any octave', () => {
    const o = { ...opts, chordPolicy: 'any-tone' as const };
    expect(verdicts(matchEvents(chord, at([59]), o))).toEqual(['hit']); // B3
    expect(verdicts(matchEvents(chord, at([28]), o))).toEqual(['hit']); // E1 (octave below)
    expect(verdicts(matchEvents(chord, at([45]), o))).toEqual(['wrong']); // A2
  });

  it('root: requires the pitch class of the lowest note', () => {
    const o = { ...opts, chordPolicy: 'root' as const };
    expect(verdicts(matchEvents(chord, at([52]), o))).toEqual(['hit']); // E3
    expect(verdicts(matchEvents(chord, at([47]), o))).toEqual(['wrong']); // B2
    // polyphonic detection: root present among several pitches
    expect(verdicts(matchEvents(chord, at([47, 40, 52]), o))).toEqual(['hit']);
  });

  it('timing-only: accepts any onset, even without pitch', () => {
    const o = { ...opts, chordPolicy: 'timing-only' as const };
    expect(verdicts(matchEvents(chord, at([]), o))).toEqual(['hit']);
    expect(verdicts(matchEvents(chord, at([61]), o))).toEqual(['hit']);
  });

  it('ignores the extra onsets of a slow strum', () => {
    const det = [0, 15, 30, 45].map((t, i) => ({
      id: i,
      timeMs: t,
      pitches: [40 + i * 5],
      confidence: 1,
    }));
    const r = matchEvents(chord, det, opts);
    expect(verdicts(r)).toEqual(['hit']);
    expect(r.extraDetectionIds).toHaveLength(3);
  });
});

describe('matchEvents – alignment', () => {
  it('ignores noise between notes and reports it as extra', () => {
    const exp = expectedNotes([
      [0, E2],
      [1000, A2],
    ]);
    const det = detectedNotes([
      [0, E2],
      [480, 70],
      [520, 30],
      [1010, A2],
    ]);
    const r = matchEvents(exp, det, opts);
    expect(verdicts(r)).toEqual(['hit', 'hit']);
    expect(r.extraDetectionIds).toEqual([1, 2]);
  });

  it('picks the closer of two double-triggered onsets', () => {
    const exp = expectedNotes([[0, E2]]);
    const det = detectedNotes([
      [-60, E2],
      [20, E2],
    ]);
    const r = matchEvents(exp, det, opts);
    expect(r.results[0]).toMatchObject({ verdict: 'hit', detectedId: 1, timingErrorMs: 20 });
  });

  it('finds a globally consistent pairing where nearest-first would not', () => {
    // Nearest-first would give e0 → +100 and leave e1 only the onset at -110
    // (230 ms early). The optimal pairing makes both notes hits.
    const exp = expectedNotes([
      [0, A2],
      [120, A2],
    ]);
    const det = detectedNotes([
      [-110, A2],
      [100, A2],
    ]);
    const r = matchEvents(exp, det, opts);
    expect(verdicts(r)).toEqual(['hit', 'hit']);
    expect(r.results.map((x) => x.detectedId)).toEqual([0, 1]);
  });

  it('never produces crossing pairs', () => {
    // Swapped notes: pairing both as hits would require crossing.
    const exp = expectedNotes([
      [0, A2],
      [100, D3],
    ]);
    const det = detectedNotes([
      [0, D3],
      [100, A2],
    ]);
    const r = matchEvents(exp, det, opts);
    expect(verdicts(r).filter((v) => v === 'hit')).toHaveLength(1);
    const pairs = r.results
      .map((x, i) => [i, x.detectedId] as const)
      .filter(([, d]) => d !== undefined) as [number, number][];
    for (let k = 1; k < pairs.length; k++) expect(pairs[k][1]).toBeGreaterThan(pairs[k - 1][1]);
  });

  it('uses each detection at most once', () => {
    const exp = expectedNotes([
      [0, A2],
      [100, A2],
      [200, A2],
    ]);
    const det = detectedNotes([[100, A2]]);
    const r = matchEvents(exp, det, opts);
    expect(r.results.filter((x) => x.detectedId !== undefined)).toHaveLength(1);
    expect(r.results[1]).toMatchObject({ verdict: 'hit', detectedId: 0 });
  });

  it('returns results in input order for unsorted input', () => {
    const exp: ExpectedEvent[] = [
      { id: 'b', timeMs: 1000, pitches: [A2] },
      { id: 'a', timeMs: 0, pitches: [E2] },
    ];
    const det = detectedNotes([
      [1005, A2],
      [-5, E2],
    ]);
    const r = matchEvents(exp, det, opts);
    expect(r.results.map((x) => [x.expectedId, x.verdict, x.detectedId])).toEqual([
      ['b', 'hit', 0],
      ['a', 'hit', 1],
    ]);
  });

  it('all hits for a fast random line played with human jitter', () => {
    const rand = seededRandom(42);
    const spacing = 125; // 16ths at 120 bpm
    const spec: [number, number][] = [];
    for (let i = 0; i < 400; i++) spec.push([i * spacing, 40 + Math.floor(rand() * 24)]);
    const exp = expectedNotes(spec);
    const det = detectedNotes(
      spec.map(([t, m]) => [t + (rand() * 2 - 1) * 60, m + (rand() * 2 - 1) * 0.3] as const),
    );
    const r = matchEvents(exp, det, opts);
    expect(verdicts(r).every((v) => v === 'hit')).toBe(true);
    expect(r.extraDetectionIds).toEqual([]);
  });

  it('keeps a consistently late player late instead of shifting by a note', () => {
    // Different pitches make the intended pairing unambiguous.
    const pitches = [E2, A2, D3, G3, B3, E2, A2, D3];
    const exp = expectedNotes(pitches.map((p, i) => [i * 250, p] as const));
    const det = detectedNotes(pitches.map((p, i) => [i * 250 + 160, p] as const));
    const r = matchEvents(exp, det, opts);
    expect(verdicts(r).every((v) => v === 'late')).toBe(true);
  });

  it('scales to long passages', () => {
    const rand = seededRandom(7);
    const spec: [number, number][] = [];
    for (let i = 0; i < 3000; i++) spec.push([i * 100, 40 + Math.floor(rand() * 30)]);
    const det = detectedNotes([
      ...spec.map(([t, m]) => [t + (rand() - 0.5) * 80, m] as const),
      ...spec.map(([t]) => [t + 50, 90] as const), // lots of noise
    ]);
    const start = performance.now();
    const r = matchEvents(expectedNotes(spec), det, opts);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(verdicts(r).filter((v) => v === 'hit').length).toBe(3000);
  });
});

describe('matchEvents – live mode', () => {
  it('reports unmatched events as pending until their window closes', () => {
    const exp = expectedNotes([
      [0, E2],
      [1000, A2],
      [2000, D3],
    ]);
    const det = detectedNotes([[1010, A2]]);
    const r = matchEvents(exp, det, opts, 1100);
    // e0 window closed (0 + 300 < 1100) → missed; e1 matched; e2 still open.
    expect(verdicts(r)).toEqual(['missed', 'hit', 'pending']);
  });

  it('a late note can still be matched while its window is open', () => {
    const exp = expectedNotes([[1000, A2]]);
    expect(verdicts(matchEvents(exp, [], opts, 1250))).toEqual(['pending']);
    expect(verdicts(matchEvents(exp, detectedNotes([[1240, A2]]), opts, 1250))).toEqual(['late']);
    expect(verdicts(matchEvents(exp, [], opts, 1301))).toEqual(['missed']);
  });
});
