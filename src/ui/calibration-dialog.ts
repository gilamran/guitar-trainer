import {
  DEFAULT_CALIBRATION_PLAN,
  type LatencyEstimate,
  runLatencyCalibration,
} from '../audio/calibration';
import type { MicInput } from '../audio/mic-input';
import type { NoteDetector } from '../audio/note-detector';
import { el } from './dom';

export interface CalibrationDeps {
  /** Starts (if needed) and returns the microphone + detector. Called from the Start click. */
  acquire(): Promise<{ mic: MicInput; detector: NoteDetector }>;
  /** Called when the dialog closes, to stop the mic again if it was only started for this. */
  release(): void;
  /** Stop playback etc. before clicks are played. */
  beforeStart(): void;
  save(estimate: LatencyEstimate): void;
}

/** "Clap on the click" latency calibration flow. */
export class CalibrationDialog {
  private readonly beats: HTMLElement;
  private readonly status: HTMLElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly saveBtn: HTMLButtonElement;
  private abort: AbortController | null = null;
  private result: LatencyEstimate | null = null;

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly deps: CalibrationDeps,
  ) {
    this.beats = dialog.querySelector('#calib-beats')!;
    this.status = dialog.querySelector('#calib-status')!;
    this.startBtn = dialog.querySelector('#calib-start')!;
    this.saveBtn = dialog.querySelector('#calib-save')!;

    this.startBtn.addEventListener('click', () => void this.start());
    this.saveBtn.addEventListener('click', () => {
      if (this.result) this.deps.save(this.result);
      this.dialog.close();
    });
    dialog.querySelectorAll('[data-action="close"]').forEach((b) => b.addEventListener('click', () => dialog.close()));
    dialog.addEventListener('close', () => {
      this.abort?.abort();
      this.deps.release();
    });
  }

  open(): void {
    this.result = null;
    this.renderBeats(0);
    this.status.textContent = '';
    this.status.className = 'calib-status';
    this.startBtn.hidden = false;
    this.startBtn.disabled = false;
    this.startBtn.textContent = 'Start';
    this.saveBtn.hidden = true;
    this.dialog.showModal();
  }

  private renderBeats(active: number): void {
    const plan = DEFAULT_CALIBRATION_PLAN;
    const total = plan.countInClicks + plan.measuredClicks;
    this.beats.replaceChildren(
      ...Array.from({ length: total }, (_, i) => {
        const dot = el('span', `beat${i < plan.countInClicks ? ' count-in' : ''}${i < active ? ' done' : ''}${i === active - 1 ? ' now' : ''}`);
        return dot;
      }),
    );
  }

  private async start(): Promise<void> {
    this.startBtn.disabled = true;
    this.saveBtn.hidden = true;
    this.result = null;
    this.status.className = 'calib-status';
    try {
      const { mic, detector } = await this.deps.acquire();
      this.deps.beforeStart();
      this.abort = new AbortController();
      this.status.textContent = 'Get ready…';
      const estimate = await runLatencyCalibration(
        mic,
        detector,
        (p) => {
          this.renderBeats(p.click);
          this.status.textContent = p.countIn ? `Count-in ${p.click}…` : `Clap! ${p.click - DEFAULT_CALIBRATION_PLAN.countInClicks} / ${DEFAULT_CALIBRATION_PLAN.measuredClicks}`;
        },
        this.abort.signal,
      );
      this.abort = null;
      this.showResult(estimate);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      this.status.textContent = err instanceof Error ? err.message : String(err);
      this.status.className = 'calib-status error';
    } finally {
      this.startBtn.disabled = false;
      this.startBtn.textContent = 'Try again';
    }
  }

  private showResult(estimate: LatencyEstimate | null): void {
    if (!estimate) {
      this.status.textContent =
        'Not enough claps were heard. Move closer to the microphone, clap louder, or raise onset sensitivity in Settings.';
      this.status.className = 'calib-status error';
      return;
    }
    this.result = estimate;
    const shaky = estimate.spreadMs > 35;
    this.status.textContent =
      `Latency ${Math.round(estimate.latencyMs)} ms (±${Math.round(estimate.spreadMs)} ms, ${estimate.used}/${estimate.total} clicks).` +
      (shaky ? ' Your claps varied a lot — consider trying again.' : '');
    this.status.className = `calib-status ${shaky ? 'warn' : 'ok'}`;
    this.saveBtn.hidden = false;
  }
}
