import type { MicInput } from './mic-input';
import type { NoteDetector } from './note-detector';

export interface LatencyEstimate {
  /** Median delay from click to heard response, ms. */
  readonly latencyMs: number;
  /** Robust spread (1.4826 × MAD) of the accepted offsets, ms. */
  readonly spreadMs: number;
  /** Clicks with an accepted response. */
  readonly used: number;
  readonly total: number;
}

export interface EstimateOptions {
  /** Earliest accepted response relative to a click (players anticipate). */
  readonly minOffsetMs: number;
  /** Latest accepted response relative to a click. */
  readonly maxOffsetMs: number;
  /** Fewest accepted clicks for a valid estimate. */
  readonly minUsed: number;
}

export const DEFAULT_ESTIMATE_OPTIONS: EstimateOptions = {
  minOffsetMs: -80,
  maxOffsetMs: 450,
  minUsed: 4,
};

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Pure: pairs each click with the first onset in its acceptance window, drops
 * outliers (|x − median| > max(25 ms, 3 × MAD)) and returns the median offset.
 */
export function estimateLatency(
  clickMs: readonly number[],
  onsetMs: readonly number[],
  options: EstimateOptions = DEFAULT_ESTIMATE_OPTIONS,
): LatencyEstimate | null {
  const onsets = [...onsetMs].sort((a, b) => a - b);
  const used = new Set<number>();
  const offsets: number[] = [];
  for (const click of clickMs) {
    const idx = onsets.findIndex(
      (t, i) => !used.has(i) && t >= click + options.minOffsetMs && t <= click + options.maxOffsetMs,
    );
    if (idx >= 0) {
      used.add(idx);
      offsets.push(onsets[idx] - click);
    }
  }
  if (offsets.length < options.minUsed) return null;

  const m = median(offsets);
  const mad = median(offsets.map((x) => Math.abs(x - m)));
  const inliers = offsets.filter((x) => Math.abs(x - m) <= Math.max(25, 3 * mad));
  if (inliers.length < options.minUsed) return null;

  const latency = median(inliers);
  const spread = 1.4826 * median(inliers.map((x) => Math.abs(x - latency)));
  return { latencyMs: latency, spreadMs: spread, used: inliers.length, total: clickMs.length };
}

export interface CalibrationPlan {
  readonly bpm: number;
  readonly countInClicks: number;
  readonly measuredClicks: number;
}

export const DEFAULT_CALIBRATION_PLAN: CalibrationPlan = { bpm: 90, countInClicks: 4, measuredClicks: 8 };

export interface CalibrationProgress {
  readonly click: number;
  readonly total: number;
  readonly countIn: boolean;
}

/**
 * Plays clicks through the microphone's own AudioContext and records the
 * onsets the detector hears. Click times and onset times both pass through
 * the same audio-clock → performance.now() mapping, so that mapping's
 * offset cancels out; what remains is output latency + input latency (+ the
 * player's own habit of anticipating the beat).
 */
export async function runLatencyCalibration(
  mic: MicInput,
  detector: NoteDetector,
  onProgress: (p: CalibrationProgress) => void,
  signal?: AbortSignal,
  plan: CalibrationPlan = DEFAULT_CALIBRATION_PLAN,
): Promise<LatencyEstimate | null> {
  const ctx = mic.context;
  if (!ctx || !detector.running) throw new Error('Microphone and detector must be running');

  const interval = 60 / plan.bpm;
  const total = plan.countInClicks + plan.measuredClicks;
  const startSec = ctx.currentTime + 0.6;
  const clickSecs = Array.from({ length: total }, (_, i) => startSec + i * interval);

  for (const [i, t] of clickSecs.entries()) scheduleClick(ctx, t, i < plan.countInClicks);

  const onsets: number[] = [];
  const unsubscribe = detector.notes.on((n) => onsets.push(n.perfMs));
  const timers = clickSecs.map((t, i) =>
    window.setTimeout(
      () => onProgress({ click: i + 1, total, countIn: i < plan.countInClicks }),
      Math.max(0, (t - ctx.currentTime) * 1000),
    ),
  );

  try {
    const endMs = (clickSecs[total - 1] - ctx.currentTime) * 1000 + DEFAULT_ESTIMATE_OPTIONS.maxOffsetMs + 400;
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, endMs);
      signal?.addEventListener('abort', () => {
        window.clearTimeout(timer);
        reject(new DOMException('Calibration cancelled', 'AbortError'));
      });
    });
  } finally {
    unsubscribe();
    timers.forEach((t) => window.clearTimeout(t));
  }

  const measured = clickSecs.slice(plan.countInClicks).map((t) => mic.clock.toPerfMs(t));
  return estimateLatency(measured, onsets);
}

function scheduleClick(ctx: AudioContext, at: number, accent: boolean): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = accent ? 1760 : 1320;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(0.6, at + 0.001);
  gain.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + 0.06);
}
