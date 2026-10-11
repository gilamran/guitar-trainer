import { PitchDetector } from 'pitchy';

export interface PitchEstimate {
  /** Fundamental frequency in Hz, or null when no periodicity was found. */
  readonly hz: number | null;
  /** How periodic the window is, 0–1 (NSDF peak height). */
  readonly clarity: number;
}

/**
 * Estimates the fundamental of one analysis window. Kept behind an interface
 * so the monophonic estimator can be swapped (e.g. a hand-rolled YIN) without
 * touching the onset/note logic.
 */
export interface PitchEstimator {
  readonly windowSize: number;
  estimate(window: Float32Array, sampleRate: number): PitchEstimate;
}

/** Guitar range with headroom: B0 (7-string / drop tunings) to ~E6. */
export const MIN_GUITAR_HZ = 28;
export const MAX_GUITAR_HZ = 1400;

/**
 * pitchy implements the McLeod Pitch Method — a normalized-autocorrelation
 * method from the same family as YIN, with fewer octave errors on plucked
 * strings and a clarity measure we use as confidence.
 */
export class PitchyEstimator implements PitchEstimator {
  private readonly detector: PitchDetector<Float32Array>;

  constructor(readonly windowSize = 2048) {
    this.detector = PitchDetector.forFloat32Array(windowSize);
    // Level gating happens in the note tracker; let pitchy analyze everything.
    this.detector.minVolumeDecibels = -100;
  }

  estimate(window: Float32Array, sampleRate: number): PitchEstimate {
    const [hz, clarity] = this.detector.findPitch(window, sampleRate);
    if (!Number.isFinite(hz) || hz < MIN_GUITAR_HZ || hz > MAX_GUITAR_HZ) {
      return { hz: null, clarity: 0 };
    }
    return { hz, clarity };
  }
}
