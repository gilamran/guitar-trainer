import type { PassReport } from '../practice/session';
import { el } from './dom';

export interface HistoryEntry {
  readonly report: PassReport;
  /** "Bars 3–6" etc. */
  readonly label: string;
}

const MAX_BARS = 30;

function band(pct: number): 'hit' | 'off' | 'miss' {
  return pct >= 85 ? 'hit' : pct >= 60 ? 'off' : 'miss';
}

/**
 * Per-pass results: the latest pass in detail plus a bar per pass so progress
 * over repetitions is visible at a glance.
 */
export class PassHistory {
  private entries: HistoryEntry[] = [];

  constructor(
    private readonly latest: HTMLElement,
    private readonly strip: HTMLElement,
  ) {}

  add(entry: HistoryEntry): void {
    this.entries.push(entry);
    this.render();
  }

  reset(): void {
    this.entries = [];
    this.render();
  }

  private render(): void {
    const last = this.entries[this.entries.length - 1];
    this.latest.replaceChildren(last ? this.renderLatest(last) : this.renderEmpty());

    this.strip.replaceChildren(
      ...this.entries.slice(-MAX_BARS).map((e, i, shown) => {
        const pct = e.report.score.percentHit;
        const bar = el('div', `bar ${band(pct)}${i === shown.length - 1 ? ' current' : ''}`);
        bar.style.setProperty('--h', `${Math.max(4, pct)}%`);
        const n = this.entries.length - shown.length + i + 1;
        bar.title = `Pass ${n} · ${Math.round(pct)}% · ${e.label} · ${Math.round(e.report.speed * 100)}% speed${e.report.partial ? ' (partial)' : ''}`;
        if (e.report.partial) bar.classList.add('partial');
        return bar;
      }),
    );
  }

  private renderEmpty(): HTMLElement {
    const div = el('div', 'pass-empty');
    div.innerHTML = 'Turn on <strong>Listen</strong> and play a loop — your score appears here after each pass.';
    return div;
  }

  private renderLatest({ report, label }: HistoryEntry): HTMLElement {
    const s = report.score;
    const root = el('div', 'latest');
    const pct = el('div', `pct ${band(s.percentHit)}`, `${Math.round(s.percentHit)}%`);
    const info = el('div', 'latest-info');

    const n = this.entries.length;
    const recent = this.entries.slice(-5).filter((e) => !e.report.partial);
    const avg = recent.length ? recent.reduce((a, e) => a + e.report.score.percentHit, 0) / recent.length : null;
    const best = Math.max(...this.entries.filter((e) => !e.report.partial).map((e) => e.report.score.percentHit), 0);

    const title = el('div', 'latest-title', `Pass ${n}${report.partial ? ' (partial)' : ''} · ${label}`);
    const counts = el('div', 'latest-counts');
    counts.append(
      chip('hit', `${s.counts.hit} hit`),
      chip('off', `${s.counts.early + s.counts.late} off-time`),
      chip('miss', `${s.counts.wrong} wrong`),
      chip('miss', `${s.counts.missed} missed`),
    );
    const meta: string[] = [];
    if (avg !== null && recent.length > 1) meta.push(`last ${recent.length} avg ${Math.round(avg)}%`);
    if (best > 0) meta.push(`best ${Math.round(best)}%`);
    const m = s.medianTimingErrorMs;
    if (m !== null && Math.abs(m) >= 15) meta.push(`median ${m > 0 ? '+' : ''}${Math.round(m)} ms ${m > 0 ? 'late' : 'early'}`);
    const metaLine = el('div', 'latest-meta', meta.join(' · '));

    info.append(title, counts, metaLine);
    if (m !== null && Math.abs(m) > 60 && s.counts.hit + s.counts.early + s.counts.late >= 4) {
      info.append(
        el(
          'div',
          'latest-hint',
          `Consistently ${Math.abs(Math.round(m))} ms ${m > 0 ? 'late' : 'early'} — if that doesn’t match how it felt, recalibrate latency in Settings.`,
        ),
      );
    }
    root.append(pct, info);
    return root;
  }
}

function chip(kind: string, text: string): HTMLElement {
  return el('span', `chip ${kind}`, text);
}
