import type { Verdict } from '../matching/types';
import type { ScoreView } from '../score/score-view';
import type { TimelineEvent } from '../score/timeline';
import { el } from './dom';

/** Colour class per verdict: green / yellow / red. Pending stays uncoloured. */
const CLASS: Record<Verdict, string | null> = {
  hit: 'hit',
  early: 'off',
  late: 'off',
  wrong: 'miss',
  missed: 'miss',
  pending: null,
};

const PAD = 3;

/**
 * Colours rendered notes by drawing translucent marks over alphaTab's note
 * bounds. An overlay (instead of restyling the score) keeps updates cheap
 * enough to run several times per second without re-rendering.
 */
export class VerdictOverlay {
  private readonly verdicts = new Map<number, Verdict>();
  private readonly marks = new Map<number, HTMLElement[]>();

  constructor(
    private readonly layer: HTMLElement,
    private readonly view: ScoreView,
  ) {
    view.rendered.on(() => this.redraw());
  }

  /** Applies verdicts for a set of events (one pass). */
  show(events: readonly TimelineEvent[], verdicts: readonly Verdict[]): void {
    events.forEach((e, i) => {
      for (const noteId of e.noteIds) this.set(noteId, verdicts[i]);
    });
  }

  clear(): void {
    this.verdicts.clear();
    this.marks.forEach((list) => list.forEach((m) => m.remove()));
    this.marks.clear();
  }

  private set(noteId: number, verdict: Verdict): void {
    if (this.verdicts.get(noteId) === verdict) return;
    this.verdicts.set(noteId, verdict);
    const cls = CLASS[verdict];
    let list = this.marks.get(noteId);
    if (!list) {
      list = this.view.boxesForNote(noteId).map((b) => {
        const m = el('div', 'mark');
        m.style.left = `${b.x - PAD}px`;
        m.style.top = `${b.y - PAD}px`;
        m.style.width = `${b.w + 2 * PAD}px`;
        m.style.height = `${b.h + 2 * PAD}px`;
        this.layer.append(m);
        return m;
      });
      this.marks.set(noteId, list);
    }
    for (const m of list) m.className = cls ? `mark ${cls}` : 'mark';
  }

  /** Note positions change after a re-render (resize, zoom, track change). */
  private redraw(): void {
    const saved = [...this.verdicts];
    this.clear();
    for (const [noteId, verdict] of saved) this.set(noteId, verdict);
  }
}
