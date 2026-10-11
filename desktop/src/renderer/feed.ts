// Text helpers for the popup's thinking feed. Pure functions, so they're testable.

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Splits streamed thinking summaries into paragraphs (blocks arrive separated by a blank line). */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function plain(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One short feed line for a paragraph of thinking: its bold lead-in if it has one, otherwise its
 * first sentence, as plain text without a final period, cut to about `max` characters.
 */
export function thoughtLine(paragraph: string, max = 90): string {
  const lead = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)/.exec(paragraph)?.[1];
  const text = plain(lead ?? paragraph);
  const sentence = /^(.+?[.!?])(?=\s|$)/.exec(text)?.[1] ?? text;
  const line = sentence.replace(/[.:;,\s]+$/, "");
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[.,;:\s]+$/, "")}…`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function formatSeconds(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
