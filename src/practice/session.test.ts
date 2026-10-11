import { describe, expect, it } from 'vitest';
import { seededRandom } from '../matching/test-helpers';
import { DEFAULT_MATCH_OPTIONS } from '../matching/types';
import { PPQ, TempoMap } from '../score/tempo-map';
import type { TimelineEvent } from '../score/timeline';
import { DETECTION_DELAY_MS, type LiveUpdate, type PassReport, PracticeSession } from './session';

const BAR = 4 * PPQ;
const tempo = new TempoMap([{ tick: 0, bpm: 120 }]); // quarter = 500 ms
// Eight quarter notes over two bars, distinct pitches.
const timeline: TimelineEvent[] = Array.from({ length: 8 }, (_, i) => ({
  id: String(i * PPQ),
  tick: i * PPQ,
  pitches: [40 + i],
  noteIds: [i],
  barIndex: Math.floor(i / 4),
}));
const range = { startTick: 0, endTick: 2 * BAR };

/** What the player does for note `i` of pass `p`: timing error (ms) and pitch, or null to skip. */
type Player = (i: number, p: number) => { errorMs: number; pitch?: number } | null;

interface SimOptions {
  passes: number;
  speed?: number;
  /** Real round-trip latency of the system. */
  actualLatencyMs?: number;
  /** Latency the session compensates for. */
  configuredLatencyMs?: number;
  player?: Player;
  /** Stop after this many ms into the last pass instead of wrapping. */
  stopAfterMs?: number;
  /** Seek to this tick after this many ms into the last pass. */
  seek?: { afterMs: number; tick: number };
}

function simulate(o: SimOptions) {
  const speed = o.speed ?? 1;
  const actual = o.actualLatencyMs ?? 80;
  const player: Player = o.player ?? (() => ({ errorMs: 0 }));
  const session = new PracticeSession({
    range,
    timeline,
    tempo,
    speed,
    latencyMs: o.configuredLatencyMs ?? actual,
    match: DEFAULT_MATCH_OPTIONS,
  });
  const reports: PassReport[] = [];
  const lives: (LiveUpdate & { now: number })[] = [];
  let now = 0;
  session.passFinished.on((r) => reports.push(r));
  session.live.on((l) => lives.push({ ...l, now }));

  const rand = seededRandom(11);
  const passMs = tempo.tickToMs(range.endTick) / speed;
  const t0 = 10_000;
  const actions: { at: number; run: () => void }[] = [];
  const at = (time: number, run: () => void) => actions.push({ at: time, run });

  at(t0 - 1500, () => session.onPosition({ tick: 0, perfMs: t0 - 1500, isSeek: true })); // setLoop before play

  let end = t0;
  for (let p = 0; p < o.passes; p++) {
    const start = t0 + p * passMs;
    const last = p === o.passes - 1;
    const stopAt = last && o.stopAfterMs !== undefined ? start + o.stopAfterMs : null;
    const seekAt = last && o.seek ? start + o.seek.afterMs : null;
    const limit = stopAt ?? seekAt ?? start + passMs;

    for (let ms = 0; start + ms < limit; ms += 10) {
      const tick = tempo.msToTick(ms * speed);
      const arrive = start + ms + rand() * 12; // positions arrive 0–12 ms late
      at(arrive, () => session.onPosition({ tick, perfMs: arrive, isSeek: false }));
    }
    timeline.forEach((e, i) => {
      const act = player(i, p);
      if (!act) return;
      const audible = start + tempo.tickToMs(e.tick) / speed + act.errorMs;
      if (audible > limit) return;
      const reported = audible + actual;
      at(reported + 120, () =>
        session.onNote({ perfMs: reported, pitches: [act.pitch ?? e.pitches[0]], confidence: 1 }),
      );
    });

    if (stopAt !== null) {
      at(stopAt, () => session.onStopped(stopAt));
      end = stopAt;
    } else if (seekAt !== null) {
      at(seekAt, () => session.onPosition({ tick: o.seek!.tick, perfMs: seekAt, isSeek: true }));
      end = seekAt;
    } else {
      const wrap = start + passMs;
      at(wrap, () => session.onPosition({ tick: 0, perfMs: wrap, isSeek: true }));
      end = wrap;
    }
  }
  for (let t = t0 - 1000; t < end + 2000; t += 100) {
    at(t, () => {
      now = t;
      session.update(t);
    });
  }

  actions.sort((a, b) => a.at - b.at).forEach((a) => a.run());
  return { reports, lives };
}

describe('PracticeSession', () => {
  it('scores every loop pass of a perfect performance', () => {
    const { reports } = simulate({ passes: 3 });
    expect(reports.map((r) => r.index)).toEqual([1, 2, 3]);
    for (const r of reports) {
      expect(r.partial).toBe(false);
      expect(r.score.total).toBe(8);
      expect(r.score.percentHit).toBe(100);
      expect(Math.abs(r.score.medianTimingErrorMs!)).toBeLessThan(15);
    }
  });

  it('accounts for playback speed', () => {
    const rand = seededRandom(3);
    const { reports } = simulate({
      passes: 2,
      speed: 0.5,
      player: () => ({ errorMs: (rand() - 0.5) * 140 }),
    });
    expect(reports.map((r) => r.score.percentHit)).toEqual([100, 100]);
  });

  it('reports misses and wrong notes per pass', () => {
    const { reports } = simulate({
      passes: 2,
      player: (i, p) => (p === 1 && i < 2 ? null : p === 1 && i === 5 ? { errorMs: 0, pitch: 70 } : { errorMs: 0 }),
    });
    expect(reports[0].score.percentHit).toBe(100);
    expect(reports[1].score.counts).toMatchObject({ hit: 5, missed: 2, wrong: 1 });
    expect(reports[1].results[0].verdict).toBe('missed');
  });

  it('flags a consistently late player', () => {
    const { reports } = simulate({ passes: 1, player: () => ({ errorMs: 170 }) });
    expect(reports[0].score.counts.late).toBe(8);
    expect(reports[0].score.medianTimingErrorMs!).toBeGreaterThan(155);
  });

  it('shows uncalibrated latency as a timing offset', () => {
    const { reports } = simulate({ passes: 1, actualLatencyMs: 90, configuredLatencyMs: 0 });
    expect(reports[0].score.medianTimingErrorMs!).toBeGreaterThan(80);
    expect(reports[0].score.medianTimingErrorMs!).toBeLessThan(100);
  });

  it('scores a stopped pass as partial, judging only what was reached', () => {
    const { reports } = simulate({ passes: 2, stopAfterMs: 1700 }); // notes at 0, 500, 1000, 1500
    expect(reports).toHaveLength(2);
    expect(reports[1].partial).toBe(true);
    expect(reports[1].score.total).toBe(4);
    expect(reports[1].score.percentHit).toBe(100);
  });

  it('a user seek closes the pass and starts a new one from the seek target', () => {
    const { reports, lives } = simulate({ passes: 1, seek: { afterMs: 1200, tick: 5 * PPQ } });
    expect(reports[0].partial).toBe(true);
    expect(reports[0].score.total).toBe(3);
    // the new pass was opened from tick 5·PPQ, but no positions arrived yet → no live state for it
    expect(lives.every((l) => l.passIndex === 1)).toBe(true);
  });

  it('live state never marks a note missed before its window has closed', () => {
    const { lives } = simulate({ passes: 1, player: (i) => (i === 3 ? null : { errorMs: 0 }) });
    const passStart = 10_000;
    const closes = passStart + 1500 + DEFAULT_MATCH_OPTIONS.outerWindowMs + DETECTION_DELAY_MS;
    const missedEarly = lives.some((l) => l.results[3].verdict === 'missed' && l.now < closes);
    expect(lives.some((l) => l.results[3].verdict === 'pending')).toBe(true);
    expect(missedEarly).toBe(false);
    expect(lives[lives.length - 1].results[3].verdict).toBe('missed');
    expect(lives[lives.length - 1].results[2].verdict).toBe('hit');
  });

  it('does not count one onset in two passes', () => {
    // last note played very late, first note of the next pass very early
    const { reports } = simulate({
      passes: 2,
      player: (i, p) => (i === 7 && p === 0 ? { errorMs: 260 } : i === 0 && p === 1 ? { errorMs: -100 } : { errorMs: 0 }),
    });
    expect(reports[0].results[7].verdict).toBe('late');
    expect(reports[1].results[0].verdict).toBe('hit');
    expect(reports[0].results[7].detectedId).not.toBe(reports[1].results[0].detectedId);
  });
});
