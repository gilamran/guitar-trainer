import type { DetectedEvent, ExpectedEvent } from './types';

/** Expected single notes from `[timeMs, midi]` pairs; ids are `e0`, `e1`, … */
export function expectedNotes(spec: ReadonlyArray<readonly [number, number]>): ExpectedEvent[] {
  return spec.map(([timeMs, midi], i) => ({ id: `e${i}`, timeMs, pitches: [midi] }));
}

/** Detected mono onsets from `[timeMs, midi]` pairs; ids are 0, 1, … */
export function detectedNotes(spec: ReadonlyArray<readonly [number, number]>): DetectedEvent[] {
  return spec.map(([timeMs, midi], i) => ({ id: i, timeMs, pitches: [midi], confidence: 1 }));
}

/** Small deterministic PRNG (mulberry32) so randomized tests are reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
