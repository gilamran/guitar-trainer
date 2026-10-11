import { Emitter } from '../util/emitter';
import type { DetectorRequest, DetectorResponse } from './detector-protocol';
import type { MicInput } from './mic-input';
import type { NoteTrackerOptions } from './note-tracker';

/** A note onset, on the shared performance.now() clock. */
export interface DetectedNote {
  /** Onset time (ms, performance.now() clock). Not latency-compensated. */
  readonly perfMs: number;
  /** Fractional MIDI pitches; empty when the onset had no clear pitch. */
  readonly pitches: readonly number[];
  readonly confidence: number;
}

export interface LevelReading {
  readonly levelDb: number;
  readonly gateDb: number;
}

/**
 * Turns microphone input into note onsets. The MVP ships a monophonic
 * detector; a polyphonic one (Phase 2, e.g. Spotify's basic-pitch running in
 * the browser) implements the same interface and emits several pitches per
 * onset. Nothing downstream needs to change: the matcher already accepts
 * multi-pitch detections and has a chord policy for judging them.
 */
export interface NoteDetector {
  readonly kind: 'mono' | 'poly';
  readonly notes: Emitter<DetectedNote>;
  readonly levels: Emitter<LevelReading>;
  readonly running: boolean;
  start(mic: MicInput): void;
  stop(): void;
}

export type MonoDetectorOptions = Partial<NoteTrackerOptions>;

/** YIN-family (McLeod) monophonic detector running in a Web Worker. */
export class MonoNoteDetector implements NoteDetector {
  readonly kind = 'mono' as const;
  readonly notes = new Emitter<DetectedNote>();
  readonly levels = new Emitter<LevelReading>();

  private worker: Worker | null = null;
  private unsubscribe: (() => void) | null = null;
  private mic: MicInput | null = null;

  constructor(private options: MonoDetectorOptions = {}) {}

  get running(): boolean {
    return this.worker !== null;
  }

  start(mic: MicInput): void {
    if (this.worker) this.stop();
    if (!mic.running) throw new Error('Start the microphone before the detector');

    const worker = new Worker(new URL('./detector.worker.ts', import.meta.url), { type: 'module' });
    const send = (msg: DetectorRequest) => worker.postMessage(msg);
    send({ type: 'config', sampleRate: mic.sampleRate, options: this.options });

    worker.onmessage = (e: MessageEvent<DetectorResponse>) => {
      const msg = e.data;
      if (msg.type === 'level') {
        this.levels.emit({ levelDb: msg.levelDb, gateDb: msg.gateDb });
      } else if (msg.type === 'note' && mic.clock.ready) {
        this.notes.emit({
          perfMs: mic.clock.toPerfMs(msg.onsetSec),
          pitches: msg.midi === null ? [] : [msg.midi],
          confidence: msg.confidence,
        });
      }
    };
    this.unsubscribe = mic.blocks.on(({ frame, samples }) => send({ type: 'samples', frame, samples }));
    this.worker = worker;
    this.mic = mic;
  }

  /** Applies new tracker options (e.g. onset sensitivity) to the running detector. */
  configure(options: MonoDetectorOptions): void {
    this.options = options;
    if (this.worker && this.mic) {
      this.worker.postMessage({ type: 'config', sampleRate: this.mic.sampleRate, options } satisfies DetectorRequest);
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.worker?.terminate();
    this.worker = null;
    this.mic = null;
  }
}
