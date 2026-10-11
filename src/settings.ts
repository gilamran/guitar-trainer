import type { ChordPolicy, MatchOptions } from './matching/types';
import type { NoteTrackerOptions } from './audio/note-tracker';

export type OnsetSensitivity = 'low' | 'normal' | 'high';

export interface AppSettings {
  /** ± window for "on time", ms. */
  readonly timingWindowMs: number;
  /** ± tolerance for "right pitch", cents. */
  readonly pitchToleranceCents: number;
  readonly chordPolicy: ChordPolicy;
  /** Measured or entered input latency (ms); null until calibrated. */
  readonly latencyMs: number | null;
  readonly latencyCalibratedAt: string | null;
  readonly onsetSensitivity: OnsetSensitivity;
  /** Playback speed factor 0.4–1. */
  readonly speed: number;
  readonly countIn: boolean;
  readonly metronome: boolean;
  /** Hear the synth play the practiced part (turn off when using a speaker + mic). */
  readonly playMyPart: boolean;
  /** Volume of the other tracks, 0–1. */
  readonly backingVolume: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  timingWindowMs: 120,
  pitchToleranceCents: 50,
  chordPolicy: 'any-tone',
  latencyMs: null,
  latencyCalibratedAt: null,
  onsetSensitivity: 'normal',
  speed: 1,
  countIn: true,
  metronome: false,
  playMyPart: true,
  backingVolume: 1,
};

const STORAGE_KEY = 'guitar-trainer:settings:v1';

const clamp = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  options.includes(v as T) ? (v as T) : fallback;

/** Coerces anything (e.g. stale or hand-edited storage) into valid settings. */
export function sanitizeSettings(raw: unknown): AppSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    timingWindowMs: clamp(r.timingWindowMs, 30, 300, d.timingWindowMs),
    pitchToleranceCents: clamp(r.pitchToleranceCents, 10, 100, d.pitchToleranceCents),
    chordPolicy: oneOf(r.chordPolicy, ['any-tone', 'root', 'timing-only'] as const, d.chordPolicy),
    latencyMs:
      typeof r.latencyMs === 'number' && Number.isFinite(r.latencyMs) ? clamp(r.latencyMs, -200, 1000, 0) : null,
    latencyCalibratedAt: typeof r.latencyCalibratedAt === 'string' ? r.latencyCalibratedAt : null,
    onsetSensitivity: oneOf(r.onsetSensitivity, ['low', 'normal', 'high'] as const, d.onsetSensitivity),
    speed: clamp(r.speed, 0.4, 1, d.speed),
    countIn: bool(r.countIn, d.countIn),
    metronome: bool(r.metronome, d.metronome),
    playMyPart: bool(r.playMyPart, d.playMyPart),
    backingVolume: clamp(r.backingVolume, 0, 1, d.backingVolume),
  };
}

/** Settings persisted in localStorage. Storage may be unavailable (private mode, blocked): never throws. */
export function loadSettings(storage: Pick<Storage, 'getItem'> | null = safeLocalStorage()): AppSettings {
  try {
    const json = storage?.getItem(STORAGE_KEY);
    return sanitizeSettings(json ? JSON.parse(json) : {});
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(
  settings: AppSettings,
  storage: Pick<Storage, 'setItem'> | null = safeLocalStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Quota exceeded or storage blocked: settings just won't persist.
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function matchOptionsFrom(s: AppSettings): MatchOptions {
  return {
    timingWindowMs: s.timingWindowMs,
    // Right pitch but further off than this is "missed"; scale with the window.
    outerWindowMs: Math.max(250, s.timingWindowMs * 2.5),
    pitchToleranceCents: s.pitchToleranceCents,
    chordPolicy: s.chordPolicy,
  };
}

export function trackerOptionsFrom(s: AppSettings): Partial<NoteTrackerOptions> {
  const rise = { low: 9, normal: 6, high: 4 }[s.onsetSensitivity];
  return { onsetRiseDb: rise };
}
