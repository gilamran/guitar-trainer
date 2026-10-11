import type { midi, model } from '@coderline/alphatab';
import { MicInput } from '../audio/mic-input';
import { type LevelReading, MonoNoteDetector } from '../audio/note-detector';
import { type PassReport, PracticeSession } from '../practice/session';
import { parseScore, readScoreFile, SCORE_ACCEPT } from '../score/formats';
import { defaultTrackIndex, isPracticeTrack, ScoreView } from '../score/score-view';
import type { TempoMap } from '../score/tempo-map';
import {
  barRangeToTicks,
  buildTrackTimeline,
  type TickRange,
  ticksToBarRange,
  tempoMapFromLookup,
  type TimelineEvent,
} from '../score/timeline';
import {
  type AppSettings,
  loadSettings,
  matchOptionsFrom,
  sanitizeSettings,
  saveSettings,
  trackerOptionsFrom,
} from '../settings';
import { CalibrationDialog } from './calibration-dialog';
import { byId, isPressed, isTypingTarget, setPressed } from './dom';
import { renderIcons, setIcon } from './icons';
import { PassHistory } from './pass-history';
import { SettingsDialog } from './settings-dialog';
import { toast } from './toast';
import { VerdictOverlay } from './verdict-overlay';

const DEFAULT_LOOP_BARS = 4;
const SESSION_TICK_MS = 100;

const clampInt = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(v) ? Math.round(v) : min));

/** Top-level controller: wires score view, audio input, practice session and controls. */
export class App {
  private settings: AppSettings = loadSettings();
  private view: ScoreView | null = null;
  private overlay: VerdictOverlay | null = null;
  private score: model.Score | null = null;
  private lookup: midi.MidiTickLookup | null = null;
  private tempo: TempoMap | null = null;
  private timeline: TimelineEvent[] = [];
  private appliedLoop: TickRange | null = null;
  private session: PracticeSession | null = null;
  private livePass = -1;

  private readonly mic = new MicInput();
  private readonly detector = new MonoNoteDetector(trackerOptionsFrom(this.settings));
  private listening = false;
  private micForCalibration = false;
  private bannerDismissed = false;
  private wakeLock: WakeLockSentinel | null = null;

  private readonly ui = {
    fileInput: byId<HTMLInputElement>('file-input'),
    openBtn: byId<HTMLButtonElement>('open-btn'),
    settingsBtn: byId<HTMLButtonElement>('settings-btn'),
    trackField: byId('track-field'),
    trackSelect: byId<HTMLSelectElement>('track-select'),
    songTitle: byId('song-title'),
    banner: byId('calibrate-banner'),
    empty: byId('empty-state'),
    scoreScroll: byId('score-scroll'),
    alphaTab: byId('alphatab'),
    verdictLayer: byId('verdict-layer'),
    zoom: byId('zoom'),
    loading: byId('loading'),
    loadingText: byId('loading-text'),
    results: byId('results'),
    transport: byId('transport'),
    playBtn: byId<HTMLButtonElement>('play-btn'),
    stopBtn: byId<HTMLButtonElement>('stop-btn'),
    barFrom: byId<HTMLInputElement>('bar-from'),
    barTo: byId<HTMLInputElement>('bar-to'),
    loopBtn: byId<HTMLButtonElement>('loop-btn'),
    speed: byId<HTMLInputElement>('speed'),
    speedValue: byId<HTMLOutputElement>('speed-value'),
    countInBtn: byId<HTMLButtonElement>('countin-btn'),
    metronomeBtn: byId<HTMLButtonElement>('metronome-btn'),
    myPartBtn: byId<HTMLButtonElement>('mypart-btn'),
    listenBtn: byId<HTMLButtonElement>('listen-btn'),
    meterFill: byId('meter-fill'),
    meterGate: byId('meter-gate'),
    dropOverlay: byId('drop-overlay'),
  };

  private readonly history = new PassHistory(byId('pass-latest'), byId('pass-history'));

  private readonly settingsDialog = new SettingsDialog(
    byId<HTMLDialogElement>('settings-dialog'),
    () => this.settings,
    (patch) => this.updateSettings(patch),
    () => this.calibrationDialog.open(),
  );

  private readonly calibrationDialog = new CalibrationDialog(byId<HTMLDialogElement>('calibration-dialog'), {
    acquire: async () => {
      const wasRunning = this.mic.running;
      await this.startMic();
      this.micForCalibration = !wasRunning;
      return { mic: this.mic, detector: this.detector };
    },
    release: () => {
      if (this.micForCalibration && !this.listening) void this.stopMic();
      this.micForCalibration = false;
    },
    beforeStart: () => this.view?.pause(),
    save: (estimate) => {
      this.updateSettings({
        latencyMs: Math.round(estimate.latencyMs),
        latencyCalibratedAt: new Date().toISOString(),
      });
      this.settingsDialog.fill();
      toast(`Latency saved: ${Math.round(estimate.latencyMs)} ms`, 'success');
    },
  });

  constructor() {
    renderIcons();
    this.ui.fileInput.accept = SCORE_ACCEPT;
    this.bindControls();
    this.bindDragAndDrop();
    this.syncControlsFromSettings();

    this.detector.notes.on((n) => this.session?.onNote(n));
    this.detector.levels.on((l) => this.renderMeter(l));
    window.setInterval(() => this.session?.update(performance.now()), SESSION_TICK_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.view?.isPlaying) void this.holdWakeLock(true);
    });
  }

  // ---------------------------------------------------------------- files

  private async openFile(file: File): Promise<void> {
    try {
      this.showLoading('Reading file…');
      const score = parseScore(await readScoreFile(file));
      if (!score.title) score.title = file.name.replace(/\.[^.]+$/, '');
      this.showScore(score);
    } catch (err) {
      this.hideLoading();
      toast(err instanceof Error ? err.message : String(err), 'error', 8000);
    }
  }

  private showScore(score: model.Score): void {
    this.ui.empty.hidden = true;
    this.ui.scoreScroll.hidden = false;
    this.ui.transport.hidden = false;
    this.ui.results.hidden = false;
    this.ui.zoom.hidden = false;
    this.ui.trackField.hidden = false;
    this.ui.songTitle.hidden = false;

    const view = this.ensureView();
    view.stop();
    this.session = null;
    this.score = score;
    this.lookup = null;
    this.tempo = null;
    this.timeline = [];
    this.appliedLoop = null;
    this.overlay?.clear();
    this.history.reset();

    const trackIndex = defaultTrackIndex(score);
    this.renderTrackOptions(score, trackIndex);
    this.ui.songTitle.textContent = [score.title, score.artist].filter(Boolean).join(' — ');
    const bars = score.masterBars.length;
    this.ui.barFrom.max = this.ui.barTo.max = String(bars);
    this.ui.barFrom.value = '1';
    this.ui.barTo.value = String(Math.min(DEFAULT_LOOP_BARS, bars));
    this.updateBanner();

    this.showLoading('Rendering…');
    view.showScore(score, trackIndex);
  }

  private ensureView(): ScoreView {
    if (this.view) return this.view;
    const view = new ScoreView(this.ui.alphaTab, this.ui.scoreScroll);
    this.view = view;
    this.overlay = new VerdictOverlay(this.ui.verdictLayer, view);
    view.speed = this.settings.speed;
    view.countIn = this.settings.countIn;
    view.metronome = this.settings.metronome;

    view.rendered.on(() => this.hideLoading());
    view.midiLoaded.on((lookup) => {
      this.lookup = lookup;
      this.tempo = tempoMapFromLookup(lookup);
      this.timeline = buildTrackTimeline(lookup, view.selectedTrackIndex);
      this.applyRange();
    });
    view.playerReady.on(() => {
      this.ui.playBtn.disabled = false;
      this.applyMix();
    });
    view.position.on((p) => this.session?.onPosition(p));
    view.playingChanged.on((playing) => {
      setIcon(this.ui.playBtn, playing ? 'pause' : 'play');
      this.ui.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      if (!playing) this.session?.onStopped(performance.now());
      void this.holdWakeLock(playing);
    });
    view.rangeSelected.on((range) => this.onRangeSelected(range));
    view.error.on((e) => {
      this.hideLoading();
      toast(`Score error: ${e.message}`, 'error', 8000);
    });
    return view;
  }

  private renderTrackOptions(score: model.Score, selected: number): void {
    this.ui.trackSelect.replaceChildren(
      ...score.tracks.map((t) => {
        const opt = new Option(`${t.index + 1}. ${t.name || 'Track'}`, String(t.index), false, t.index === selected);
        opt.disabled = !isPracticeTrack(t);
        return opt;
      }),
    );
  }

  // ---------------------------------------------------------------- range

  private readBars(): { from: number; to: number } {
    const n = this.score?.masterBars.length ?? 1;
    let from = clampInt(this.ui.barFrom.valueAsNumber, 1, n);
    let to = clampInt(this.ui.barTo.valueAsNumber, 1, n);
    if (to < from) [from, to] = [to, from];
    this.ui.barFrom.value = String(from);
    this.ui.barTo.value = String(to);
    return { from: from - 1, to: to - 1 };
  }

  private practiceRange(): TickRange | null {
    const lookup = this.lookup;
    if (!lookup || lookup.masterBars.length === 0) return null;
    if (this.appliedLoop) return this.appliedLoop;
    return { startTick: lookup.masterBars[0].start, endTick: lookup.masterBars[lookup.masterBars.length - 1].end };
  }

  private rangeLabel(): string {
    if (!this.appliedLoop) return 'whole song';
    const { from, to } = this.readBars();
    return from === to ? `bar ${from + 1}` : `bars ${from + 1}–${to + 1}`;
  }

  /** Pushes the bar inputs + loop toggle to the player and restarts judging. */
  private applyRange(): void {
    const view = this.view;
    const lookup = this.lookup;
    if (!view || !lookup) return;
    const { from, to } = this.readBars();
    const range = isPressed(this.ui.loopBtn) ? barRangeToTicks(lookup, from, to) : null;
    this.appliedLoop = range;
    view.setLoop(range);
    if (range) view.highlightBars(from, to);
    else view.clearHighlight();
    this.rebuildSession();
  }

  /** The user drag-selected beats in the score: snap to whole bars and loop them. */
  private onRangeSelected(range: TickRange | null): void {
    if (!range || !this.lookup) return;
    const a = this.appliedLoop;
    if (a && a.startTick === range.startTick && a.endTick === range.endTick) return; // our own update
    const bars = ticksToBarRange(this.lookup, range);
    if (!bars) return;
    this.ui.barFrom.value = String(bars.fromBar + 1);
    this.ui.barTo.value = String(bars.toBar + 1);
    setPressed(this.ui.loopBtn, true);
    this.applyRange();
  }

  // ---------------------------------------------------------------- judging

  private rebuildSession(): void {
    this.session = null;
    this.livePass = -1;
    this.overlay?.clear();
    const range = this.practiceRange();
    if (!this.listening || !this.tempo || !range) return;

    const label = this.rangeLabel();
    const session = new PracticeSession({
      range,
      timeline: this.timeline,
      tempo: this.tempo,
      speed: this.settings.speed,
      latencyMs: this.settings.latencyMs ?? 0,
      match: matchOptionsFrom(this.settings),
    });
    session.live.on((u) => {
      if (u.passIndex !== this.livePass) {
        this.overlay?.clear();
        this.livePass = u.passIndex;
      }
      this.overlay?.show(
        u.events,
        u.results.map((r) => r.verdict),
      );
    });
    session.passFinished.on((report: PassReport) => {
      if (report.score.total > 0) this.history.add({ report, label });
    });
    this.session = session;
  }

  private async startMic(): Promise<void> {
    if (!this.mic.running) await this.mic.start();
    if (!this.detector.running) this.detector.start(this.mic);
  }

  private async stopMic(): Promise<void> {
    this.detector.stop();
    await this.mic.stop();
    this.renderMeter({ levelDb: -120, gateDb: -120 });
  }

  private async toggleListen(): Promise<void> {
    if (this.listening) {
      this.listening = false;
      setPressed(this.ui.listenBtn, false);
      this.session = null;
      this.overlay?.clear();
      if (!this.micForCalibration) await this.stopMic();
      return;
    }
    try {
      await this.startMic();
      this.listening = true;
      setPressed(this.ui.listenBtn, true);
      this.rebuildSession();
      if (this.settings.playMyPart) {
        toast('Tip: use headphones, or switch off “My part”, so the mic only hears your guitar.', 'info', 7000);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error', 8000);
    }
  }

  private renderMeter({ levelDb, gateDb }: LevelReading): void {
    const pct = (db: number) => `${Math.min(100, Math.max(0, ((db + 70) / 70) * 100))}%`;
    this.ui.meterFill.style.width = pct(levelDb);
    this.ui.meterGate.style.left = pct(gateDb);
    this.ui.meterFill.classList.toggle('active', levelDb >= gateDb);
  }

  // ---------------------------------------------------------------- settings

  private updateSettings(patch: Partial<AppSettings>): void {
    const prev = this.settings;
    this.settings = sanitizeSettings({ ...prev, ...patch });
    saveSettings(this.settings);
    const changed = (k: keyof AppSettings) => prev[k] !== this.settings[k];

    if (changed('onsetSensitivity')) this.detector.configure(trackerOptionsFrom(this.settings));
    if (changed('playMyPart') || changed('backingVolume')) this.applyMix();
    if (
      changed('speed') ||
      changed('latencyMs') ||
      changed('timingWindowMs') ||
      changed('pitchToleranceCents') ||
      changed('chordPolicy')
    ) {
      this.rebuildSession();
    }
    this.updateBanner();
  }

  private syncControlsFromSettings(): void {
    const s = this.settings;
    this.ui.speed.value = String(Math.round(s.speed * 100));
    this.ui.speedValue.value = `${Math.round(s.speed * 100)}%`;
    setPressed(this.ui.countInBtn, s.countIn);
    setPressed(this.ui.metronomeBtn, s.metronome);
    setPressed(this.ui.myPartBtn, s.playMyPart);
  }

  private applyMix(): void {
    this.view?.setMix(!this.settings.playMyPart, this.settings.backingVolume);
  }

  private updateBanner(): void {
    this.ui.banner.hidden = this.bannerDismissed || this.settings.latencyMs !== null || !this.score;
  }

  // ---------------------------------------------------------------- controls

  private togglePlay(): void {
    const view = this.view;
    if (!view || this.ui.playBtn.disabled) return;
    if (view.isPlaying) view.pause();
    else view.play();
  }

  private bindControls(): void {
    const ui = this.ui;
    const openPicker = () => ui.fileInput.click();
    ui.openBtn.addEventListener('click', openPicker);
    document.querySelector('[data-action="open"]')?.addEventListener('click', openPicker);
    ui.fileInput.addEventListener('change', () => {
      const file = ui.fileInput.files?.[0];
      ui.fileInput.value = '';
      if (file) void this.openFile(file);
    });

    ui.settingsBtn.addEventListener('click', () => this.settingsDialog.open());
    ui.banner.querySelector('[data-action="calibrate"]')!.addEventListener('click', () => this.calibrationDialog.open());
    ui.banner.querySelector('[data-action="dismiss"]')!.addEventListener('click', () => {
      this.bannerDismissed = true;
      this.updateBanner();
    });

    ui.trackSelect.addEventListener('change', () => {
      const view = this.view;
      if (!view) return;
      view.selectTrack(Number(ui.trackSelect.value));
      if (this.lookup) this.timeline = buildTrackTimeline(this.lookup, view.selectedTrackIndex);
      this.history.reset();
      this.applyMix();
      this.applyRange();
    });

    ui.playBtn.addEventListener('click', () => this.togglePlay());
    ui.stopBtn.addEventListener('click', () => this.view?.stop());

    for (const input of [ui.barFrom, ui.barTo]) input.addEventListener('change', () => this.applyRange());
    ui.loopBtn.addEventListener('click', () => {
      setPressed(ui.loopBtn, !isPressed(ui.loopBtn));
      this.applyRange();
    });

    ui.speed.addEventListener('input', () => {
      const speed = Number(ui.speed.value) / 100;
      ui.speedValue.value = `${ui.speed.value}%`;
      if (this.view) this.view.speed = speed;
    });
    ui.speed.addEventListener('change', () => this.updateSettings({ speed: Number(ui.speed.value) / 100 }));

    ui.countInBtn.addEventListener('click', () => {
      const on = !isPressed(ui.countInBtn);
      setPressed(ui.countInBtn, on);
      if (this.view) this.view.countIn = on;
      this.updateSettings({ countIn: on });
    });
    ui.metronomeBtn.addEventListener('click', () => {
      const on = !isPressed(ui.metronomeBtn);
      setPressed(ui.metronomeBtn, on);
      if (this.view) this.view.metronome = on;
      this.updateSettings({ metronome: on });
    });
    ui.myPartBtn.addEventListener('click', () => {
      const on = !isPressed(ui.myPartBtn);
      setPressed(ui.myPartBtn, on);
      this.updateSettings({ playMyPart: on });
    });
    ui.listenBtn.addEventListener('click', () => void this.toggleListen());

    ui.zoom.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach((b) =>
      b.addEventListener('click', () => {
        const view = this.view;
        if (!view) return;
        view.zoom = Math.min(1.6, Math.max(0.5, Math.round((view.zoom + Number(b.dataset.zoom) * 0.1) * 10) / 10));
      }),
    );

    document.addEventListener('keydown', (e) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.togglePlay();
      } else if (e.key === 'l' || e.key === 'L') {
        ui.loopBtn.click();
      }
    });
  }

  private bindDragAndDrop(): void {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      depth++;
      this.ui.dropOverlay.hidden = false;
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) this.ui.dropOverlay.hidden = true;
    });
    window.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      this.ui.dropOverlay.hidden = true;
      const file = e.dataTransfer?.files[0];
      if (file) void this.openFile(file);
    });
  }

  // ---------------------------------------------------------------- misc

  private showLoading(text: string): void {
    this.ui.loadingText.textContent = text;
    this.ui.loading.hidden = false;
  }

  private hideLoading(): void {
    this.ui.loading.hidden = true;
  }

  /** Keep the phone screen on while playing. */
  private async holdWakeLock(hold: boolean): Promise<void> {
    try {
      if (hold && !this.wakeLock && 'wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => (this.wakeLock = null));
      } else if (!hold && this.wakeLock) {
        await this.wakeLock.release();
        this.wakeLock = null;
      }
    } catch {
      // Not supported or not allowed (e.g. page hidden) — harmless.
    }
  }
}
