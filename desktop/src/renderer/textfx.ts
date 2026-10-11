// Text that moves: labels that swap letter by letter (the thinking title), and button labels whose
// width eases to new text.

/** Delay between letters coming in, and going out (last letter first). */
const ENTER_STAGGER_MS = 25;
const EXIT_STAGGER_MS = 15;
/** How long one letter takes to go out (`.letter.out` in popup.css). */
const EXIT_MS = 300;

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function span(className: string, text?: string): HTMLSpanElement {
  const node = document.createElement("span");
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function letter(char: string, index: number, delayMs: number): HTMLSpanElement {
  const node = span("letter in", char);
  node.style.setProperty("--i", String(index));
  node.style.setProperty("--d", `${delayMs}ms`);
  return node;
}

/**
 * A short label that changes like the placeholder of a chat box: the old text's letters blur away
 * (last letter first), then the new text's blur in, one after another.
 */
export class SwapText {
  readonly root: HTMLSpanElement;
  #text: string;
  #next: string | null = null;
  #timer = 0;

  constructor(className: string, text: string) {
    this.root = span(className);
    this.#text = text;
    this.#render(text);
  }

  set(text: string): void {
    if (text === (this.#next ?? this.#text)) return;
    this.root.setAttribute("aria-label", text);
    // Already on its way out: just change what comes in.
    if (this.#timer) {
      this.#next = text;
      return;
    }
    const letters = [...this.root.children] as HTMLElement[];
    if (reduceMotion.matches || letters.length === 0) {
      this.#text = text;
      this.#render(text);
      return;
    }
    this.#next = text;
    letters.forEach((node, index) => {
      node.classList.replace("in", "out");
      node.style.setProperty("--d", `${(letters.length - 1 - index) * EXIT_STAGGER_MS}ms`);
    });
    this.#timer = window.setTimeout(
      () => {
        this.#timer = 0;
        this.#text = this.#next ?? this.#text;
        this.#next = null;
        this.#render(this.#text);
      },
      (letters.length - 1) * EXIT_STAGGER_MS + EXIT_MS,
    );
  }

  #render(text: string): void {
    this.root.setAttribute("aria-label", text);
    const letters = [...graphemes.segment(text)].map(({ segment }, index) => {
      // A plain space would collapse inside an inline-block.
      const node = letter(segment === " " ? " " : segment, index, index * ENTER_STAGGER_MS);
      node.setAttribute("aria-hidden", "true");
      return node;
    });
    this.root.replaceChildren(...letters);
  }
}

const settleWidth = new WeakMap<HTMLElement, () => void>();

/** Sets a button label's text; its width eases to fit, and the new text fades and zooms in. */
export function morphText(target: HTMLElement, text: string): void {
  if (target.dataset["text"] === text) return;
  const animate = target.dataset["text"] !== undefined && !reduceMotion.matches;
  target.dataset["text"] = text;
  const from = target.getBoundingClientRect().width;
  const label = span(animate ? "morph-label morph-in" : "morph-label", text);
  target.replaceChildren(label);
  if (!animate) return;
  target.style.width = "";
  const to = target.getBoundingClientRect().width;
  target.style.width = `${from}px`;
  void target.offsetWidth;
  target.style.width = `${to}px`;
  const previous = settleWidth.get(target);
  if (previous) target.removeEventListener("transitionend", previous);
  // Back to its natural width once there, so a late-loading font can't clip it.
  const settle = () => {
    target.style.width = "";
    target.removeEventListener("transitionend", settle);
  };
  settleWidth.set(target, settle);
  target.addEventListener("transitionend", settle);
}
