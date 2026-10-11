/** MIDI ticks per quarter note used by alphaTab. */
export const PPQ = 960;

export interface TempoChange {
  readonly tick: number;
  readonly bpm: number;
}

interface Segment {
  readonly tick: number;
  readonly bpm: number;
  /** Song time (ms at 100% speed) at `tick`. */
  readonly ms: number;
}

/**
 * Piecewise-constant tempo map: converts MIDI ticks in the playback timeline
 * (repeats unrolled) to song milliseconds at 100% speed and back.
 */
export class TempoMap {
  private readonly segments: Segment[];

  constructor(changes: readonly TempoChange[], private readonly ppq = PPQ) {
    const sorted = [...changes].filter((c) => c.bpm > 0).sort((a, b) => a.tick - b.tick);
    if (sorted.length === 0 || sorted[0].tick > 0) sorted.unshift({ tick: 0, bpm: sorted[0]?.bpm ?? 120 });

    this.segments = [];
    let ms = 0;
    for (const c of sorted) {
      const prev = this.segments[this.segments.length - 1];
      if (prev) {
        ms += this.ticksToMsAt(c.tick - prev.tick, prev.bpm);
        if (c.tick === prev.tick) {
          this.segments[this.segments.length - 1] = { tick: c.tick, bpm: c.bpm, ms: prev.ms };
          continue;
        }
      }
      this.segments.push({ tick: c.tick, bpm: c.bpm, ms });
    }
  }

  private ticksToMsAt(ticks: number, bpm: number): number {
    return (ticks * 60000) / (bpm * this.ppq);
  }

  private segmentForTick(tick: number): Segment {
    let lo = 0;
    let hi = this.segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.segments[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    return this.segments[lo];
  }

  tickToMs(tick: number): number {
    const s = this.segmentForTick(tick);
    return s.ms + this.ticksToMsAt(tick - s.tick, s.bpm);
  }

  msToTick(ms: number): number {
    let s = this.segments[0];
    for (const seg of this.segments) {
      if (seg.ms <= ms) s = seg;
      else break;
    }
    return s.tick + ((ms - s.ms) * s.bpm * this.ppq) / 60000;
  }

  bpmAt(tick: number): number {
    return this.segmentForTick(tick).bpm;
  }
}
