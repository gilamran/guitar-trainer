/** `document.getElementById` that fails loudly when the skeleton and code disagree. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el as T;
}

/** Creates an element with classes and optional text. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function setPressed(button: HTMLElement, pressed: boolean): void {
  button.setAttribute('aria-pressed', String(pressed));
}

export function isPressed(button: HTMLElement): boolean {
  return button.getAttribute('aria-pressed') === 'true';
}

/** True when keyboard shortcuts should be ignored (typing in a field, dialog open). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName) || !!target.closest('dialog[open]');
}
