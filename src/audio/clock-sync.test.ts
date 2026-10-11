import { describe, expect, it } from 'vitest';
import { seededRandom } from '../matching/test-helpers';
import { ClockSync } from './clock-sync';

/** Feeds block messages every ~10.7 ms with random delivery delay. */
function feed(
  sync: ClockSync,
  fromSec: number,
  toSec: number,
  offsetAt: (audioSec: number) => number,
  delay: (i: number) => number,
): void {
  let i = 0;
  for (let audioSec = fromSec; audioSec < toSec; audioSec += 0.0107, i++) {
    sync.observe(audioSec, audioSec * 1000 + offsetAt(audioSec) + delay(i));
  }
}

describe('ClockSync', () => {
  it('recovers the true offset from late-delivered observations', () => {
    const rand = seededRandom(5);
    const sync = new ClockSync();
    feed(sync, 0, 4, () => 1234.5, () => rand() * 15);
    expect(sync.offsetMs).toBeGreaterThanOrEqual(1234.5);
    expect(sync.offsetMs - 1234.5).toBeLessThan(0.5);
    expect(sync.toPerfMs(2)).toBeCloseTo(2000 + sync.offsetMs);
    expect(sync.toAudioSec(sync.toPerfMs(3.25))).toBeCloseTo(3.25);
  });

  it('follows slow drift by forgetting old observations', () => {
    const sync = new ClockSync();
    feed(sync, 0, 10, (a) => 100 + a, () => 0); // offset grows 1 ms per second
    expect(sync.offsetMs).toBeGreaterThan(107.5);
  });

  it('adopts a jump after an audio stall within a few hundred ms', () => {
    const rand = seededRandom(8);
    const sync = new ClockSync();
    // After a 150 ms stall at t = 3 s the audio clock is 150 ms behind for good.
    const offset = (a: number) => (a < 3 ? 400 : 550);
    feed(sync, 0, 3, offset, () => rand() * 8);
    expect(sync.offsetMs).toBeLessThan(402);
    feed(sync, 3, 3.5, offset, () => rand() * 8);
    expect(sync.offsetMs).toBeGreaterThanOrEqual(550);
    expect(sync.offsetMs).toBeLessThan(552);
  });

  it('does not mistake a main-thread pause for a stall', () => {
    const sync = new ClockSync();
    // Messages during a 60 ms pause are delivered in a burst afterwards: the
    // oldest is 60 ms late, the newest on time.
    feed(sync, 0, 6, () => 300, (i) => {
      const phase = i % 120;
      return phase < 6 ? (6 - phase) * 10 : 1;
    });
    expect(sync.offsetMs).toBeLessThan(302);
  });

  it('throws before any observation', () => {
    expect(new ClockSync().ready).toBe(false);
    expect(() => new ClockSync().offsetMs).toThrow();
  });
});
