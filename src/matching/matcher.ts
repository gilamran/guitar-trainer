import { pitchErrorCents } from './pitch';
import {
  DEFAULT_MATCH_OPTIONS,
  type DetectedEvent,
  type EventResult,
  type ExpectedEvent,
  type MatchOptions,
  type MatchResult,
  type Verdict,
} from './types';

/*
 * Note matching as a monotone alignment.
 *
 * Expected events E and detected onsets D are both ordered in time. Each
 * plausible pair (e, d) gets a weight:
 *
 *   right pitch, |Δt| ≤ timing window   → HIT    (100 … 111)
 *   right pitch, |Δt| ≤ outer window    → OFF    ( 50 …  60)  early/late
 *   wrong pitch, |Δt| ≤ timing window   → WRONG  ( 10 …  15)
 *   anything else                       → not pairable
 *
 * Within each band, closer timing (and, for hits, closer pitch) scores a
 * little higher so the closest detection wins ties. Leaving an expected event
 * unpaired (missed) or a detection unpaired (extra noise, a double-triggered
 * onset, a strum's individual strings) costs nothing.
 *
 * We pick the set of pairs with maximum total weight such that no two pairs
 * cross (e1 < e2 ⇒ d1 < d2) and every event and detection is used at most
 * once. Compared with a greedy nearest-neighbour match, this stops one late
 * note from "stealing" the onset that belongs to the next note.
 *
 * Because skips are free, this is a maximum-weight chain over the candidate
 * pairs: best(i, j) = w(i, j) + max{ best(i', j') : i' < i, j' < j }. With a
 * Fenwick tree for prefix maxima over j, it runs in O(P log |D|), where P (the
 * number of candidate pairs) is small because only detections inside the
 * outer window are candidates.
 */

const W_HIT = 100;
const W_OFF = 50;
const W_WRONG = 10;
const W_TIME = 10;
const W_PITCH = 1;

interface Candidate {
  /** Index into the time-sorted expected list. */
  readonly e: number;
  /** Index into the time-sorted detected list. */
  readonly d: number;
  readonly weight: number;
  readonly timingErrorMs: number;
  readonly centsError: number | undefined;
  readonly pitchOk: boolean;
}

/** Prefix-maximum Fenwick tree that also remembers which candidate holds the max. */
class MaxFenwick {
  private readonly values: Float64Array;
  private readonly owners: Int32Array;

  constructor(size: number) {
    this.values = new Float64Array(size + 1);
    this.owners = new Int32Array(size + 1).fill(-1);
  }

  /** Records `value` (held by candidate `owner`) at 0-based position `pos`. */
  update(pos: number, value: number, owner: number): void {
    for (let i = pos + 1; i < this.values.length; i += i & -i) {
      if (value > this.values[i]) {
        this.values[i] = value;
        this.owners[i] = owner;
      }
    }
  }

  /** Maximum over positions [0, count). Returns [0, -1] when empty. */
  query(count: number): [value: number, owner: number] {
    let best = 0;
    let owner = -1;
    for (let i = count; i > 0; i -= i & -i) {
      if (this.values[i] > best) {
        best = this.values[i];
        owner = this.owners[i];
      }
    }
    return [best, owner];
  }
}

function sortedIndices<T extends { timeMs: number }>(items: readonly T[]): number[] {
  return items.map((_, i) => i).sort((a, b) => items[a].timeMs - items[b].timeMs);
}

function buildCandidates(
  expected: readonly ExpectedEvent[],
  detected: readonly DetectedEvent[],
  eOrder: readonly number[],
  dOrder: readonly number[],
  opts: MatchOptions,
): Candidate[] {
  const timing = opts.timingWindowMs;
  const outer = Math.max(opts.outerWindowMs, timing);
  const candidates: Candidate[] = [];
  let lo = 0;

  for (let e = 0; e < eOrder.length; e++) {
    const exp = expected[eOrder[e]];
    while (lo < dOrder.length && detected[dOrder[lo]].timeMs < exp.timeMs - outer) lo++;

    for (let d = lo; d < dOrder.length; d++) {
      const det = detected[dOrder[d]];
      const dt = det.timeMs - exp.timeMs;
      if (dt > outer) break;

      const adt = Math.abs(dt);
      const cents = pitchErrorCents(exp.pitches, det.pitches, opts.chordPolicy);
      const pitchOk = cents !== null && Math.abs(cents) <= opts.pitchToleranceCents;

      let weight: number;
      if (pitchOk && adt <= timing) {
        const timeScore = timing > 0 ? 1 - adt / timing : 1;
        const pitchScore =
          opts.pitchToleranceCents > 0 ? 1 - Math.abs(cents) / opts.pitchToleranceCents : 1;
        weight = W_HIT + W_TIME * timeScore + W_PITCH * pitchScore;
      } else if (pitchOk) {
        weight = W_OFF + W_TIME * (1 - (adt - timing) / (outer - timing));
      } else if (adt <= timing) {
        weight = W_WRONG + (W_TIME / 2) * (timing > 0 ? 1 - adt / timing : 1);
      } else {
        continue;
      }

      candidates.push({
        e,
        d,
        weight,
        timingErrorMs: dt,
        centsError: cents ?? undefined,
        pitchOk,
      });
    }
  }
  return candidates;
}

/** Picks the maximum-weight non-crossing subset of candidates (see header comment). */
function bestChain(candidates: readonly Candidate[], detectedCount: number): Candidate[] {
  const best = new Float64Array(candidates.length);
  const prev = new Int32Array(candidates.length).fill(-1);
  const tree = new MaxFenwick(detectedCount);
  let top = -1;

  // Candidates are generated grouped by expected index, ascending. Updates for
  // a row are deferred until the whole row is scored so that two pairs that
  // share an expected event can never chain together.
  let rowStart = 0;
  while (rowStart < candidates.length) {
    let rowEnd = rowStart;
    while (rowEnd < candidates.length && candidates[rowEnd].e === candidates[rowStart].e) rowEnd++;

    for (let k = rowStart; k < rowEnd; k++) {
      const [value, owner] = tree.query(candidates[k].d);
      best[k] = value + candidates[k].weight;
      prev[k] = owner;
      if (top === -1 || best[k] > best[top]) top = k;
    }
    for (let k = rowStart; k < rowEnd; k++) tree.update(candidates[k].d, best[k], k);
    rowStart = rowEnd;
  }

  const chain: Candidate[] = [];
  for (let k = top; k !== -1; k = prev[k]) chain.push(candidates[k]);
  return chain.reverse();
}

function verdictFor(c: Candidate, timingWindowMs: number): Verdict {
  if (!c.pitchOk) return 'wrong';
  if (c.timingErrorMs < -timingWindowMs) return 'early';
  if (c.timingErrorMs > timingWindowMs) return 'late';
  return 'hit';
}

/**
 * Matches detected onsets against expected events.
 *
 * Pure function: same input, same output, no side effects.
 *
 * @param nowMs  Live mode. When given, unmatched events whose association
 *               window (`timeMs + outerWindowMs`) has not closed yet are
 *               reported as `pending` instead of `missed`.
 */
export function matchEvents(
  expected: readonly ExpectedEvent[],
  detected: readonly DetectedEvent[],
  options: MatchOptions = DEFAULT_MATCH_OPTIONS,
  nowMs?: number,
): MatchResult {
  const eOrder = sortedIndices(expected);
  const dOrder = sortedIndices(detected);

  const candidates = buildCandidates(expected, detected, eOrder, dOrder, options);
  const chain = bestChain(candidates, dOrder.length);

  const byExpected = new Map<number, Candidate>();
  const usedDetections = new Set<number>();
  for (const c of chain) {
    byExpected.set(eOrder[c.e], c);
    usedDetections.add(dOrder[c.d]);
  }

  const outer = Math.max(options.outerWindowMs, options.timingWindowMs);
  const results: EventResult[] = expected.map((exp, i) => {
    const c = byExpected.get(i);
    if (!c) {
      const open = nowMs !== undefined && exp.timeMs + outer > nowMs;
      return { expectedId: exp.id, verdict: open ? 'pending' : 'missed' };
    }
    return {
      expectedId: exp.id,
      verdict: verdictFor(c, options.timingWindowMs),
      detectedId: detected[dOrder[c.d]].id,
      timingErrorMs: c.timingErrorMs,
      centsError: c.centsError,
    };
  });

  const extraDetectionIds = detected.filter((_, i) => !usedDetections.has(i)).map((d) => d.id);
  return { results, extraDetectionIds };
}
