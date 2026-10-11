import { exporter, importer, midi, type model, Settings } from '@coderline/alphatab';

/** Builds an alphaTab score from alphaTex (tests only). */
export function scoreFromTex(tex: string): model.Score {
  const settings = new Settings();
  const imp = new importer.AlphaTexImporter();
  imp.initFromString(tex, settings);
  return imp.readScore();
}

/** Runs alphaTab's MIDI generator to obtain the playback tick lookup (tests only). */
export function tickLookupFor(score: model.Score): midi.MidiTickLookup {
  const handler = new midi.AlphaSynthMidiFileHandler(new midi.MidiFile());
  const gen = new midi.MidiFileGenerator(score, new Settings(), handler);
  gen.generate();
  return gen.tickLookup;
}

export function toGp7(score: model.Score): Uint8Array {
  return new exporter.Gp7Exporter().export(score, new Settings());
}
