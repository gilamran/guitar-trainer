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

interface Pass {
  readonly index: number;
  readonly fromTick: number;
  events: TimelineEvent[];
  expected: ExpectedEvent[];
  /** Estimates of performance.now() at `fromTick`, one per position sample. */
  readonly anchorEstimates: number[];
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

/** Stopping within this many ticks of the range end still counts as a full pass. */
const END_TOLERANCE_TICKS = PPQ / 2;

/** Low percentile: positions arrive late but never early, so the earliest estimates are best. */
function anchorOf(pass: Pass): number | null {
  const a = pass.anchorEstimates;
  if (a.length === 0) return null;
  const sorted = [...a].sort((x, y) => x - y);
  return sorted[Math.floor((sorted.length - 1) * 0.1)];
}

/**
 * Follows playback and the microphone, splits playback into loop passes and
 * judges each pass.
 *
 * Time base: every pass is anchored to the performance.now() time at which
 * its first tick played, estimated from alphaTab's position events. Expected
 * onsets are placed relative to that anchor with the tempo map and playback
 * speed; detections are shifted by the calibrated latency and placed on the
 * same axis. A loop wrap (a seek back to the range start after reaching its
 * end) closes the pass; it is scored once late detections can no longer
 * arrive. Any other seek, or stopping, closes the pass as partial.
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
        Math.abs(p.tick - range.startTick) <= 1 &&
        cur.lastTick >= range.startTick + span / 2;
      this.closeCurrent(p.perfMs, !isWrap);
      // The pass starts now, but seek events don't reflect audible audio yet:
      // they are not used for the anchor.
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
    if (p.tick < pass.fromTick || p.tick > range.endTick) return;
    const { tempo, speed } = this.config;
    const elapsed = (tempo.tickToMs(p.tick) - tempo.tickToMs(pass.fromTick)) / speed;
    pass.anchorEstimates.push(p.perfMs - elapsed);
    pass.lastTick = Math.max(pass.lastTick, p.tick);
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
    const anchor = cur ? anchorOf(cur) : null;
    if (cur && anchor !== null) {
      const nowMs = nowPerf - anchor - DETECTION_DELAY_MS;
      const result = matchEvents(cur.expected, this.detectionsFor(cur, anchor), this.config.match, nowMs);
      this.live.emit({ passIndex: cur.index, events: cur.events, results: result.results });
    }
  }

  private openPass(fromTick: number): Pass {
    const { range, timeline, tempo, speed } = this.config;
    const start = Math.max(range.startTick, Math.min(fromTick, range.endTick));
    const events = timeline.filter((e) => e.tick >= start && e.tick < range.endTick);
    const t0 = tempo.tickToMs(start);
    const pass: Pass = {
      index: ++this.passCount,
      fromTick: start,
      events,
      expected: events.map((e) => ({ id: e.id, timeMs: (tempo.tickToMs(e.tick) - t0) / speed, pitches: e.pitches })),
      anchorEstimates: [],
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
    if (pass.anchorEstimates.length === 0) {
      this.passes = this.passes.filter((p) => p !== pass);
      return;
    }
    pass.closedAtPerf = perfMs;
    if (partial) {
      // Only judge what was actually reached.
      const keep = pass.events.map((e) => e.tick <= pass.lastTick);
      pass.events = pass.events.filter((_, i) => keep[i]);
      pass.expected = pass.expected.filter((_, i) => keep[i]);
      pass.partial = pass.lastTick < this.config.range.endTick - END_TOLERANCE_TICKS;
    }
  }

  private detectionsFor(pass: Pass, anchor: number): DetectedEvent[] {
    if (pass.expected.length === 0) return [];
    const margin = this.config.match.outerWindowMs + 50;
    const first = pass.expected[0].timeMs - margin;
    const last = pass.expected[pass.expected.length - 1].timeMs + margin;
    const out: DetectedEvent[] = [];
    for (const d of this.detections) {
      if (this.consumed.has(d.id)) continue;
      const t = d.perfMs - anchor;
      if (t >= first && t <= last) out.push({ id: d.id, timeMs: t, pitches: d.pitches, confidence: d.confidence });
    }
    return out;
  }

  private finalize(pass: Pass): void {
    this.passes = this.passes.filter((p) => p !== pass);
    const anchor = anchorOf(pass);
    if (anchor === null || pass.expected.length === 0) return;

    const result = matchEvents(pass.expected, this.detectionsFor(pass, anchor), this.config.match);
    // A detection judged here can't also count for the next pass.
    for (const r of result.results) if (r.detectedId !== undefined) this.consumed.add(r.detectedId);

    // Forget detections that no later pass can use.
    const horizon = anchor + pass.expected[pass.expected.length - 1].timeMs - 5000;
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
