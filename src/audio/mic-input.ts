import { Emitter } from '../util/emitter';
import { CAPTURE_PROCESSOR_NAME, captureWorkletUrl } from './capture-worklet';
import { ClockSync } from './clock-sync';

export interface MicBlock {
  readonly samples: Float32Array;
  /** Audio-clock frame index of `samples[0]`. */
  readonly frame: number;
}

export class MicError extends Error {}

function describeGetUserMediaError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was denied. Allow it in the browser’s site settings and try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found.';
    case 'NotReadableError':
      return 'The microphone is in use by another application.';
    default:
      return `Could not open the microphone${err instanceof Error ? `: ${err.message}` : ''}.`;
  }
}

/**
 * Owns the microphone AudioContext. Delivers raw sample blocks with
 * audio-clock timestamps and maintains the audio-clock → performance.now()
 * mapping. Echo cancellation, noise suppression and auto-gain are disabled:
 * they distort exactly the attacks and pitches we want to measure.
 */
export class MicInput {
  readonly clock = new ClockSync();
  readonly blocks = new Emitter<MicBlock>();

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  get running(): boolean {
    return this.ctx !== null;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 0;
  }

  /** Must be called from a user gesture (click/tap) so audio may start. */
  async start(): Promise<void> {
    if (this.ctx) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new MicError('The microphone needs a secure (HTTPS) page.');
    }
    // Create and resume inside the gesture, before any await, for Safari.
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const resumed = ctx.resume();

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 1 },
        },
      });
    } catch (err) {
      void ctx.close();
      throw new MicError(describeGetUserMediaError(err));
    }

    try {
      await resumed;
      await ctx.audioWorklet.addModule(captureWorkletUrl());
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      throw new MicError(`Audio processing is not available in this browser (${String(err)}).`);
    }

    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, CAPTURE_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    // Keep the node pulled by the graph without making any sound.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(node).connect(sink).connect(ctx.destination);

    const sampleRate = ctx.sampleRate;
    node.port.onmessage = (e: MessageEvent<{ frame: number; samples: Float32Array }>) => {
      const { frame, samples } = e.data;
      this.clock.observe((frame + samples.length) / sampleRate, performance.now());
      this.blocks.emit({ frame, samples });
    };

    this.ctx = ctx;
    this.stream = stream;
    this.node = node;
    this.sink = sink;
    this.source = source;
  }

  async stop(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    this.node?.port.postMessage('stop');
    this.node?.port.close();
    this.source?.disconnect();
    this.node?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx = null;
    this.stream = this.node = this.sink = this.source = null;
    this.clock.reset();
    await ctx.close();
  }
}
