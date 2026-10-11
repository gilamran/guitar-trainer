import { describe, expect, it } from 'vitest';
import { isScoreFileName, parseScore, ScoreLoadError } from './formats';
import { PPQ } from './tempo-map';
import { scoreFromTex, tickLookupFor, toGp7 } from './test-scores';
import {
  barRangeToTicks,
  buildTrackTimeline,
  eventsInRange,
  tempoMapFromLookup,
  ticksToBarRange,
} from './timeline';

const BAR = 4 * PPQ;

describe('buildTrackTimeline', () => {
  it('lists onsets with sounding pitches', () => {
    const score = scoreFromTex(`\\tempo 120 . :4 0.6 2.6 3.6 0.5 | (0.6 2.5 2.4).2 r.2 |`);
    const tl = buildTrackTimeline(tickLookupFor(score), 0);
    expect(tl.map((e) => [e.tick, e.pitches, e.barIndex])).toEqual([
      [0, [40], 0],
      [PPQ, [42], 0],
      [2 * PPQ, [43], 0],
      [3 * PPQ, [45], 0],
      [BAR, [40, 47, 52], 1], // chord: one event, three pitches; the rest is skipped
    ]);
    expect(tl[4].noteIds).toHaveLength(3);
  });

  it('skips tied continuations and dead notes, keeps grace notes before the beat', () => {
    const score = scoreFromTex(`. :4 0.6 -.6 x.6 3.6 | :4 2.5{gr} 3.5 0.4 0.4 0.4 |`);
    const tl = buildTrackTimeline(tickLookupFor(score), 0);
    const pitches = tl.map((e) => e.pitches[0]);
    expect(pitches).toEqual([40, 43, 47, 48, 50, 50, 50]);
    // the grace note sounds just before the downbeat of bar 2
    expect(tl[2].tick).toBeLessThan(BAR);
    expect(tl[3].tick).toBe(BAR);
  });

  it('unrolls repeats in playback order', () => {
    const score = scoreFromTex(`. :1 0.6 | \\ro :1 2.6 | \\rc 2 :1 3.6 | :1 5.6 |`);
    const tl = buildTrackTimeline(tickLookupFor(score), 0);
    expect(tl.map((e) => e.pitches[0])).toEqual([40, 42, 43, 42, 43, 45]);
    expect(tl.map((e) => e.barIndex)).toEqual([0, 1, 2, 1, 2, 3]);
    expect(new Set(tl.map((e) => e.id)).size).toBe(tl.length);
  });

  it('applies swing (triplet feel) to onset ticks', () => {
    const score = scoreFromTex(`. \\tf triplet-8th :8 0.6 0.6 0.6 0.6 :2 0.6 |`);
    const ticks = buildTrackTimeline(tickLookupFor(score), 0).map((e) => e.tick);
    expect(ticks).toEqual([0, 640, 960, 1600, 1920]);
  });

  it('only includes the requested track', () => {
    const score = scoreFromTex(`\\track "Lead" . :1 0.1 | \\track "Rhythm" . :1 0.6 |`);
    const lookup = tickLookupFor(score);
    expect(buildTrackTimeline(lookup, 0).map((e) => e.pitches)).toEqual([[64]]);
    expect(buildTrackTimeline(lookup, 1).map((e) => e.pitches)).toEqual([[40]]);
  });
});

describe('tempo and bar ranges', () => {
  const score = scoreFromTex(`\\tempo 120 . :1 0.6 | \\ro :1 2.6 | \\tempo 60 \\rc 2 :1 3.6 | :1 5.6 |`);
  const lookup = tickLookupFor(score);

  it('builds the tempo map from the lookup', () => {
    const tempo = tempoMapFromLookup(lookup);
    expect(tempo.tickToMs(BAR)).toBe(2000);
    expect(tempo.tickToMs(2 * BAR)).toBe(4000);
    expect(tempo.tickToMs(3 * BAR)).toBe(8000); // bar 3 is at 60 bpm
  });

  it('maps bar ranges to ticks using the first occurrence, through repeats', () => {
    expect(barRangeToTicks(lookup, 1, 2)).toEqual({ startTick: BAR, endTick: 3 * BAR });
    expect(barRangeToTicks(lookup, 0, 0)).toEqual({ startTick: 0, endTick: BAR });
    // bar 3 comes after the repeat: the loop spans both passes
    expect(barRangeToTicks(lookup, 1, 3)).toEqual({ startTick: BAR, endTick: 6 * BAR });
    expect(barRangeToTicks(lookup, 3, 1)).toBeNull();
    expect(barRangeToTicks(lookup, 9, 9)).toBeNull();
  });

  it('maps tick ranges back to bars', () => {
    expect(ticksToBarRange(lookup, { startTick: BAR, endTick: 3 * BAR })).toEqual({ fromBar: 1, toBar: 2 });
    expect(ticksToBarRange(lookup, { startTick: 3 * BAR + 10, endTick: 4 * BAR })).toEqual({ fromBar: 1, toBar: 1 });
  });

  it('filters events to a range', () => {
    const tl = buildTrackTimeline(lookup, 0);
    expect(eventsInRange(tl, { startTick: BAR, endTick: 3 * BAR }).map((e) => e.pitches[0])).toEqual([42, 43]);
  });
});

describe('score file loading', () => {
  it('recognises supported extensions', () => {
    for (const name of ['a.gp', 'b.GP5', 'c.gpx', 'd.musicxml', 'e.xml', 'f.mxl', 'g.gp3']) {
      expect(isScoreFileName(name)).toBe(true);
    }
    for (const name of ['a.mid', 'b.pdf', 'c.gp5.txt']) expect(isScoreFileName(name)).toBe(false);
  });

  it('parses Guitar Pro bytes', () => {
    const bytes = toGp7(scoreFromTex(`\\title "Etude" . :4 0.6 2.6 3.6 0.5 |`));
    const score = parseScore(bytes);
    expect(score.title).toBe('Etude');
    expect(score.masterBars).toHaveLength(1);
  });

  it('reports unreadable files', () => {
    expect(() => parseScore(new Uint8Array([1, 2, 3, 4]))).toThrow(ScoreLoadError);
  });
});
