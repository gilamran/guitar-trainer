import { MIN_GUITAR_HZ, type PitchEstimator } from './pitch-estimator';

/** Analysis of one hop of audio. */
export interface AnalysisFrame {
  /** Audio-clock time (s) at the start of the newest hop. */
  readonly timeSec: number;
  /** Audio-clock time (s) at the end of the pitch window (= end of the hop). */
  readonly windowEndSec: number;
  /** Peak envelope of the raw signal over the hop, dBFS. */
  readonly levelDb: number;
  /**
   * Peak envelope of the pre-emphasized (high-passed) signal, dBFS. Pick
   * attacks are bright, so this rises much more on a re-pick than `levelDb`.
   */
  readonly onsetDb: number;
  /** Pitch over the full window ending at this hop. */
  readonly pitchHz: number | null;
  readonly clarity: number;
  /**
   * Pitch of the same window after cancelling a still-ringing previous note
   * with a comb filter. Only present when cancellation was requested.
   */
  readonly residual?: { readonly pitchHz: number | null; readonly clarity: number };
}

const SILENCE_DB = -120;
/** Envelope release: slow enough to bridge the gaps between waveform peaks of a low E. */
const ENVELOPE_RELEASE_SEC = 0.05;
const PRE_EMPHASIS = 0.95;

const toDb = (amp: number) => (amp > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(amp)) : SILENCE_DB);

/**
 * Slices an incoming sample stream into overlapping windows (one per hop) and
 * runs level, attack and pitch analysis on each. Time comes from the sample
 * count, so results are exact regardless of main-thread jank.
 */
export class FrameAnalyzer {
  /** Raw history: `maxDelay` extra samples in front of the pitch window for the comb filter. */
  private readonly buffer: Float32Array;
  private readonly window: Float32Array;
  private readonly residual: Float32Array;
  private readonly maxDelay: number;
  private readonly releaseCoef: number;

  private filled = 0;
  private sinceHop = 0;
  private nextFrame: number | null = null;
  private envRaw = 0;
  private envPre = 0;
  private prevSample = 0;
  private hopPeakRaw = 0;
  private hopPeakPre = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly estimator: PitchEstimator,
    readonly hopSize = 256,
  ) {
    this.maxDelay = Math.ceil(sampleRate / MIN_GUITAR_HZ) + 2;
    this.buffer = new Float32Array(estimator.windowSize + this.maxDelay);
    this.window = new Float32Array(estimator.windowSize);
    this.residual = new Float32Array(estimator.windowSize);
    this.releaseCoef = Math.exp(-1 / (ENVELOPE_RELEASE_SEC * sampleRate));
  }

  get windowDurationSec(): number {
    return this.window.length / this.sampleRate;
  }

  /**
   * @param startFrame Absolute sample index (audio clock) of `samples[0]`.
   *                   A gap (dropped buffer) resets the analysis.
   * @param cancelHz   Asked once per hop: frequency of a previous note to
   *                   cancel for the `residual` estimate, or null.
   */
  push(samples: Float32Array, startFrame: number, cancelHz?: () => number | null): AnalysisFrame[] {
    if (this.nextFrame !== null && startFrame !== this.nextFrame) this.reset();
    this.nextFrame = startFrame + samples.length;

    const frames: AnalysisFrame[] = [];
    const size = this.buffer.length;
    let i = 0;
    while (i < samples.length) {
      const take = Math.min(this.hopSize - this.sinceHop, samples.length - i);
      const chunk = samples.subarray(i, i + take);
      this.trackEnvelopes(chunk);
      this.buffer.copyWithin(0, take);
      this.buffer.set(chunk, size - take);
      i += take;
      this.sinceHop += take;
      this.filled = Math.min(size, this.filled + take);

      if (this.sinceHop === this.hopSize) {
        this.sinceHop = 0;
        frames.push(this.analyze(startFrame + i, cancelHz?.() ?? null));
      }
    }
    return frames;
  }

  reset(): void {
    this.buffer.fill(0);
    this.filled = 0;
    this.sinceHop = 0;
    this.nextFrame = null;
    this.envRaw = 0;
    this.envPre = 0;
    this.prevSample = 0;
    this.hopPeakRaw = 0;
    this.hopPeakPre = 0;
  }

  /** Instant-attack / exponential-release peak followers on raw and pre-emphasized input. */
  private trackEnvelopes(chunk: Float32Array): void {
    const c = this.releaseCoef;
    for (let k = 0; k < chunk.length; k++) {
      const x = chunk[k];
      const pre = x - PRE_EMPHASIS * this.prevSample;
      this.prevSample = x;
      this.envRaw = Math.max(Math.abs(x), this.envRaw * c);
      this.envPre = Math.max(Math.abs(pre), this.envPre * c);
      if (this.envRaw > this.hopPeakRaw) this.hopPeakRaw = this.envRaw;
      if (this.envPre > this.hopPeakPre) this.hopPeakPre = this.envPre;
    }
  }

  private analyze(endFrame: number, cancelHz: number | null): AnalysisFrame {
    const levelDb = toDb(this.hopPeakRaw);
    const onsetDb = toDb(this.hopPeakPre);
    this.hopPeakRaw = this.envRaw;
    this.hopPeakPre = this.envPre;

    const frame = {
      timeSec: (endFrame - this.hopSize) / this.sampleRate,
      windowEndSec: endFrame / this.sampleRate,
      levelDb,
      onsetDb,
    };
    const windowSize = this.window.length;
    if (this.filled < windowSize) return { ...frame, pitchHz: null, clarity: 0 };

    this.window.set(this.buffer.subarray(this.maxDelay));
    const pitch = this.estimator.estimate(this.window, this.sampleRate);
    const result: AnalysisFrame = { ...frame, pitchHz: pitch.hz, clarity: pitch.clarity };

    const delay = cancelHz ? this.sampleRate / cancelHz : 0;
    if (delay <= 0 || delay >= this.maxDelay - 1 || this.filled < windowSize + Math.ceil(delay) + 1) {
      return result;
    }
    // Feed-forward comb y[n] = x[n] − x[n − T] nulls every harmonic of the
    // previous note; linear interpolation handles the fractional delay.
    const whole = Math.floor(delay);
    const frac = delay - whole;
    const off = this.maxDelay;
    for (let n = 0; n < windowSize; n++) {
      const j = off + n - whole;
      const delayed = this.buffer[j] * (1 - frac) + this.buffer[j - 1] * frac;
      this.residual[n] = this.buffer[off + n] - delayed;
    }
    const r = this.estimator.estimate(this.residual, this.sampleRate);
    return { ...result, residual: { pitchHz: r.hz, clarity: r.clarity } };
  }
}
