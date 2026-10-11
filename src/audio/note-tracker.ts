import { frequencyToMidi, midiToFrequency } from '../matching/pitch';
import type { AnalysisFrame } from './frame-analyzer';

/** A note onset heard by the monophonic detector. */
export interface TrackedNote {
  /** Onset time on the audio clock, seconds. */
  readonly onsetSec: number;
  /** Fractional MIDI pitch, or null when no stable pitch emerged (e.g. a muted strum). */
  readonly midi: number | null;
  /** 0–1: share of agreeing pitch estimates × their mean clarity. */
  readonly confidence: number;
  /** `energy`: picked/plucked attack. `pitch-change`: legato (hammer-on, pull-off, slide). */
  readonly cause: 'energy' | 'pitch-change';
}

export interface NoteTrackerOptions {
  /** Attack-envelope rise (dB) over the recent minimum that counts as a pick. */
  readonly onsetRiseDb: number;
  /** How far back (s) to look for the pre-attack minimum. */
  readonly riseLookbackSec: number;
  /** Nothing below this level (dBFS) counts as playing. */
  readonly minLevelDb: number;
  /** Required margin above the tracked noise floor (dB). */
  readonly gateAboveNoiseDb: number;
  /** Refractory period between onsets (s). */
  readonly minOnsetIntervalSec: number;
  /** Minimum pitch clarity (0–1) for an estimate to be trusted. */
  readonly minClarity: number;
  /** Pitch jump (semitones) that starts a new legato note. */
  readonly pitchChangeSemitones: number;
  /** Consecutive consistent hops needed to accept a legato note. */
  readonly pitchChangeHops: number;
  /** Extra time (s) after a full post-onset window to wait for a stable pitch. */
  readonly maxPitchWaitSec: number;
}

export const DEFAULT_TRACKER_OPTIONS: NoteTrackerOptions = {
  onsetRiseDb: 6,
  riseLookbackSec: 0.03,
  minLevelDb: -55,
  gateAboveNoiseDb: 12,
  minOnsetIntervalSec: 0.05,
  minClarity: 0.85,
  pitchChangeSemitones: 0.7,
  pitchChangeHops: 4,
  maxPitchWaitSec: 0.08,
};

const AGREE_SEMITONES = 0.35;
const NEEDED_AGREEING = 3;
/** A step this large in the attack envelope near a legato onset is taken as a soft pick. */
const SOFT_ATTACK_DB = 3;
/** Noise floor = minimum level over the last FLOOR_BLOCKS × FLOOR_BLOCK_SEC. */
const FLOOR_BLOCK_SEC = 0.25;
const FLOOR_BLOCKS = 8;
/** Never let the floor (and so the gate) climb into normal playing levels. */
const MAX_NOISE_FLOOR_DB = -45;
const NOTE_OFF_HYSTERESIS_DB = 6;
/**
 * Re-picking a ringing string at a similar level barely changes the envelope,
 * but it resets the waveform's phase, so periodicity (clarity) collapses for
 * windows spanning the restart. A soft rise followed by such a dip is an onset.
 */
const STABLE_CLARITY = 0.9;
/** Comb filtering costs some periodicity, so residual estimates get a lower bar. */
const RESIDUAL_MIN_CLARITY = 0.7;
const CLARITY_DIP = 0.85;
const SOFT_CONFIRM_HOPS = 4;
/** A stable tone (≥ STABLE_HOPS hops of clarity ≥ 0.95, steady pitch) collapsing below this is a restart. */
const PHASE_RESET_CLARITY = 0.6;
const STABLE_HOPS = 4;

interface Estimate {
  readonly midi: number;
  readonly clarity: number;
}

interface Pending {
  readonly onsetSec: number;
  readonly cause: TrackedNote['cause'];
  /** Pitch of the note that was still ringing when this one started. */
  readonly previousMidi: number | null;
  readonly estimates: Estimate[];
  readonly firstValidWindowEndSec: number;
  readonly deadlineSec: number;
}

interface HistoryEntry {
  readonly timeSec: number;
  readonly levelDb: number;
  readonly onsetDb: number;
  readonly clarity: number;
  readonly midi: number | null;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Returns k ≥ 1 when `midi` is the k-th sub-harmonic of `reference` (k = 1 is
 * the note itself), else 0. A mono pitch detector hearing a mixture of two
 * notes reports their common sub-harmonic (A2 + E3 → A1, k = 2 of A2).
 */
function subharmonicOf(reference: number, midi: number): number {
  for (let k = 1; k <= 8; k++) {
    if (Math.abs(reference - 12 * Math.log2(k) - midi) < 0.3) return k;
  }
  return 0;
}

/**
 * Turns per-hop analysis into discrete note onsets.
 *
 * 1. Energy onsets: the attack envelope jumps by `onsetRiseDb` above its
 *    minimum over the last ~30 ms while the level is above an adaptive noise
 *    gate. The onset is placed at the first hop of the rise.
 * 2. Pitch: estimates from windows that lie mostly after the onset are
 *    collected until three agree (or a deadline passes); the note's pitch is
 *    their mean. If a previous note is still ringing, the analyzer also
 *    provides an estimate with that note comb-filtered out, which is used
 *    when the plain estimate is just the old note or the mixture's common
 *    sub-harmonic.
 * 3. Legato: while a note sounds, a sustained jump to a new stable pitch emits
 *    a `pitch-change` onset — hammer-ons, pull-offs and slides have no clear
 *    attack.
 *
 * Driven purely by frame timestamps: deterministic and testable with
 * synthetic signals.
 */
export class NoteTracker {
  private readonly opts: NoteTrackerOptions;
  private readonly history: HistoryEntry[] = [];
  private noiseFloorDb = Number.POSITIVE_INFINITY;
  private floorBlocks: number[] = [];
  private blockMin = Number.POSITIVE_INFINITY;
  private blockStartSec: number | null = null;
  private lastOnsetSec = Number.NEGATIVE_INFINITY;
  private pending: Pending | null = null;
  private currentMidi: number | null = null;
  private sounding = false;
  private changeRun: { midi: number; windowEndSec: number; clarity: number }[] = [];
  private softCandidate: { onsetSec: number; hopsLeft: number } | null = null;

  constructor(
    private readonly windowDurationSec: number,
    options: Partial<NoteTrackerOptions> = {},
  ) {
    this.opts = { ...DEFAULT_TRACKER_OPTIONS, ...options };
  }

  /** Current gate level (dBFS). */
  get gateDb(): number {
    const floor = Number.isFinite(this.noiseFloorDb) ? this.noiseFloorDb : -120;
    return Math.max(this.opts.minLevelDb, floor + this.opts.gateAboveNoiseDb);
  }

  /** Frequency the analyzer should cancel for the residual estimate, if any. */
  get cancelHz(): number | null {
    const prev = this.pending?.previousMidi;
    return prev === null || prev === undefined ? null : midiToFrequency(prev);
  }

  /** Feeds one analysis frame; returns any notes completed by it. */
  process(frame: AnalysisFrame): TrackedNote[] {
    const out: TrackedNote[] = [];
    const o = this.opts;
    const gate = this.gateDb;

    // --- 1. energy onset -------------------------------------------------
    // The bright attack envelope reacts best to picks over a ringing string;
    // the plain level envelope is better when broadband noise masks the attack.
    const attack = this.rise(frame, 'onsetDb');
    const level = this.rise(frame, 'levelDb');
    const best = attack.rise >= level.rise ? attack : level;
    const sinceLast = frame.timeSec - this.lastOnsetSec;
    const stableBefore = this.stableTone();

    if (frame.levelDb >= gate && best.rise >= o.onsetRiseDb && sinceLast >= o.minOnsetIntervalSec) {
      const onsetSec = best.onsetSec;
      if (onsetSec - this.lastOnsetSec >= o.minOnsetIntervalSec) {
        this.flushPending(out);
        this.startPending(onsetSec, 'energy');
      }
    } else if (this.softCandidate) {
      // --- 1b. confirm a soft re-pick by the clarity dip it causes -------
      if (frame.clarity < CLARITY_DIP) {
        const onsetSec = this.softCandidate.onsetSec;
        this.softCandidate = null;
        if (onsetSec - this.lastOnsetSec >= o.minOnsetIntervalSec) {
          this.flushPending(out);
          this.startPending(onsetSec, 'energy');
        }
      } else if (--this.softCandidate.hopsLeft <= 0) {
        this.softCandidate = null;
      }
    } else if (
      frame.levelDb >= gate &&
      best.rise >= o.onsetRiseDb / 2 &&
      sinceLast >= o.minOnsetIntervalSec &&
      this.history.slice(-3).some((h) => h.clarity >= STABLE_CLARITY)
    ) {
      this.softCandidate = { onsetSec: frame.timeSec, hopsLeft: SOFT_CONFIRM_HOPS };
      if (frame.clarity < CLARITY_DIP) {
        // The dip can already show in the hop of the attack itself.
        this.softCandidate.hopsLeft = 1;
      }
    } else if (
      frame.levelDb >= gate &&
      stableBefore &&
      frame.clarity < PHASE_RESET_CLARITY &&
      sinceLast >= o.minOnsetIntervalSec
    ) {
      // --- 1c. re-pick without any level rise: a stable tone's periodicity
      // collapses abruptly when the string is restarted.
      this.flushPending(out);
      this.startPending(frame.timeSec, 'energy');
    }

    // --- 2. pitch for the pending onset ------------------------------------
    if (this.pending) {
      const estimate = this.pendingEstimate(frame, this.pending.previousMidi);
      if (estimate !== null && frame.windowEndSec >= this.pending.firstValidWindowEndSec) {
        this.pending.estimates.push(estimate);
        if (this.agreeing(this.pending.estimates).length >= NEEDED_AGREEING) this.flushPending(out);
      }
      if (this.pending && frame.windowEndSec >= this.pending.deadlineSec) this.flushPending(out);
    } else if (frame.levelDb >= gate) {
      // --- 3. legato pitch change ----------------------------------------
      this.trackPitchChange(frame, out);
    }

    // --- bookkeeping --------------------------------------------------------
    if (frame.levelDb >= gate) this.sounding = true;
    else if (frame.levelDb < gate - NOTE_OFF_HYSTERESIS_DB && this.sounding && !this.pending) {
      this.sounding = false;
      this.currentMidi = null;
      this.changeRun = [];
    }

    this.updateNoiseFloor(frame);
    this.history.push({
      timeSec: frame.timeSec,
      levelDb: frame.levelDb,
      onsetDb: frame.onsetDb,
      clarity: frame.clarity,
      midi: frame.pitchHz === null ? null : frequencyToMidi(frame.pitchHz),
    });
    const keepFrom = frame.timeSec - Math.max(o.riseLookbackSec, this.windowDurationSec) - 0.05;
    while (this.history.length > 0 && this.history[0].timeSec < keepFrom) this.history.shift();

    return out;
  }

  /**
   * Rise of `key` in this frame over its minimum in the lookback window, and
   * where the rise started (first hop that rose half-way).
   */
  private rise(frame: AnalysisFrame, key: 'onsetDb' | 'levelDb'): { rise: number; onsetSec: number } {
    const lookbackStart = frame.timeSec - this.opts.riseLookbackSec - 1e-9;
    let minIdx = -1;
    for (let i = 0; i < this.history.length; i++) {
      const h = this.history[i];
      if (h.timeSec < lookbackStart) continue;
      if (minIdx === -1 || h[key] <= this.history[minIdx][key]) minIdx = i;
    }
    if (minIdx === -1) return { rise: 0, onsetSec: frame.timeSec };
    const min = this.history[minIdx][key];
    const rise = frame[key] - min;
    const halfway = min + this.opts.onsetRiseDb / 2;
    let onsetSec = frame.timeSec;
    for (let i = minIdx + 1; i < this.history.length; i++) {
      if (this.history[i][key] >= halfway) {
        onsetSec = this.history[i].timeSec;
        break;
      }
    }
    return { rise, onsetSec };
  }

  /** Were the last STABLE_HOPS hops a clean, steady tone? */
  private stableTone(): boolean {
    if (this.history.length < STABLE_HOPS) return false;
    const recent = this.history.slice(-STABLE_HOPS);
    if (recent.some((h) => h.clarity < 0.95 || h.midi === null)) return false;
    const pitches = recent.map((h) => h.midi as number);
    return Math.max(...pitches) - Math.min(...pitches) < 0.25;
  }

  /** Emits whatever is pending (call when input stops). */
  flush(): TrackedNote[] {
    const out: TrackedNote[] = [];
    this.flushPending(out);
    return out;
  }

  reset(): void {
    this.history.length = 0;
    this.noiseFloorDb = Number.POSITIVE_INFINITY;
    this.floorBlocks = [];
    this.blockMin = Number.POSITIVE_INFINITY;
    this.blockStartSec = null;
    this.lastOnsetSec = Number.NEGATIVE_INFINITY;
    this.pending = null;
    this.currentMidi = null;
    this.sounding = false;
    this.changeRun = [];
    this.softCandidate = null;
  }

  private confident(hz: number | null, clarity: number, min = this.opts.minClarity): number | null {
    return hz !== null && clarity >= min ? frequencyToMidi(hz) : null;
  }

  private pendingEstimate(frame: AnalysisFrame, previousMidi: number | null): Estimate | null {
    const direct = this.confident(frame.pitchHz, frame.clarity);
    const res = frame.residual;
    const residual = res ? this.confident(res.pitchHz, res.clarity, RESIDUAL_MIN_CLARITY) : null;
    const viaResidual = res && residual !== null ? { midi: residual, clarity: res.clarity } : null;
    const viaDirect = direct === null ? null : { midi: direct, clarity: frame.clarity };
    if (previousMidi === null) return viaDirect;

    if (direct === null) return viaResidual;
    const k = subharmonicOf(previousMidi, direct);
    if (k >= 2) return viaResidual; // mixture artefact: never report the sub-harmonic
    if (k === 1) return viaResidual ?? viaDirect; // old note may mask the new one
    if (residual !== null && subharmonicOf(residual, direct) >= 2) return viaResidual; // octave error
    return viaDirect;
  }

  private startPending(onsetSec: number, cause: TrackedNote['cause']): void {
    this.lastOnsetSec = onsetSec;
    this.changeRun = [];
    this.pending = {
      onsetSec,
      cause,
      previousMidi: this.sounding ? this.currentMidi : null,
      estimates: [],
      // Windows ending before this are still mostly the previous sound.
      firstValidWindowEndSec: onsetSec + 0.6 * this.windowDurationSec,
      deadlineSec: onsetSec + this.windowDurationSec + this.opts.maxPitchWaitSec,
    };
  }

  private agreeing(estimates: readonly Estimate[]): Estimate[] {
    if (estimates.length === 0) return [];
    const m = median(estimates.map((e) => e.midi));
    return estimates.filter((e) => Math.abs(e.midi - m) <= AGREE_SEMITONES);
  }

  private flushPending(out: TrackedNote[]): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const agree = this.agreeing(p.estimates);
    let midi: number | null = null;
    let confidence = 0;
    if (agree.length > 0) {
      midi = agree.reduce((s, e) => s + e.midi, 0) / agree.length;
      const meanClarity = agree.reduce((s, e) => s + e.clarity, 0) / agree.length;
      confidence = (Math.min(agree.length, NEEDED_AGREEING) / NEEDED_AGREEING) * meanClarity;
    }
    this.currentMidi = midi;
    out.push({ onsetSec: p.onsetSec, midi, confidence, cause: p.cause });
  }

  private trackPitchChange(frame: AnalysisFrame, out: TrackedNote[]): void {
    const o = this.opts;
    const midi = this.confident(frame.pitchHz, frame.clarity);
    if (midi === null) return;

    // Sub-harmonics of the sounding note are mixture artefacts (another string
    // still ringing), not a new legato note.
    const isNew =
      this.currentMidi === null ||
      (Math.abs(midi - this.currentMidi) >= o.pitchChangeSemitones &&
        subharmonicOf(this.currentMidi, midi) === 0);
    if (!isNew) {
      this.changeRun = [];
      return;
    }
    const first = this.changeRun[0];
    if (first && Math.abs(midi - first.midi) > AGREE_SEMITONES * 1.5) this.changeRun = [];
    this.changeRun.push({ midi, windowEndSec: frame.windowEndSec, clarity: frame.clarity });

    if (this.changeRun.length >= o.pitchChangeHops) {
      // The detector flips once the new pitch fills ~half the window; prefer
      // a nearby (sub-threshold) pick attack when there is one.
      const estimate = this.changeRun[0].windowEndSec - this.windowDurationSec / 2;
      const onsetSec = this.findSoftAttack(estimate - 0.03, estimate + 0.02) ?? estimate;
      if (onsetSec - this.lastOnsetSec >= o.minOnsetIntervalSec) {
        const run = this.changeRun;
        const m = median(run.map((r) => r.midi));
        const clarity = run.reduce((s, r) => s + r.clarity, 0) / run.length;
        out.push({ onsetSec, midi: m, confidence: clarity, cause: 'pitch-change' });
        this.lastOnsetSec = onsetSec;
        this.currentMidi = m;
      }
      this.changeRun = [];
    }
  }

  /** Time of the largest attack-envelope step ≥ SOFT_ATTACK_DB in [fromSec, toSec], if any. */
  private findSoftAttack(fromSec: number, toSec: number): number | null {
    let best: number | null = null;
    let bestStep = SOFT_ATTACK_DB;
    for (let i = 3; i < this.history.length; i++) {
      const h = this.history[i];
      if (h.timeSec < fromSec || h.timeSec > toSec) continue;
      const before = Math.min(
        this.history[i - 1].onsetDb,
        this.history[i - 2].onsetDb,
        this.history[i - 3].onsetDb,
      );
      const step = h.onsetDb - before;
      if (step >= bestStep) {
        bestStep = step;
        best = h.timeSec;
      }
    }
    return best;
  }

  /** Minimum statistics: robust to long sustained notes, adapts to new noise in ~2 s. */
  private updateNoiseFloor(frame: AnalysisFrame): void {
    if (this.blockStartSec === null) this.blockStartSec = frame.timeSec;
    this.blockMin = Math.min(this.blockMin, frame.levelDb);
    if (frame.timeSec - this.blockStartSec >= FLOOR_BLOCK_SEC) {
      this.floorBlocks.push(this.blockMin);
      if (this.floorBlocks.length > FLOOR_BLOCKS) this.floorBlocks.shift();
      this.blockMin = Number.POSITIVE_INFINITY;
      this.blockStartSec = frame.timeSec;
    }
    const floor = Math.min(this.blockMin, ...this.floorBlocks);
    this.noiseFloorDb = Math.min(MAX_NOISE_FLOOR_DB, floor);
  }
}
