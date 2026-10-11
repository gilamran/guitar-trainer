import { midiToFrequency } from '../matching/pitch';
import { seededRandom } from '../matching/test-helpers';

/** One played note of a synthetic guitar line. */
export interface SyntheticNote {
  readonly onsetSec: number;
  readonly midi: number;
  /**
   * `pick` (default): new attack. `legato`: the pitch changes without a new
   * attack (hammer-on / pull-off), continuing the previous note's envelope.
   */
  readonly articulation?: 'pick' | 'legato';
  readonly amp?: number;
  /** Vibrato depth in cents (5.5 Hz). */
  readonly vibratoCents?: number;
}

export interface RenderOptions {
  readonly sampleRate?: number;
  /** Background noise level in dBFS (white noise). */
  readonly noiseDb?: number;
  /**
   * How many following notes a note keeps ringing under. 0 (default) cuts
   * each note when the next starts (single-string line); 1 lets the previous
   * note ring under the next one (cross-string line); Infinity rings forever.
   */
  readonly ringOver?: number;
  readonly seed?: number;
}

const HARMONICS = [1, 0.6, 0.35, 0.25, 0.15, 0.1, 0.06, 0.04];

/**
 * Renders a crude plucked-string signal: harmonic stack, 3 ms attack,
 * two-stage exponential decay (faster for upper harmonics), phase-continuous pitch changes for legato notes.
 */
export function renderLine(
  notes: readonly SyntheticNote[],
  totalSec: number,
  options: RenderOptions = {},
): Float32Array {
  const sr = options.sampleRate ?? 48000;
  const ringOver = options.ringOver ?? 0;
  const rand = seededRandom(options.seed ?? 1);
  const out = new Float32Array(Math.round(totalSec * sr));

  // Group into "voices": a picked note plus any legato notes that follow it.
  type Segment = { startSec: number; endSec: number; hz: number; vibrato: number };
  const voices: { attackSec: number; amp: number; segments: Segment[] }[] = [];
  notes.forEach((n, i) => {
    const cutBy = notes[i + 1 + ringOver];
    const endSec = cutBy ? cutBy.onsetSec : totalSec;
    const seg = { startSec: n.onsetSec, endSec, hz: midiToFrequency(n.midi), vibrato: n.vibratoCents ?? 0 };
    const voice = voices[voices.length - 1];
    if (n.articulation === 'legato' && voice) {
      voice.segments[voice.segments.length - 1].endSec = n.onsetSec;
      voice.segments.push(seg);
    } else {
      voices.push({ attackSec: n.onsetSec, amp: n.amp ?? 0.3, segments: [seg] });
    }
  });

  for (const v of voices) {
    const phases = HARMONICS.map(() => rand() * Math.PI * 2);
    const voiceEnd = Math.min(out.length, Math.round(v.segments[v.segments.length - 1].endSec * sr));
    for (const seg of v.segments) {
      const start = Math.round(seg.startSec * sr);
      const end = Math.min(out.length, Math.round(seg.endSec * sr));
      for (let s = start; s < end; s++) {
        const t = s / sr - v.attackSec;
        const attack = Math.min(1, t / 0.003);
        const release = Math.min(1, (voiceEnd - s) / (0.005 * sr)); // 5 ms fade at a cut
        const env = v.amp * attack * release;
        const hz = seg.vibrato ? seg.hz * 2 ** ((seg.vibrato / 1200) * Math.sin(2 * Math.PI * 5.5 * t)) : seg.hz;
        let x = 0;
        for (let h = 0; h < HARMONICS.length; h++) {
          phases[h] += (2 * Math.PI * hz * (h + 1)) / sr;
          // Two-stage decay like a real string (fast initial drop, long tail);
          // upper harmonics die away faster, so a fresh pick is brighter.
          const k = Math.sqrt(h + 1);
          const decay = 0.5 * Math.exp((-t * k) / 0.08) + 0.5 * Math.exp((-t * k) / 1.0);
          x += HARMONICS[h] * decay * Math.sin(phases[h]);
        }
        out[s] += env * x * 0.5;
      }
    }
  }

  if (options.noiseDb !== undefined) {
    const amp = 10 ** (options.noiseDb / 20) * Math.sqrt(3); // uniform → RMS = 10^(dB/20)
    for (let i = 0; i < out.length; i++) out[i] += (rand() * 2 - 1) * amp;
  }
  return out;
}
