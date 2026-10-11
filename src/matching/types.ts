/**
 * Core data model shared by the matcher, the practice session and (later)
 * any pitch detector. Everything here is plain data so the matcher stays a
 * pure function that can be tested with synthetic note streams.
 *
 * Time base: all `timeMs` values are *real* milliseconds (i.e. already
 * scaled by playback speed) relative to the start of the current loop pass.
 * Detected events are expected to be latency-compensated before matching.
 */

/** One onset the player is supposed to play: a single note or a chord. */
export interface ExpectedEvent {
  /** Stable id, unique within a pass (e.g. `${beatId}@${tick}`). */
  readonly id: string;
  /** Onset time in real ms from the start of the pass. */
  readonly timeMs: number;
  /** MIDI note numbers that start sounding at this onset, ascending. */
  readonly pitches: readonly number[];
}

/**
 * One onset heard by a detector. A monophonic detector (YIN/MPM) emits a single
 * pitch; a polyphonic detector (Phase 2, e.g. basic-pitch) may emit several.
 */
export interface DetectedEvent {
  readonly id: number;
  /** Onset time in real ms from the start of the pass, latency-compensated. */
  readonly timeMs: number;
  /** Fractional MIDI pitches (69 = A4). Empty if the onset had no clear pitch. */
  readonly pitches: readonly number[];
  /** Detector confidence in [0, 1]. */
  readonly confidence: number;
}

/**
 * How to judge pitch for expected events with more than one note.
 * - `any-tone`: any detected pitch matches the pitch class of any chord tone
 *   (the right choice for a monophonic detector listening to a chord).
 * - `root`: a detected pitch matches the pitch class of the lowest chord tone
 *   (intended for Phase 2 polyphonic detection).
 * - `timing-only`: only the onset time is judged.
 */
export type ChordPolicy = 'any-tone' | 'root' | 'timing-only';

export interface MatchOptions {
  /** |Δt| at or below this counts as on time. */
  readonly timingWindowMs: number;
  /**
   * Largest |Δt| at which a right-pitch detection is still associated with an
   * expected event (reported as early/late). Beyond it the event is missed.
   */
  readonly outerWindowMs: number;
  /** Allowed pitch deviation in cents. */
  readonly pitchToleranceCents: number;
  readonly chordPolicy: ChordPolicy;
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
  timingWindowMs: 120,
  outerWindowMs: 300,
  pitchToleranceCents: 50,
  chordPolicy: 'any-tone',
};

/**
 * - `hit`: right pitch, on time (green)
 * - `early` / `late`: right pitch, outside the timing window (yellow)
 * - `wrong`: something was played on time but at the wrong pitch (red)
 * - `missed`: nothing usable was played (red)
 * - `pending`: the event's window has not closed yet (live mode only)
 */
export type Verdict = 'hit' | 'early' | 'late' | 'wrong' | 'missed' | 'pending';

export interface EventResult {
  readonly expectedId: string;
  readonly verdict: Verdict;
  /** The detection paired with this event, if any. */
  readonly detectedId?: number;
  /** detected − expected, in ms. Negative means early. */
  readonly timingErrorMs?: number;
  /** Signed pitch error of the paired detection, in cents. */
  readonly centsError?: number;
}

export interface MatchResult {
  /** One result per expected event, in the same order as the input. */
  readonly results: EventResult[];
  /** Ids of detections that were not paired with any expected event. */
  readonly extraDetectionIds: number[];
}
