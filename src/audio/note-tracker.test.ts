import { describe, expect, it } from 'vitest';
import { matchEvents } from '../matching/matcher';
import { seededRandom } from '../matching/test-helpers';
import { FrameAnalyzer } from './frame-analyzer';
import { NoteTracker, type TrackedNote } from './note-tracker';
import { PitchyEstimator } from './pitch-estimator';
import { renderLine, type SyntheticNote } from './test-signals';

const SR = 48000;

function detect(signal: Float32Array, chunk = 128, sampleRate = SR): TrackedNote[] {
  const analyzer = new FrameAnalyzer(sampleRate, new PitchyEstimator(2048), 256);
  const tracker = new NoteTracker(analyzer.windowDurationSec);
  const notes: TrackedNote[] = [];
  for (let i = 0; i < signal.length; i += chunk) {
    for (const f of analyzer.push(signal.subarray(i, i + chunk), i, () => tracker.cancelHz)) {
      notes.push(...tracker.process(f));
    }
  }
  notes.push(...tracker.flush());
  return notes;
}

function expectNotes(found: TrackedNote[], expected: SyntheticNote[], onsetTolSec = 0.012) {
  expect(found.map((n) => Math.round(n.midi ?? -1))).toEqual(expected.map((n) => n.midi));
  found.forEach((n, i) => {
    expect(Math.abs(n.onsetSec - expected[i].onsetSec)).toBeLessThan(onsetTolSec);
    expect(Math.abs((n.midi ?? 0) - expected[i].midi)).toBeLessThan(0.2); // 20 cents
  });
}

describe('NoteTracker on synthetic guitar signals', () => {
  it('detects picked single notes across the guitar range', () => {
    const notes: SyntheticNote[] = [40, 45, 50, 55, 59, 64, 69, 76].map((midi, i) => ({
      onsetSec: 0.2 + i * 0.4,
      midi,
    }));
    expectNotes(detect(renderLine(notes, 3.8, { noiseDb: -70 })), notes);
  });

  it('separates fast re-picked notes of the same pitch', () => {
    const notes: SyntheticNote[] = Array.from({ length: 8 }, (_, i) => ({
      onsetSec: 0.1 + i * 0.15,
      midi: 52,
    }));
    expectNotes(detect(renderLine(notes, 1.6, { noiseDb: -70 })), notes);
  });

  it('detects a cross-string line where the previous note keeps ringing', () => {
    // A mono estimator on A2 + E3 reports their common sub-harmonic A1; the
    // comb filter on the previous note recovers the new one.
    const notes: SyntheticNote[] = [
      { onsetSec: 0.1, midi: 45 },
      { onsetSec: 0.5, midi: 52 },
      { onsetSec: 0.9, midi: 57 },
      { onsetSec: 1.3, midi: 64 },
      { onsetSec: 1.7, midi: 59 },
    ];
    expectNotes(detect(renderLine(notes, 2.2, { noiseDb: -70, ringOver: 1 })), notes);
  });

  it('detects legato (hammer-on / pull-off) as pitch-change onsets', () => {
    const notes: SyntheticNote[] = [
      { onsetSec: 0.1, midi: 45 },
      { onsetSec: 0.5, midi: 47, articulation: 'legato' },
      { onsetSec: 0.9, midi: 45, articulation: 'legato' },
    ];
    const found = detect(renderLine(notes, 1.4, { noiseDb: -70 }));
    expect(found.map((n) => n.cause)).toEqual(['energy', 'pitch-change', 'pitch-change']);
    expectNotes(found, notes, 0.025);
  });

  it('stays silent on background noise', () => {
    expect(detect(renderLine([], 2, { noiseDb: -50 }))).toEqual([]);
    expect(detect(new Float32Array(SR))).toEqual([]);
  });

  it('works at 44.1 kHz and with odd chunk sizes', () => {
    const notes: SyntheticNote[] = [
      { onsetSec: 0.15, midi: 43 },
      { onsetSec: 0.6, midi: 62 },
    ];
    const signal = renderLine(notes, 1.2, { sampleRate: 44100, noiseDb: -70 });
    expectNotes(detect(signal, 333, 44100), notes);
  });

  it('keeps detecting through a long, loud passage', () => {
    // 12 s of continuous playing: the noise gate must not creep up into it.
    const notes: SyntheticNote[] = Array.from({ length: 48 }, (_, i) => ({
      onsetSec: 0.1 + i * 0.25,
      midi: 48 + (i % 7),
      amp: 0.5,
    }));
    expectNotes(detect(renderLine(notes, 12.3, { noiseDb: -70 })), notes);
  });
});

describe('NoteTracker robustness', () => {
  it('reports one note for a long sustained note with vibrato', () => {
    const notes: SyntheticNote[] = [{ onsetSec: 0.1, midi: 55, vibratoCents: 30 }];
    const found = detect(renderLine(notes, 3, { noiseDb: -70 }));
    expect(found).toHaveLength(1);
    expect(found[0].midi).toBeCloseTo(55, 0);
  });

  it('copes with a noisy input (about 25 dB SNR)', () => {
    const notes: SyntheticNote[] = [40, 47, 52, 57, 62].map((midi, i) => ({ onsetSec: 0.3 + i * 0.35, midi }));
    expectNotes(detect(renderLine(notes, 2.2, { noiseDb: -40, seed: 3 })), notes);
  });

  it('detects quiet playing', () => {
    const notes: SyntheticNote[] = [45, 50, 55].map((midi, i) => ({ onsetSec: 0.2 + i * 0.4, midi, amp: 0.02 }));
    expectNotes(detect(renderLine(notes, 1.5, { noiseDb: -75 })), notes);
  });

  it('gets ≥ 95% of randomized lines right end to end (detector + matcher)', () => {
    const rand = seededRandom(2024);
    let hits = 0;
    let total = 0;
    for (let trial = 0; trial < 6; trial++) {
      const notes: SyntheticNote[] = [];
      let t = 0.2;
      for (let i = 0; i < 24; i++) {
        const midi = 40 + Math.floor(rand() * 30);
        const legato = i > 0 && rand() < 0.15;
        // legato moves 1–3 semitones from the previous note, like a hammer-on/pull-off
        const prev = notes[notes.length - 1]?.midi ?? midi;
        notes.push({
          onsetSec: t,
          midi: legato ? prev + (rand() < 0.5 ? -1 : 1) * (1 + Math.floor(rand() * 3)) : midi,
          articulation: legato ? 'legato' : 'pick',
          amp: 0.2 * 10 ** (((rand() * 2 - 1) * 4) / 20), // ±4 dB dynamics
        });
        t += 0.12 + rand() * 0.25;
      }
      const signal = renderLine(notes, t + 0.5, { noiseDb: -60, ringOver: trial % 2, seed: trial });
      const expected = notes.map((n, i) => ({ id: `${i}`, timeMs: n.onsetSec * 1000, pitches: [n.midi] }));
      const detected = detect(signal).map((n, i) => ({
        id: i,
        timeMs: n.onsetSec * 1000,
        pitches: n.midi === null ? [] : [n.midi],
        confidence: n.confidence,
      }));
      const r = matchEvents(expected, detected);
      hits += r.results.filter((x) => x.verdict === 'hit').length;
      total += expected.length;
    }
    expect(hits / total).toBeGreaterThanOrEqual(0.95);
  });
});

describe('FrameAnalyzer', () => {
  it('produces identical frames regardless of chunking', () => {
    const signal = renderLine([{ onsetSec: 0.05, midi: 50 }], 0.3);
    const run = (chunk: number) => {
      const a = new FrameAnalyzer(SR, new PitchyEstimator(2048), 256);
      const frames = [];
      for (let i = 0; i < signal.length; i += chunk) frames.push(...a.push(signal.subarray(i, i + chunk), i));
      return frames;
    };
    expect(run(100)).toEqual(run(128));
  });

  it('timestamps frames from the sample clock', () => {
    const a = new FrameAnalyzer(SR, new PitchyEstimator(2048), 256);
    const frames = a.push(new Float32Array(512), SR); // starts at t = 1 s
    expect(frames.map((f) => f.timeSec)).toEqual([1, 1 + 256 / SR]);
    expect(frames[1].windowEndSec).toBeCloseTo(1 + 512 / SR);
  });
});
