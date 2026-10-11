import type { ChordPolicy } from './types';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function frequencyToMidi(hz: number, a4Hz = 440): number {
  return 69 + 12 * Math.log2(hz / a4Hz);
}

export function midiToFrequency(midi: number, a4Hz = 440): number {
  return a4Hz * 2 ** ((midi - 69) / 12);
}

/** "E2", "A#3" … for the nearest semitone. */
export function midiToName(midi: number): string {
  const m = Math.round(midi);
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

/** Signed distance in cents from `target` to `actual`, ignoring octaves: [-600, 600). */
export function pitchClassCents(target: number, actual: number): number {
  const cents = (actual - target) * 100;
  return ((((cents + 600) % 1200) + 1200) % 1200) - 600;
}

function nearest(errors: Iterable<number>): number | null {
  let best: number | null = null;
  for (const e of errors) {
    if (best === null || Math.abs(e) < Math.abs(best)) best = e;
  }
  return best;
}

/**
 * Signed pitch error (cents) of the best-fitting detected pitch for an
 * expected event, or `null` when nothing was detected.
 *
 * Single notes are compared exactly (octave matters). Chords follow `policy`
 * and compare pitch classes, because a monophonic detector listening to a
 * chord often locks onto a different octave or chord tone.
 */
export function pitchErrorCents(
  expected: readonly number[],
  detected: readonly number[],
  policy: ChordPolicy,
): number | null {
  if (expected.length > 1 && policy === 'timing-only') return 0;
  if (detected.length === 0 || expected.length === 0) return null;

  if (expected.length === 1) {
    const target = expected[0];
    return nearest(detected.map((d) => (d - target) * 100));
  }

  switch (policy) {
    case 'timing-only':
      return 0;
    case 'root': {
      // "Root" = the lowest sounding note, which is what a guitar voicing's
      // bass string usually carries.
      const root = Math.min(...expected);
      return nearest(detected.map((d) => pitchClassCents(root, d)));
    }
    case 'any-tone':
      return nearest(expected.flatMap((e) => detected.map((d) => pitchClassCents(e, d))));
  }
}
