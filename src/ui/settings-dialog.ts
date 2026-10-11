import type { AppSettings } from '../settings';

type Patch = Partial<AppSettings>;

const FORMAT: Partial<Record<keyof AppSettings, (v: number) => string>> = {
  timingWindowMs: (v) => `±${v} ms`,
  pitchToleranceCents: (v) => `±${v}¢`,
  backingVolume: (v) => `${Math.round(v * 100)}%`,
};

/** Binds the settings <dialog> form to the app settings. */
export class SettingsDialog {
  private readonly form: HTMLFormElement;

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly getSettings: () => AppSettings,
    private readonly onChange: (patch: Patch) => void,
    onCalibrate: () => void,
  ) {
    this.form = dialog.querySelector('form')!;
    this.form.addEventListener('input', (e) => this.handleInput(e.target));
    this.form.addEventListener('change', (e) => this.handleInput(e.target));
    dialog.querySelector('[data-action="calibrate"]')!.addEventListener('click', () => {
      dialog.close();
      onCalibrate();
    });
    // Close when clicking the backdrop.
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
  }

  open(): void {
    this.fill();
    this.dialog.showModal();
  }

  /** Refresh the fields (e.g. after calibration saved a new latency). */
  fill(): void {
    const s = this.getSettings();
    for (const input of this.form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[name]')) {
      const key = input.name as keyof AppSettings;
      const value = s[key];
      input.value = value === null ? '' : String(value);
      this.updateOutput(input);
    }
    const note = this.form.querySelector('#latency-note')!;
    note.textContent =
      s.latencyMs === null
        ? 'not calibrated'
        : s.latencyCalibratedAt
          ? `calibrated ${new Date(s.latencyCalibratedAt).toLocaleDateString()}`
          : 'entered manually';
  }

  private handleInput(target: EventTarget | null): void {
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement) || !target.name) return;
    const key = target.name as keyof AppSettings;
    this.updateOutput(target);

    if (key === 'latencyMs') {
      const v = (target as HTMLInputElement).value.trim();
      const n = Number(v);
      if (v === '') this.onChange({ latencyMs: null, latencyCalibratedAt: null });
      else if (Number.isFinite(n)) this.onChange({ latencyMs: n, latencyCalibratedAt: null });
      return;
    }
    if (target instanceof HTMLSelectElement) {
      this.onChange({ [key]: target.value } as Patch);
    } else {
      this.onChange({ [key]: Number(target.value) } as Patch);
    }
  }

  private updateOutput(input: HTMLInputElement | HTMLSelectElement): void {
    const out = input.parentElement?.querySelector('output');
    const fmt = FORMAT[input.name as keyof AppSettings];
    if (out && fmt) out.textContent = fmt(Number(input.value));
  }
}
