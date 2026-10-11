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
      this.rebuildNoteBoxes();
      this.rendered.emit();
    });
    this.api.playerReady.on(() => this.playerReady.emit());
    this.api.midiLoaded.on(() => {
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
    this.api.renderScore(score, [trackIndex]);
  }

  selectTrack(trackIndex: number): void {
    const track = this.score?.tracks[trackIndex];
    if (!track) return;
    this.trackIndex = trackIndex;
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
      const playbackRange = new synth.PlaybackRange();
      playbackRange.startTick = range.startTick;
      playbackRange.endTick = range.endTick;
      this.api.playbackRange = playbackRange;
      this.api.isLooping = true;
      this.api.tickPosition = range.startTick;
    } else {
      this.api.playbackRange = null;
      this.api.isLooping = false;
      this.api.clearPlaybackRangeHighlight();
    }
  }

  /** Mute/unmute the practiced track and set the volume of the others. */
  setMix(muteOwnTrack: boolean, backingVolume: number): void {
    const score = this.score;
    if (!score) return;
    const own = score.tracks[this.trackIndex];
    const others = score.tracks.filter((t) => t !== own);
    if (own) this.api.changeTrackMute([own], muteOwnTrack);
    if (others.length) this.api.changeTrackVolume(others, backingVolume);
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
