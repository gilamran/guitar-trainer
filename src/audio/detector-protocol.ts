import type { NoteTrackerOptions, TrackedNote } from './note-tracker';

/** Messages from the main thread to the detector worker. */
export type DetectorRequest =
  | { readonly type: 'config'; readonly sampleRate: number; readonly options: Partial<NoteTrackerOptions> }
  | { readonly type: 'samples'; readonly frame: number; readonly samples: Float32Array }
  | { readonly type: 'reset' };

/** Messages from the detector worker to the main thread. Times are audio-clock seconds. */
export type DetectorResponse =
  | ({ readonly type: 'note' } & TrackedNote)
  | { readonly type: 'level'; readonly levelDb: number; readonly gateDb: number };
