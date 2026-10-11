import { describe, expect, it } from 'vitest';
import { seededRandom } from '../matching/test-helpers';
import { ClockSync } from './clock-sync';

describe('ClockSync', () => {
  it('recovers the true offset from late-delivered observations', () => {
    const rand = seededRandom(5);
    const sync = new ClockSync();
    const trueOffset = 1234.5;
    for (let i = 0; i < 400; i++) {
      const audioSec = i * 0.0107;
      const delay = rand() * 15; // delivery is 0–15 ms late
      sync.observe(audioSec, audioSec * 1000 + trueOffset + delay);
    }
    expect(sync.offsetMs).toBeGreaterThanOrEqual(trueOffset);
    expect(sync.offsetMs - trueOffset).toBeLessThan(0.5);
    expect(sync.toPerfMs(2)).toBeCloseTo(2000 + sync.offsetMs);
    expect(sync.toAudioSec(sync.toPerfMs(3.25))).toBeCloseTo(3.25);
  });

  it('follows drift by forgetting old observations', () => {
    const sync = new ClockSync(1000, 250);
    // offset grows by 1 ms per second of audio
    for (let i = 0; i <= 1000; i++) {
      const audioSec = i * 0.01;
      sync.observe(audioSec, audioSec * 1000 + 100 + audioSec);
    }
    // after 10 s the offset is ~110; a global minimum would still say 100
    expect(sync.offsetMs).toBeGreaterThan(108.5);
  });

  it('throws before any observation', () => {
    expect(new ClockSync().ready).toBe(false);
    expect(() => new ClockSync().offsetMs).toThrow();
  });
});
