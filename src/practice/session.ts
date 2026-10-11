import { matchEvents } from '../matching/matcher';
import { type PassScore, scorePass } from '../matching/scoring';
import type { DetectedEvent, EventResult, ExpectedEvent, MatchOptions } from '../matching/types';
import { PPQ, type TempoMap } from '../score/tempo-map';
import type { TickRange, TimelineEvent } from '../score/timeline';
import { Emitter } from '../util/emitter';

export interface SessionConfig {
  /** Range being practiced (the loop range, or the whole song). */
  readonly range: TickRange;
  /** All onsets of the practiced track (see buildTrackTimeline). */
  readonly timeline: readonly TimelineEvent[];
  readonly tempo: TempoMap;
  /** Playback speed factor (0.4–1). */
  readonly speed: number;
  /** Calibrated input latency to subtract from detections, ms. */
  readonly latencyMs: number;
  readonly match: MatchOptions;
}

export interface PositionSample {
  readonly tick: number;
  readonly perfMs: number;
  readonly isSeek: boolean;
}

export interface HeardNote {
  /** Onset on the performance.now() clock, before latency compensation. */
  readonly perfMs: number;
  readonly pitches: readonly number[];
  readonly confidence: number;
}

export interface LiveUpdate {
  readonly passIndex: number;
  readonly events: readonly TimelineEvent[];
  readonly results: readonly EventResult[];
}

export interface PassReport {
  /** 1-based within this session. */
  readonly index: number;
  readonly events: readonly TimelineEvent[];
  readonly results: readonly EventResult[];
  readonly score: PassScore;
  /** Playback stopped or jumped before the end of the range. */
  readonly partial: boolean;
  readonly speed: number;
}

/**
 * Typical delay between an onset and the detector reporting it (it waits for
 * a stable pitch). Events are not declared missed before this has passed.
 */
export const DETECTION_DELAY_MS = 160;

/** Stopping within this many ticks of the range end still counts as a full pass. */
const END_TOLERANCE_TICKS = PPQ / 2;
/** alphaTab reports seek targets with rounding (a loop wrap to tick 0 may say 1). */
const SEEK_TOLERANCE_TICKS = PPQ / 8;
/** Position samples within this many ticks of a note place that note in time. */
const LOCAL_ANCHOR_TICKS = PPQ / 2;
const MIN_LOCAL_SAMPLES = 3;

interface AnchorSample {
  readonly tick: number;
  /** performance.now() at which `fromTick` would have played, implied by this sample. */
  readonly anchor: number;
}

interface Pass {
  readonly index: number;
  readonly fromTick: number;
  events: TimelineEvent[];
  /** Non-seek position samples, in arrival (= tick) order. */
  readonly samples: AnchorSample[];
  lastTick: number;
  closedAtPerf: number | null;
  partial: boolean;
}

interface StoredDetection {
  readonly id: number;
  /** Latency-compensated onset on the performance.now() clock. */
  readonly perfMs: number;
  readonly pitches: readonly number[];
  readonly confidence: number;
}

/** Positions arrive late but never early, so the earliest estimates are best; p10 resists outliers. */
function lowPercentile(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * 0.1)];
}

function lowerBound(samples: readonly AnchorSample[], tick: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].tick < tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** One reference anchor for the whole pass (only used as the axis origin). */
function passAnchor(pass: Pass): number | null {
  return pass.samples.length ? lowPercentile(pass.samples.map((s) => s.anchor)) : null;
}

/**
 * Anchor for a note at `tick`, from the position samples around it. Playback
 * glitches (a buffer underrun, a stalled audio thread) shift everything after
 * them; a local anchor follows that shift instead of misjudging the rest of
 * the pass. Notes not reached yet use the most recent samples.
 */
function localAnchor(pass: Pass, tick: number): number | null {
  const s = pass.samples;
  if (s.length === 0) return null;
  const t = Math.min(Math.max(tick, s[0].tick), s[s.length - 1].tick);
  const lo = lowerBound(s, t - LOCAL_ANCHOR_TICKS);
  const hi = lowerBound(s, t + LOCAL_ANCHOR_TICKS + 1);
  if (hi - lo >= MIN_LOCAL_SAMPLES) return lowPercentile(s.slice(lo, hi).map((x) => x.anchor));
  const mid = lowerBound(s, t);
  const from = Math.max(0, Math.min(mid - MIN_LOCAL_SAMPLES, s.length - 2 * MIN_LOCAL_SAMPLES));
  return lowPercentile(s.slice(from, from + 2 * MIN_LOCAL_SAMPLES).map((x) => x.anchor));
}

/**
 * Follows playback and the microphone, splits playback into loop passes and
 * judges each pass.
 *
 * Time base: alphaTab's position events tell when each tick played on the
 * performance.now() clock. Every expected onset is placed at the time implied
 * by the positions around its tick (plus the tempo map and playback speed);
 * detections are shifted by the calibrated latency onto the same clock. A
 * loop wrap (a seek back to the range start after reaching its end) closes
 * the pass; it is scored once late detections can no longer arrive. Any other
 * seek, or stopping, closes the pass as partial.
 *
 * No DOM, no audio: driven entirely by the inputs below, so it can be tested
 * with synthetic clocks.
 */
export class PracticeSession {
  readonly live = new Emitter<LiveUpdate>();
  readonly passFinished = new Emitter<PassReport>();

  private passes: Pass[] = [];
  private current: Pass | null = null;
  private detections: StoredDetection[] = [];
  private consumed = new Set<number>();
  private nextDetectionId = 0;
  private passCount = 0;

  constructor(readonly config: SessionConfig) {}

  /** Feed every alphaTab position event. */
  onPosition(p: PositionSample): void {
    const { range } = this.config;
    const cur = this.current;

    if (p.isSeek) {
      const span = range.endTick - range.startTick;
      const isWrap =
        cur !== null &&
        Math.abs(p.tick - range.startTick) <= SEEK_TOLERANCE_TICKS &&
        cur.lastTick >= range.startTick + span / 2;
      this.closeCurrent(p.perfMs, !isWrap);
      // The pass starts now, but seek events don't reflect audible audio yet:
      // they are not used as samples.
      this.current = this.openPass(p.tick);
      return;
    }

    if (!cur) {
      this.current = this.openPass(p.tick);
    } else if (p.tick < cur.lastTick - (range.endTick - range.startTick) / 2) {
      // Wrapped without a seek flag: treat like a loop wrap.
      this.closeCurrent(p.perfMs, false);
      this.current = this.openPass(range.startTick);
    }

    const pass = this.current!;
    if (p.tick < pass.fromTick || p.tick > range.endTick || p.tick < pass.lastTick) return;
    const { tempo, speed } = this.config;
    const elapsed = (tempo.tickToMs(p.tick) - tempo.tickToMs(pass.fromTick)) / speed;
    pass.samples.push({ tick: p.tick, anchor: p.perfMs - elapsed });
    pass.lastTick = p.tick;
  }

  /** Feed every detected note. */
  onNote(n: HeardNote): void {
    this.detections.push({
      id: this.nextDetectionId++,
      perfMs: n.perfMs - this.config.latencyMs,
      pitches: n.pitches,
      confidence: n.confidence,
    });
  }

  /** Playback paused or stopped. */
  onStopped(perfMs: number): void {
    this.closeCurrent(perfMs, true);
  }

  /**
   * Call periodically (e.g. every 100 ms). Finalizes passes whose grace
   * period is over and publishes the live state of the current pass.
   */
  update(nowPerf: number): void {
    const grace = this.config.match.outerWindowMs + DETECTION_DELAY_MS + 100;
    for (const pass of [...this.passes]) {
      if (pass.closedAtPerf !== null && nowPerf >= pass.closedAtPerf + grace) this.finalize(pass);
    }

    const cur = this.current;
    const origin = cur ? passAnchor(cur) : null;
    if (cur && origin !== null) {
      const expected = this.expectedFor(cur, origin);
      const nowMs = nowPerf - origin - DETECTION_DELAY_MS;
      const result = matchEvents(expected, this.detectionsFor(expected, origin), this.config.match, nowMs);
      this.live.emit({ passIndex: cur.index, events: cur.events, results: result.results });
    }
  }

  private openPass(fromTick: number): Pass {
    const { range, timeline } = this.config;
    const start = Math.max(range.startTick, Math.min(fromTick, range.endTick));
    const first = Math.max(range.startTick, start - SEEK_TOLERANCE_TICKS);
    const pass: Pass = {
      index: ++this.passCount,
      fromTick: start,
      events: timeline.filter((e) => e.tick >= first && e.tick < range.endTick),
      samples: [],
      lastTick: start,
      closedAtPerf: null,
      partial: false,
    };
    this.passes.push(pass);
    return pass;
  }

  private closeCurrent(perfMs: number, partial: boolean): void {
    const pass = this.current;
    this.current = null;
    if (!pass) return;
    if (pass.samples.length === 0) {
      this.passes = this.passes.filter((p) => p !== pass);
      return;
    }
    pass.closedAtPerf = perfMs;
    const { startTick, endTick } = this.config.range;
    const startedLate = pass.fromTick > startTick + SEEK_TOLERANCE_TICKS;
    // Only judge what was actually reached.
    if (partial) pass.events = pass.events.filter((e) => e.tick <= pass.lastTick);
    pass.partial = startedLate || (partial && pass.lastTick < endTick - END_TOLERANCE_TICKS);
  }

  /** Expected onsets, in ms relative to `origin` (a performance.now() time). */
  private expectedFor(pass: Pass, origin: number): ExpectedEvent[] {
    const { tempo, speed } = this.config;
    const t0 = tempo.tickToMs(pass.fromTick);
    return pass.events.map((e) => ({
      id: e.id,
      pitches: e.pitches,
      timeMs: (localAnchor(pass, e.tick) ?? origin) + (tempo.tickToMs(e.tick) - t0) / speed - origin,
    }));
  }

  /** Unconsumed detections near the expected onsets, in ms relative to `origin`. */
  private detectionsFor(expected: readonly ExpectedEvent[], origin: number): DetectedEvent[] {
    if (expected.length === 0) return [];
    const margin = this.config.match.outerWindowMs + 50;
    const first = expected[0].timeMs - margin;
    const last = expected[expected.length - 1].timeMs + margin;
    const out: DetectedEvent[] = [];
    for (const d of this.detections) {
      if (this.consumed.has(d.id)) continue;
      const t = d.perfMs - origin;
      if (t >= first && t <= last) out.push({ id: d.id, timeMs: t, pitches: d.pitches, confidence: d.confidence });
    }
    return out;
  }

  private finalize(pass: Pass): void {
    this.passes = this.passes.filter((p) => p !== pass);
    const origin = passAnchor(pass);
    if (origin === null || pass.events.length === 0) return;

    const expected = this.expectedFor(pass, origin);
    const result = matchEvents(expected, this.detectionsFor(expected, origin), this.config.match);
    // A detection judged here can't also count for the next pass.
    for (const r of result.results) if (r.detectedId !== undefined) this.consumed.add(r.detectedId);

    // Forget detections that no later pass can use.
    const horizon = origin + expected[expected.length - 1].timeMs - 5000;
    this.detections = this.detections.filter((d) => d.perfMs >= horizon);
    const alive = new Set(this.detections.map((d) => d.id));
    for (const id of this.consumed) if (!alive.has(id)) this.consumed.delete(id);

    this.passFinished.emit({
      index: pass.index,
      events: pass.events,
      results: result.results,
      score: scorePass(result),
      partial: pass.partial,
      speed: this.config.speed,
    });
  }
}
