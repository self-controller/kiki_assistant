import { LIMITS } from "@kiki/shared";
import type { NearbyTextPolicy, ScreenshotPolicy } from "../../shared-types.ts";
import { CONTEXT_CHARS, VICINITY, type Capture, type LineBudget, type RawCapture, type Vicinity } from "./common.ts";
import { captureLinux, warmHelpers } from "./linux.ts";
import { captureMac } from "./mac.ts";

export type { Capture } from "./common.ts";

/** Gets the next capture ready ahead of the hotkey. */
export function prepareCapture(): void {
  if (process.platform === "linux") warmHelpers();
}

export async function captureContext(policy: ScreenshotPolicy, nearby: NearbyTextPolicy): Promise<Capture> {
  let raw: RawCapture;
  if (process.platform === "linux") raw = await captureLinux(policy, nearby);
  else if (process.platform === "darwin") raw = await captureMac(policy);
  else raw = { selection: "", notes: ["Kiki can only read other apps on Linux and macOS."] };

  const { vicinity, focus, fullText, ...rest } = raw;
  const selection = cleanSelection(raw.selection);
  return {
    ...rest,
    selection,
    appName: raw.appName?.slice(0, LIMITS.appNameChars) || undefined,
    windowTitle: raw.windowTitle?.slice(0, LIMITS.windowTitleChars) || undefined,
    url: raw.url && raw.url.length <= LIMITS.urlChars ? raw.url : undefined,
    text: nearbyText(vicinity ? vicinityText(vicinity, selection) : raw.text, selection, focus),
    fullText: fullText?.then((full) => {
      if (!full) return undefined;
      const { focus: at, vicinity: lines, ...late } = full;
      // An empty selection says nothing is highlighted in the page.
      const around = late.selection !== undefined ? cleanSelection(late.selection) : selection;
      return {
        ...late,
        text: nearbyText(lines ? vicinityText(lines, around) : late.text, around, at) ?? "",
        ...(late.selection !== undefined ? { selection: around } : {}),
      };
    }),
  };
}

function cleanSelection(selection: string): string {
  return selection.trim().slice(0, LIMITS.selectionChars);
}

function nearbyText(text: string | undefined, selection: string, focus?: number): string | undefined {
  const trimmed = text && trimAround(text, selection, CONTEXT_CHARS, focus);
  // Text that is only the selection itself adds nothing.
  return trimmed && trimmed.trim() !== selection ? trimmed : undefined;
}

function vicinityText(vicinity: Vicinity, selection: string): string {
  const budget = VICINITY[vicinity.kind];
  const whole = vicinity.before + vicinity.anchor + vicinity.after;
  return trimLines(vicinity, budget) ?? trimAround(whole, selection, budget.chars);
}

/**
 * Cuts `text` to `max` characters, keeping the selection near the middle when it is found, or else the
 * `focus` offset (the middle of what's on screen).
 */
export function trimAround(text: string, selection: string, max: number, focus?: number): string {
  if (text.length <= max) return text;
  const at = selection ? text.indexOf(selection.slice(0, 200)) : -1;
  const middle = at >= 0 ? at + Math.floor(selection.length / 2) : focus;
  if (middle === undefined) return text.slice(0, max) + "…";
  const start = Math.max(0, Math.min(middle - Math.floor(max / 2), text.length - max));
  const end = start + max;
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

/**
 * The whole lines around a terminal's or editor's selection (or caret): up to `budget.before` lines
 * above it and `budget.after` below, then the farthest lines dropped, keeping that ratio, until it
 * fits `budget.chars`. Cuts are marked with a "…" line. Undefined when the selection's own lines
 * don't fit.
 */
export function trimLines({ before, anchor, after }: Vicinity, budget: LineBudget): string | undefined {
  const above = splitLines(before);
  const below = splitLines(after);
  // The selection's first and last lines, with whatever sits beside it on them.
  const middle = above.pop()! + anchor.replace(/\r\n?/g, "\n") + below.shift()!;

  const kept = {
    above: above.slice(Math.max(0, above.length - budget.before)),
    below: below.slice(0, budget.after),
  };
  let size = [...kept.above, middle, ...kept.below].reduce((sum, line) => sum + line.length + 1, 0);
  while (size > budget.chars && kept.above.length + kept.below.length > 0) {
    // Drop from the side that is longer for its share of the budget.
    const fromBelow = kept.below.length * budget.before >= kept.above.length * budget.after;
    size -= (fromBelow ? kept.below.pop()! : kept.above.shift()!).length + 1;
  }
  if (size > budget.chars) return undefined;

  return tidyLines([
    ...(kept.above.length < above.length ? ["…"] : []),
    ...kept.above,
    middle,
    ...kept.below,
    ...(kept.below.length < below.length ? ["…"] : []),
  ]);
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

/** Drops trailing spaces (terminals pad their rows), runs of blank lines, and blank lines at the ends. */
function tidyLines(lines: string[]): string {
  const out: string[] = [];
  for (const line of lines.map((line) => line.trimEnd())) {
    if (line === "" && (out.length === 0 || out.at(-1) === "")) continue;
    out.push(line);
  }
  while (out.at(-1) === "") out.pop();
  return out.join("\n");
}
