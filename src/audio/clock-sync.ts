/**
 * Maps an audio clock (AudioContext seconds) onto `performance.now()`
 * milliseconds, the shared time base of the app.
 *
 * Each observation pairs an audio-clock time with the moment the main thread
 * learned about it. Delivery is only ever late, never early, so the smallest
 * recent `perf − audio` offset is the best estimate of the true one. Keeping
 * the minimum over a sliding window (rather than all time) follows the slow
 * drift between the audio clock and the system clock.
 */
export class ClockSync {
  private buckets: { startMs: number; minOffset: number }[] = [];

  constructor(
    private readonly windowMs = 5000,
    private readonly bucketMs = 500,
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
}
