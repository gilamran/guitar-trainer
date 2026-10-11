import type { midi as alphaTabMidi, model } from '@coderline/alphatab';
import { TempoMap, type TempoChange } from './tempo-map';

type MidiTickLookup = alphaTabMidi.MidiTickLookup;
type Note = model.Note;

/** One onset of the practiced track in the playback timeline (repeats unrolled). */
export interface TimelineEvent {
  /** Unique per track timeline: the absolute tick. */
  readonly id: string;
  /** Absolute playback tick (alphaTab API tick space). */
  readonly tick: number;
  /** Sounding MIDI pitches starting at this tick, ascending, deduplicated. */
  readonly pitches: readonly number[];
  /** alphaTab note ids, for colouring the rendered notes. */
  readonly noteIds: readonly number[];
  /** Master bar index (0-based) the onset belongs to. */
  readonly barIndex: number;
}

export interface TickRange {
  readonly startTick: number;
  readonly endTick: number;
}

/** A note we can expect the player to articulate (and the detector to hear). */
function isPlayable(note: Note): boolean {
  return note.isVisible && !note.isTieDestination && !note.isDead && !note.isPercussion;
}

/**
 * Collects every onset of `trackIndex` from alphaTab's tick lookup, in
 * playback order. Repeated sections appear once per repetition; notes from
 * all voices/staves starting on the same tick are merged into one event
 * (a chord or double-stop). Tied continuations and dead notes are skipped.
 */
export function buildTrackTimeline(lookup: MidiTickLookup, trackIndex: number): TimelineEvent[] {
  const byTick = new Map<number, { pitches: Set<number>; noteIds: number[]; barIndex: number }>();

  for (const mb of lookup.masterBars) {
    for (let slice = mb.firstBeat; slice; slice = slice.nextBeat) {
      for (const item of slice.highlightedBeats) {
        const beat = item.beat;
        if (beat.voice.bar.staff.track.index !== trackIndex || beat.isRest) continue;
        const notes = beat.notes.filter(isPlayable);
        if (notes.length === 0) continue;

        const tick = mb.start + item.playbackStart;
        let entry = byTick.get(tick);
        if (!entry) {
          entry = { pitches: new Set(), noteIds: [], barIndex: mb.masterBar.index };
          byTick.set(tick, entry);
        }
        for (const n of notes) {
          // A beat spans several slices; only add each note once per onset.
          if (entry.noteIds.includes(n.id)) continue;
          entry.noteIds.push(n.id);
          entry.pitches.add(n.realValue);
        }
      }
      if (slice === mb.lastBeat) break;
    }
  }

  return [...byTick.entries()]
    .sort(([a], [b]) => a - b)
    .map(([tick, e]) => ({
      id: String(tick),
      tick,
      pitches: [...e.pitches].sort((a, b) => a - b),
      noteIds: e.noteIds,
      barIndex: e.barIndex,
    }));
}

/** Tempo map of the playback timeline, from the tempo changes alphaTab recorded per bar. */
export function tempoMapFromLookup(lookup: MidiTickLookup): TempoMap {
  const changes: TempoChange[] = [];
  for (const mb of lookup.masterBars) {
    for (const c of mb.tempoChanges) changes.push({ tick: c.tick, bpm: c.tempo });
  }
  return new TempoMap(changes);
}

/**
 * Tick range covering bars `fromBar`…`toBar` (0-based, inclusive) in playback
 * order: from the first time `fromBar` is played to the end of the first
 * `toBar` played after that. Returns null for an invalid range.
 */
export function barRangeToTicks(lookup: MidiTickLookup, fromBar: number, toBar: number): TickRange | null {
  const bars = lookup.masterBars;
  const start = bars.findIndex((mb) => mb.masterBar.index === fromBar);
  if (start < 0) return null;
  for (let i = start; i < bars.length; i++) {
    if (bars[i].masterBar.index === toBar) return { startTick: bars[start].start, endTick: bars[i].end };
  }
  return null;
}

/** Inverse of {@link barRangeToTicks}: bar indices touched by a tick range. */
export function ticksToBarRange(
  lookup: MidiTickLookup,
  range: TickRange,
): { fromBar: number; toBar: number } | null {
  const touched = lookup.masterBars.filter((mb) => mb.end > range.startTick && mb.start < range.endTick);
  if (touched.length === 0) return null;
  return { fromBar: touched[0].masterBar.index, toBar: touched[touched.length - 1].masterBar.index };
}

/** Events with `startTick ≤ tick < endTick`. */
export function eventsInRange(timeline: readonly TimelineEvent[], range: TickRange): TimelineEvent[] {
  return timeline.filter((e) => e.tick >= range.startTick && e.tick < range.endTick);
}
