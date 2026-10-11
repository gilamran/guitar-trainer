import {
  AlphaTabApi,
  LayoutMode,
  LogLevel,
  type model,
  PlayerMode,
  ScrollMode,
  Settings,
  StaveProfile,
  synth,
  type midi,
} from '@coderline/alphatab';
import { Emitter } from '../util/emitter';
import type { TickRange } from './timeline';

type Score = model.Score;
type Track = model.Track;

export interface PositionEvent {
  /** Playback tick (alphaTab API tick space). */
  readonly tick: number;
  /** Speed-adjusted playback time, ms. */
  readonly timeMs: number;
  readonly isSeek: boolean;
  /** performance.now() when the event reached the main thread. */
  readonly perfMs: number;
}

export interface NoteBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function toPlaybackRange(range: TickRange): synth.PlaybackRange {
  const r = new synth.PlaybackRange();
  r.startTick = range.startTick;
  r.endTick = range.endTick;
  return r;
}

/** Tracks a player can practice: anything with a melodic, stringed staff. */
export function isPracticeTrack(track: Track): boolean {
  return !track.isPercussion && track.staves.some((s) => s.isStringed && !s.isPercussion);
}

/** Best default track: first guitar-like track, else first practicable one. */
export function defaultTrackIndex(score: Score): number {
  const candidates = score.tracks.filter(isPracticeTrack);
  const guitar = candidates.find((t) => /guit|gtr/i.test(t.name) || t.staves[0]?.tuning.length === 6);
  return (guitar ?? candidates[0] ?? score.tracks[0])?.index ?? 0;
}

/**
 * Thin wrapper over alphaTab: rendering, track choice, transport, loop range,
 * speed, count-in, metronome, and a note-id → on-screen boxes lookup used to
 * colour notes. All alphaTab-specific knowledge lives here and in timeline.ts.
 */
export class ScoreView {
  readonly api: AlphaTabApi;

  readonly scoreLoaded = new Emitter<Score>();
  readonly rendered = new Emitter<void>();
  readonly playerReady = new Emitter<void>();
  readonly position = new Emitter<PositionEvent>();
  readonly playingChanged = new Emitter<boolean>();
  readonly rangeSelected = new Emitter<TickRange | null>();
  readonly midiLoaded = new Emitter<midi.MidiTickLookup>();
  readonly error = new Emitter<Error>();

  private trackIndex = 0;
  private noteBoxes = new Map<number, NoteBox[]>();
  /** Bars to highlight; (re)applied after every render because bounds change. */
  private highlight: { fromBar: number; toBar: number } | null = null;
  /** False between starting a render and its completion: bounds belong to the old layout. */
  private layoutCurrent = false;

  constructor(element: HTMLElement, scrollElement: HTMLElement) {
    const base = import.meta.env.BASE_URL;
    const settings = new Settings();
    settings.core.fontDirectory = `${base}font/`;
    settings.core.includeNoteBounds = true;
    settings.core.logLevel = LogLevel.Warning;
    settings.player.playerMode = PlayerMode.EnabledSynthesizer;
    settings.player.soundFont = `${base}soundfont/sonivox.sf2`;
    settings.player.scrollElement = scrollElement;
    settings.player.scrollMode = ScrollMode.Continuous;
    settings.player.enableCursor = true;
    settings.player.enableAnimatedBeatCursor = true;
    settings.player.enableUserInteraction = true;
    settings.display.layoutMode = LayoutMode.Page;
    settings.display.staveProfile = StaveProfile.ScoreTab;
    settings.display.scale = window.innerWidth < 640 ? 0.75 : 0.95;

    this.api = new AlphaTabApi(element, settings);
    this.api.metronomeVolume = 0;
    this.api.countInVolume = 0;

    this.api.scoreLoaded.on((s) => this.scoreLoaded.emit(s));
    this.api.postRenderFinished.on(() => {
      this.layoutCurrent = true;
      this.rebuildNoteBoxes();
      this.applyHighlight();
      this.rendered.emit();
    });
    this.api.playerReady.on(() => this.playerReady.emit());
    // midiLoad fires synchronously right after the tick cache is (re)built.
    this.api.midiLoad.on(() => {
      const lookup = this.api.tickCache;
      if (lookup) this.midiLoaded.emit(lookup);
    });
    this.api.playerPositionChanged.on((e) =>
      this.position.emit({
        tick: e.currentTick,
        timeMs: e.currentTime,
        isSeek: e.isSeek,
        perfMs: performance.now(),
      }),
    );
    this.api.playerStateChanged.on((e) => this.playingChanged.emit(e.state === synth.PlayerState.Playing));
    this.api.playbackRangeChanged.on((e) => {
      const r = e.playbackRange;
      this.rangeSelected.emit(r ? { startTick: r.startTick, endTick: r.endTick } : null);
    });
    this.api.error.on((e) => this.error.emit(e));
  }

  get score(): Score | null {
    return this.api.score;
  }

  get tickLookup(): midi.MidiTickLookup | null {
    return this.api.tickCache;
  }

  get selectedTrackIndex(): number {
    return this.trackIndex;
  }

  get isPlaying(): boolean {
    return this.api.playerState === synth.PlayerState.Playing;
  }

  get readyForPlayback(): boolean {
    return this.api.isReadyForPlayback;
  }

  showScore(score: Score, trackIndex = defaultTrackIndex(score)): void {
    this.trackIndex = trackIndex;
    this.noteBoxes.clear();
    this.highlight = null;
    this.beforeLayoutChange();
    this.api.renderScore(score, [trackIndex]);
  }

  selectTrack(trackIndex: number): void {
    const track = this.score?.tracks[trackIndex];
    if (!track) return;
    this.trackIndex = trackIndex;
    this.beforeLayoutChange();
    this.api.renderTracks([track]);
  }

  play(): void {
    this.api.play();
  }

  pause(): void {
    this.api.pause();
  }

  stop(): void {
    this.api.stop();
  }

  set speed(value: number) {
    this.api.playbackSpeed = value;
  }

  set countIn(enabled: boolean) {
    this.api.countInVolume = enabled ? 1 : 0;
  }

  set metronome(enabled: boolean) {
    this.api.metronomeVolume = enabled ? 1 : 0;
  }

  /** Loop `range` (or play everything when null) and move the cursor to its start. */
  setLoop(range: TickRange | null): void {
    if (range) {
      this.api.playbackRange = toPlaybackRange(range);
      this.api.isLooping = true;
      this.api.tickPosition = range.startTick;
    } else {
      this.api.playbackRange = null;
      this.api.isLooping = false;
    }
  }

  /**
   * Re-applies a loop after alphaTab dropped it (a plain click in the score
   * seeks and clears the playback range). Keeps the clicked position when it
   * lies inside the loop; setting a range alone would jump to its start.
   */
  restoreLoop(range: TickRange): void {
    const pos = this.api.tickPosition;
    this.api.playbackRange = toPlaybackRange(range);
    this.api.isLooping = true;
    this.api.tickPosition = pos >= range.startTick && pos < range.endTick ? pos : range.startTick;
    this.applyHighlight();
  }

  /** Mute/unmute the practiced track and set the volume of the others. */
  setMix(muteOwnTrack: boolean, backingVolume: number): void {
    const score = this.score;
    if (!score) return;
    const own = score.tracks[this.trackIndex];
    const others = score.tracks.filter((t) => t !== own);
    // Reset first: the practiced track may have changed since the last call.
    this.api.changeTrackMute(score.tracks, false);
    if (own) {
      this.api.changeTrackVolume([own], 1);
      if (muteOwnTrack) this.api.changeTrackMute([own], true);
    }
    if (others.length) this.api.changeTrackVolume(others, backingVolume);
  }

  /** Shows alphaTab's selection highlight over bars `fromBar`…`toBar` (0-based) of the practiced track. */
  highlightBars(fromBar: number, toBar: number): void {
    this.highlight = { fromBar, toBar };
    this.applyHighlight();
  }

  clearHighlight(): void {
    this.highlight = null;
    this.api.clearPlaybackRangeHighlight();
  }

  /**
   * alphaTab re-applies its stored selection after every render, and 1.8's
   * clearPlaybackRangeHighlight() only clears the drawing, not that stored
   * selection. If its beats are not part of the next layout (other score or
   * track), alphaTab throws. Reset the stored selection too.
   */
  private beforeLayoutChange(): void {
    this.layoutCurrent = false;
    this.api.clearPlaybackRangeHighlight();
    const internals = this.api as unknown as { _selectionStart?: unknown; _selectionEnd?: unknown };
    internals._selectionStart = undefined;
    internals._selectionEnd = undefined;
  }

  private applyHighlight(): void {
    const h = this.highlight;
    const lookup = this.api.boundsLookup;
    if (!h || !this.layoutCurrent || !lookup?.isFinished) return;
    const staff = this.score?.tracks[this.trackIndex]?.staves[0];
    const first = staff?.bars[h.fromBar]?.voices[0]?.beats[0];
    const lastBeats = staff?.bars[h.toBar]?.voices[0]?.beats;
    const last = lastBeats?.[lastBeats.length - 1];
    // Only once the new layout contains these beats (not the previous score's).
    if (!first || !last || !lookup.findBeat(first) || !lookup.findBeat(last)) return;
    try {
      this.api.highlightPlaybackRange(first, last);
    } catch {
      // Purely cosmetic; the loop itself is set via playbackRange.
    }
  }

  set zoom(scale: number) {
    this.api.settings.display.scale = scale;
    this.api.updateSettings();
    this.api.render();
  }

  get zoom(): number {
    return this.api.settings.display.scale;
  }

  /** On-screen boxes (relative to the alphaTab element) of a rendered note. */
  boxesForNote(noteId: number): readonly NoteBox[] {
    return this.noteBoxes.get(noteId) ?? [];
  }

  destroy(): void {
    this.api.destroy();
  }

  private rebuildNoteBoxes(): void {
    this.noteBoxes.clear();
    const lookup = this.api.boundsLookup;
    if (!lookup) return;
    for (const system of lookup.staffSystems) {
      for (const masterBar of system.bars) {
        for (const bar of masterBar.bars) {
          for (const beat of bar.beats) {
            for (const nb of beat.notes ?? []) {
              const b = nb.noteHeadBounds;
              const list = this.noteBoxes.get(nb.note.id) ?? [];
              list.push({ x: b.x, y: b.y, w: b.w, h: b.h });
              this.noteBoxes.set(nb.note.id, list);
            }
          }
        }
      }
    }
  }
}
