import { describe, expect, it } from 'vitest';
import {
  frequencyToMidi,
  midiToFrequency,
  midiToName,
  pitchClassCents,
  pitchErrorCents,
} from './pitch';

describe('pitch helpers', () => {
  it('converts between frequency and MIDI', () => {
    expect(frequencyToMidi(440)).toBeCloseTo(69);
    expect(frequencyToMidi(82.4069)).toBeCloseTo(40, 3); // low E
    expect(midiToFrequency(40)).toBeCloseTo(82.4069, 3);
    expect(frequencyToMidi(midiToFrequency(57.3))).toBeCloseTo(57.3);
  });

  it('names notes', () => {
    expect(midiToName(40)).toBe('E2');
    expect(midiToName(69)).toBe('A4');
    expect(midiToName(61.2)).toBe('C#4');
  });

  it('wraps pitch-class distances into [-600, 600)', () => {
    expect(pitchClassCents(40, 52)).toBeCloseTo(0);
    expect(pitchClassCents(40, 51.7)).toBeCloseTo(-30);
    expect(pitchClassCents(40, 28.2)).toBeCloseTo(20);
    expect(pitchClassCents(40, 46)).toBeCloseTo(-600);
  });

  it('picks the nearest detected pitch for single notes', () => {
    expect(pitchErrorCents([45], [57, 45.1], 'any-tone')).toBeCloseTo(10);
    expect(pitchErrorCents([45], [], 'any-tone')).toBeNull();
  });
});
