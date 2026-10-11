import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, matchOptionsFrom, sanitizeSettings, saveSettings } from './settings';

describe('settings', () => {
  it('falls back to defaults for missing or invalid values', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    const s = sanitizeSettings({ timingWindowMs: 5000, pitchToleranceCents: 'x', speed: 0.1, chordPolicy: 'nope' });
    expect(s.timingWindowMs).toBe(300);
    expect(s.pitchToleranceCents).toBe(50);
    expect(s.speed).toBe(0.4);
    expect(s.chordPolicy).toBe('any-tone');
  });

  it('keeps a calibrated latency, including zero, and null when unknown', () => {
    expect(sanitizeSettings({ latencyMs: 0 }).latencyMs).toBe(0);
    expect(sanitizeSettings({ latencyMs: 142.5 }).latencyMs).toBe(142.5);
    expect(sanitizeSettings({ latencyMs: 'fast' }).latencyMs).toBeNull();
    expect(sanitizeSettings({}).latencyMs).toBeNull();
  });

  it('round-trips through storage', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveSettings({ ...DEFAULT_SETTINGS, latencyMs: 90, speed: 0.6 }, storage);
    expect(loadSettings(storage)).toMatchObject({ latencyMs: 90, speed: 0.6 });
  });

  it('never throws when storage is broken', () => {
    const broken = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(loadSettings(broken)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(DEFAULT_SETTINGS, broken)).not.toThrow();
    expect(loadSettings({ getItem: () => '{not json' })).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('derives match options', () => {
    const m = matchOptionsFrom({ ...DEFAULT_SETTINGS, timingWindowMs: 80 });
    expect(m.timingWindowMs).toBe(80);
    expect(m.outerWindowMs).toBeGreaterThan(80);
  });
});
