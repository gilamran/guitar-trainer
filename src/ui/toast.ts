import { byId, el } from './dom';

export type ToastKind = 'info' | 'error' | 'success';

/** Short, dismissable notifications in the corner. */
export function toast(message: string, kind: ToastKind = 'info', durationMs = 5000): void {
  const host = byId('toasts');
  const node = el('div', `toast ${kind}`, message);
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  node.addEventListener('click', () => node.remove());
  host.append(node);
  window.setTimeout(() => {
    node.classList.add('leaving');
    window.setTimeout(() => node.remove(), 250);
  }, durationMs);
}
