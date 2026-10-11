// Streams an answer's text in smoothly: words appear at a steady pace that keeps up with the stream,
// and each newly shown run fades in (wrapFresh in popup.ts, `.fresh` in popup.css). Pure functions,
// so they're testable.

/** How long newly shown text takes to fade in, and so stays wrapped (`.fresh` in popup.css). */
export const FADE_MS = 600;
/** The slowest Kiki shows text, in characters per second. */
const MIN_RATE = 80;
/** A backlog shrinks with this time constant, so the text never falls far behind the stream. */
const CATCH_UP_MS = 300;

/** How far into `text` to show `dtMs` after showing `shown` characters, ending at the end of a word. */
export function revealTo(text: string, shown: number, dtMs: number): number {
  const backlog = text.length - shown;
  if (backlog <= 0) return text.length;
  const step = Math.max((MIN_RATE * dtMs) / 1000, (backlog * dtMs) / CATCH_UP_MS);
  let end = endOfWord(text, Math.min(text.length, shown + Math.ceil(step)));
  // A bare list or heading marker ("- ", "1. ", "## ") would show as an empty bullet: take the next word too.
  const line = text.slice(text.lastIndexOf("\n", end - 1) + 1, end);
  if (/^\s*(?:[-*+>]|#{1,6}|\d+[.)])$/.test(line)) {
    while (end < text.length && /[ \t]/.test(text[end]!)) end++;
    end = endOfWord(text, end);
  }
  return end;
}

function endOfWord(text: string, at: number): number {
  while (at < text.length && !/\s/.test(text[at]!)) at++;
  return at;
}

/** A run of the rendered text, from character `start` on, that started fading in at `time`. */
export interface Reveal {
  start: number;
  time: number;
}

/** A range of the rendered text that is still fading in, and how far into its fade it is. */
export interface FreshRange {
  start: number;
  end: number;
  age: number;
}

/** The ranges of a rendered text of `length` characters that are still fading in at `now`. */
export function freshRanges(reveals: Reveal[], length: number, now: number): FreshRange[] {
  const ranges: FreshRange[] = [];
  reveals.forEach((reveal, index) => {
    const age = now - reveal.time;
    const end = Math.min(length, reveals[index + 1]?.start ?? length);
    if (age < FADE_MS && reveal.start < end) ranges.push({ start: reveal.start, end, age });
  });
  return ranges;
}
