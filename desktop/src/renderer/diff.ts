// What a change to a piece of text changes, for the changes card. No DOM here, so tests run it in Node.

/** The part of `before` and `after` that differs, between what they share at the start and the end. */
export function diffParts(before: string, after: string): { head: string; removed: string; added: string; tail: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before.at(-1 - end) === after.at(-1 - end)) end++;
  // Whole words read better: widen to the word boundaries around the change.
  while (start > 0 && /\w/.test(before[start - 1]!) && (/\w/.test(before[start] ?? "") || /\w/.test(after[start] ?? ""))) start--;
  while (end > 0 && /\w/.test(before.at(-end)!) && (/\w/.test(before.at(-1 - end) ?? "") || /\w/.test(after.at(-1 - end) ?? ""))) end--;
  return {
    head: before.slice(0, start),
    removed: before.slice(start, before.length - end),
    added: after.slice(start, after.length - end),
    tail: before.slice(before.length - end),
  };
}
