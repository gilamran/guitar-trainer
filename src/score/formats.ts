import { importer, type model, Settings } from '@coderline/alphatab';

/** File types alphaTab can import (Guitar Pro 3–8, GPX, MusicXML incl. compressed .mxl). */
export const SCORE_EXTENSIONS = ['.gp', '.gp3', '.gp4', '.gp5', '.gpx', '.musicxml', '.xml', '.mxl'] as const;

export const SCORE_ACCEPT = SCORE_EXTENSIONS.join(',');

export class ScoreLoadError extends Error {}

export function isScoreFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return SCORE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Reads a user-supplied file into bytes, rejecting obviously unsupported types. */
export async function readScoreFile(file: File): Promise<Uint8Array> {
  if (!isScoreFileName(file.name)) {
    throw new ScoreLoadError(
      `“${file.name}” is not a supported file. Use Guitar Pro (${SCORE_EXTENSIONS.slice(0, 5).join(', ')}) or MusicXML (.musicxml, .xml, .mxl).`,
    );
  }
  return new Uint8Array(await file.arrayBuffer());
}

/** Parses score bytes with alphaTab's importers. */
export function parseScore(data: Uint8Array, settings: Settings = new Settings()): model.Score {
  try {
    return importer.ScoreLoader.loadScoreFromBytes(data, settings);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ScoreLoadError(`This file could not be read as a score (${detail}).`);
  }
}
