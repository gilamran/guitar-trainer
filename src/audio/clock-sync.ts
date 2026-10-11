/**
 * Maps an audio clock (AudioContext seconds) onto `performance.now()`
 * milliseconds, the shared time base of the app.
 *
 * Each observation pairs an audio-clock time with the moment the main thread
 * learned about it. Delivery is only ever late, never early, so the smallest
 * recent `perf − audio` offset is the best estimate of the true one.
 *
 * Two things move the true offset: slow drift between the clocks (handled by
 * only looking at a sliding window) and audio glitches — when the audio
 * thread stalls, the audio clock falls behind for good and the offset jumps
 * up. A jump is recognised when even the best observation of the last few
 * buckets sits clearly above the window minimum; the older buckets are then
 * dropped so the new offset is adopted within a fraction of a second.
 */
export class ClockSync {
  private buckets: { startMs: number; minOffset: number }[] = [];

  constructor(
    private readonly windowMs = 2000,
    private readonly bucketMs = 100,
    /** How many of the newest buckets must agree on a higher offset. */
    private readonly jumpBuckets = 3,
    /** How much higher (ms) counts as a jump rather than jitter. */
    private readonly jumpThresholdMs = 10,
  ) {}

  get ready(): boolean {
    return this.buckets.length > 0;
  }

  observe(audioSec: number, perfMs: number): void {
    const offset = perfMs - audioSec * 1000;
    const last = this.buckets[this.buckets.length - 1];
    if (last && perfMs - last.startMs < this.bucketMs) {
      last.minOffset = Math.min(last.minOffset, offset);
    } else {
      this.buckets.push({ startMs: perfMs, minOffset: offset });
      this.detectJump();
    }
    while (this.buckets.length > 1 && perfMs - this.buckets[0].startMs > this.windowMs) {
      this.buckets.shift();
    }
  }

  /** Current best `perf − audio` offset in ms. */
  get offsetMs(): number {
    if (this.buckets.length === 0) throw new Error('ClockSync has no observations yet');
    let min = Number.POSITIVE_INFINITY;
    for (const b of this.buckets) min = Math.min(min, b.minOffset);
    return min;
  }

  toPerfMs(audioSec: number): number {
    return audioSec * 1000 + this.offsetMs;
  }

  toAudioSec(perfMs: number): number {
    return (perfMs - this.offsetMs) / 1000;
  }

  reset(): void {
    this.buckets = [];
  }

  /** Runs when a bucket completes: checks the last `jumpBuckets` complete buckets. */
  private detectJump(): void {
    const complete = this.buckets.length - 1; // the newest bucket just started
    if (complete <= this.jumpBuckets) return;
    const recent = this.buckets.slice(complete - this.jumpBuckets, complete);
    const older = this.buckets.slice(0, complete - this.jumpBuckets);
    const recentMin = Math.min(...recent.map((b) => b.minOffset));
    const olderMin = Math.min(...older.map((b) => b.minOffset));
    if (recentMin > olderMin + this.jumpThresholdMs) {
      this.buckets.splice(0, complete - this.jumpBuckets);
    }
  }
}
