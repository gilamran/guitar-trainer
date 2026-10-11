/**
 * AudioWorklet that forwards microphone samples to the main thread in
 * fixed-size blocks, tagged with the audio-clock frame of their first sample.
 *
 * Kept as a source string loaded through a Blob URL: no bundler special-casing,
 * and it works the same in dev, in the production build and offline.
 */
export const CAPTURE_PROCESSOR_NAME = 'gt-capture';
export const CAPTURE_BLOCK_SIZE = 512;

const source = /* js */ `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(${CAPTURE_BLOCK_SIZE});
    this.filled = 0;
    this.blockStart = 0;
    this.active = true;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.active = false; };
  }

  flush() {
    if (this.filled === 0) return;
    const samples = this.block.slice(0, this.filled);
    this.port.postMessage({ frame: this.blockStart, samples }, [samples.buffer]);
    this.filled = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return this.active;
    const n = channels[0].length;
    // A discontinuity (should not happen, but be safe) closes the block.
    if (this.filled > 0 && this.blockStart + this.filled !== currentFrame) this.flush();
    for (let i = 0; i < n; i++) {
      if (this.filled === 0) this.blockStart = currentFrame + i;
      let sum = 0;
      for (let c = 0; c < channels.length; c++) sum += channels[c][i];
      this.block[this.filled++] = sum / channels.length;
      if (this.filled === this.block.length) this.flush();
    }
    return this.active;
  }
}
registerProcessor('${CAPTURE_PROCESSOR_NAME}', CaptureProcessor);
`;

let url: string | null = null;

export function captureWorkletUrl(): string {
  url ??= URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
  return url;
}
