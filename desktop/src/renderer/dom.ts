// Small DOM helpers the popup's modules share.

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** `text` on one line, cut to `max` characters. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const keepFocusHandler = (event: Event) => event.preventDefault();

/** A press on `node` leaves the cursor where it is (in the question). */
export function keepFocus(node: HTMLElement): void {
  node.addEventListener("mousedown", keepFocusHandler);
}
