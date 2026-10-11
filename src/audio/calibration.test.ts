import { describe, expect, it } from 'vitest';
import { seededRandom } from '../matching/test-helpers';
import { estimateLatency } from './calibration';

const clicks = Array.from({ length: 8 }, (_, i) => 1000 + i * 667);

describe('estimateLatency', () => {
  it('returns the median click→onset delay', () => {
    const rand = seededRandom(9);
    const onsets = clicks.map((c) => c + 85 + (rand() - 0.5) * 20);
    const est = estimateLatency(clicks, onsets)!;
    expect(est.latencyMs).toBeGreaterThan(80);
    expect(est.latencyMs).toBeLessThan(90);
    expect(est.used).toBe(8);
    expect(est.spreadMs).toBeLessThan(10);
  });

  it('ignores stray onsets and rejects outliers', () => {
    const onsets = clicks.map((c) => c + 120);
    onsets[2] = clicks[2] + 380; // a late, sloppy clap
    onsets.push(clicks[5] - 300); // noise between clicks
    const est = estimateLatency(clicks, onsets)!;
    expect(est.latencyMs).toBe(120);
    expect(est.used).toBe(7);
  });

  it('accepts slightly anticipated claps', () => {
    const est = estimateLatency(clicks, clicks.map((c) => c - 30))!;
    expect(est.latencyMs).toBe(-30);
  });

  it('uses the first onset after each click (e.g. the speaker click itself)', () => {
    const onsets = clicks.flatMap((c) => [c + 60, c + 95]);
    expect(estimateLatency(clicks, onsets)!.latencyMs).toBe(60);
  });

  it('gives up when too few clicks were answered', () => {
    expect(estimateLatency(clicks, [clicks[0] + 100, clicks[1] + 100])).toBeNull();
    expect(estimateLatency(clicks, [])).toBeNull();
  });
});
