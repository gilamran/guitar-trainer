/// <reference lib="webworker" />
import type { DetectorRequest, DetectorResponse } from './detector-protocol';
import { FrameAnalyzer } from './frame-analyzer';
import { NoteTracker } from './note-tracker';
import { PitchyEstimator } from './pitch-estimator';

/*
 * Runs the monophonic analysis off the main thread so pitch detection never
 * competes with score rendering or the playback cursor.
 */

declare const self: DedicatedWorkerGlobalScope;

const LEVEL_INTERVAL_SEC = 0.05;

let analyzer: FrameAnalyzer | null = null;
let tracker: NoteTracker | null = null;
let levelPeak = -120;
let lastLevelSec = 0;

function post(msg: DetectorResponse): void {
  self.postMessage(msg);
}

self.onmessage = (e: MessageEvent<DetectorRequest>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'config':
      analyzer = new FrameAnalyzer(msg.sampleRate, new PitchyEstimator(2048), 256);
      tracker = new NoteTracker(analyzer.windowDurationSec, msg.options);
      break;
    case 'reset':
      analyzer?.reset();
      tracker?.reset();
      break;
    case 'samples': {
      if (!analyzer || !tracker) return;
      const t = tracker;
      for (const frame of analyzer.push(msg.samples, msg.frame, () => t.cancelHz)) {
        for (const note of t.process(frame)) post({ type: 'note', ...note });
        levelPeak = Math.max(levelPeak, frame.levelDb);
        if (frame.timeSec - lastLevelSec >= LEVEL_INTERVAL_SEC) {
          post({ type: 'level', levelDb: levelPeak, gateDb: t.gateDb });
          levelPeak = -120;
          lastLevelSec = frame.timeSec;
        }
      }
      break;
    }
  }
};
