import type { MatchResult, Verdict } from './types';

export interface PassScore {
  /** Judged events (pending ones excluded). */
  readonly total: number;
  readonly counts: Readonly<Record<Verdict, number>>;
  /** Hits as a percentage of judged events, 0–100. */
  readonly percentHit: number;
  /** Right pitch regardless of timing (hit + early + late), 0–100. */
  readonly percentRightPitch: number;
  /**
   * Median signed timing error of right-pitch matches, in ms. A consistently
   * large value usually means the latency calibration is off.
   */
  readonly medianTimingErrorMs: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function scorePass(match: MatchResult): PassScore {
  const counts: Record<Verdict, number> = {
    hit: 0,
    early: 0,
    late: 0,
    wrong: 0,
    missed: 0,
    pending: 0,
  };
  const timingErrors: number[] = [];

  for (const r of match.results) {
    counts[r.verdict]++;
    if (
      (r.verdict === 'hit' || r.verdict === 'early' || r.verdict === 'late') &&
      r.timingErrorMs !== undefined
    ) {
      timingErrors.push(r.timingErrorMs);
    }
  }

  const total = match.results.length - counts.pending;
  const pct = (n: number) => (total > 0 ? (100 * n) / total : 0);

  return {
    total,
    counts,
    percentHit: pct(counts.hit),
    percentRightPitch: pct(counts.hit + counts.early + counts.late),
    medianTimingErrorMs: median(timingErrors),
  };
}
