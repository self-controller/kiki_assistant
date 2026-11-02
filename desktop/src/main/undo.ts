// Kiki's Undo: what each applied edit, changes or fill card wrote, and how to put the original back the same
// way the write went in. A write over AT-SPI is undone over AT-SPI, after checking Kiki's text is still there.
// A paste over a selection (browsers) is undone by selecting Kiki's text and pasting the original. A paste at
// the cursor (terminals, VS Code, GTK 4, Google Docs) is undone with keystrokes: Backspace once per
// character in a terminal, Ctrl+Z elsewhere, so only the most recent card can be undone that way.
import type { ActionStatus } from "../shared-types.ts";
import type { Capture } from "./capture/common.ts";
import { runHelper } from "./capture/linux.ts";
import { HELPER_REASONS, selectAndPaste } from "./changes.ts";
import { keepClipboard } from "./clipboard.ts";
import { extensionVersion, keysToSource, MAX_REPEATED_KEYS, UNDO_VERSION, type KeyStep } from "./gnomeShell.ts";
import { plural } from "./google/format.ts";

/** Where a write went: the app's process and the AT-SPI object's path. */
export interface Place {
  pid: number;
  path: number[];
  role?: string;
}

/** The place at `at` in the app `pid`, without a role when the helper gave none. */
export function placeOf(pid: number, at: { path: number[]; role?: string | null }): Place {
  return { pid, path: at.path, ...(at.role ? { role: at.role } : {}) };
}

export type UndoStep =
  /** Kiki wrote `now` over AT-SPI where `original` was: write `original` back over it. `whole`: the whole field. */
  | ({ type: "write"; start: number; now: string; original: string; whole?: boolean } & Place)
  /**
   * Kiki selected the original and pasted `now` over it (browsers): select `now` where it is and paste the
   * original back (or delete it, when there was nothing). `all`: the whole field.
   */
  | ({ type: "selectPaste"; start: number; now: string; original: string; all?: boolean } & Place)
  /** Kiki clicked a check box: click it again, so it's `checked`. */
  | ({ type: "toggle"; checked: boolean } & Place)
  /** Kiki pasted at the cursor: these keystrokes take it back. */
  | { type: "keys"; steps: KeyStep[] };

/** What an applied card can undo, and what it can't even then. */
export interface UndoSteps {
  steps: UndoStep[];
  /** Parts of the card Kiki can't take back (a radio button, a field whose old text it didn't keep). */
  skipped: string[];
}

/** What a card's button did, and how to undo it when it can be undone. */
export interface Applied {
  status: ActionStatus;
  undo?: UndoSteps;
}

export interface UndoRecord extends UndoSteps {
  /** The card's id. */
  id: string;
  kind: "edit" | "changes" | "fill";
  /** The window the card wrote in: keystrokes go to the window Kiki's extension remembers, which must still be it. */
  capture: Capture;
  appName?: string;
}

/** The keystrokes that take back `text`, pasted at the cursor: null when there are too many. */
export function pasteUndoKeys(kind: "terminal" | "editor" | "field" | "unknown" | "docs", text: string): KeyStep[] | null {
  if (kind !== "terminal") return ["ctrl+z"];
  // A terminal's paste left its trailing newlines out; what's at the prompt is the rest, one Backspace a character.
  const count = [...text.replace(/\n+$/, "")].length;
  if (count === 0) return [];
  return count > MAX_REPEATED_KEYS ? null : [`backspace*${count}`];
}

/** A write step: `now` is where `original` was, at `start` in the object at `place`. */
export function writeStep(place: Place, start: number, now: string, original: string, whole = false): UndoStep {
  return { type: "write", ...place, start, now, original, ...(whole ? { whole: true } : {}) };
}

/** A select-and-paste step, where `--select` put the selection (its `path`, `role` and `start`). */
export function selectPasteStep(place: Place, start: number, now: string, original: string, all = false): UndoStep {
  return { type: "selectPaste", ...place, start, now, original, ...(all ? { all: true } : {}) };
}

/**
 * Steps in the order that keeps each one's text where Kiki left it: within one object, the later text first.
 * Objects stay in the order they first appear; keystroke steps keep their place.
 */
export function orderSteps(steps: UndoStep[]): UndoStep[] {
  const groups = new Map<string, UndoStep[]>();
  for (const step of steps) {
    const key = "path" in step ? step.path.join(".") : `#${groups.size}`;
    groups.set(key, [...(groups.get(key) ?? []), step]);
  }
  const at = (step: UndoStep) => ("start" in step ? step.start : -1);
  return [...groups.values()].flatMap((group) => [...group].sort((a, b) => at(b) - at(a)));
}

/**
 * The applied cards of a popup session that can still be undone, newest last. Writes and select-and-pastes
 * can be undone in any order: each one checks Kiki's text is still where it was. Keystroke undos (Ctrl+Z,
 * Backspaces) can only take back the most recent card, in the window it was pasted into.
 */
export class UndoStack {
  readonly #records: UndoRecord[] = [];

  push(record: UndoRecord): void {
    this.#records.push(record);
  }

  has(id: string): boolean {
    return this.#records.some((record) => record.id === id);
  }

  /** The record for card `id` when it can be undone now (with `capture` the session's window), or why not. */
  peek(id: string, capture: Capture): { record: UndoRecord } | { error: string } {
    const index = this.#records.findIndex((record) => record.id === id);
    const record = this.#records[index];
    if (!record) return { error: "Kiki can't undo this anymore." };
    if (record.steps.some((step) => step.type === "keys")) {
      if (index !== this.#records.length - 1) {
        return { error: "Undo the newer card first: this one was pasted, so only the most recent paste can be taken back." };
      }
      if (record.capture !== capture) return { error: "Kiki can't undo this now: the hotkey was pressed in another window since." };
    }
    return { record };
  }

  remove(id: string): void {
    const index = this.#records.findIndex((record) => record.id === id);
    if (index >= 0) this.#records.splice(index, 1);
  }
}

/** Thrown when an undo can't happen anymore: Kiki's text isn't there, so the card loses its Undo button. */
export class UndoGone extends Error {}

/** Reasons only an undo meets; the helper's others (changed, gone, focus…) read as they do on a changes card. */
const UNDO_REASONS: Record<string, string> = {
  not_editable: "the app doesn't take writes anymore",
  not_text: "isn't text anymore",
  failed: "the app refused the write",
};

function reasonText(code: string | undefined): string {
  return UNDO_REASONS[code ?? ""] ?? HELPER_REASONS[code ?? ""] ?? UNDO_REASONS.failed!;
}

const UPDATE_HELPER = "Update Kiki's GNOME helper in Settings (then log out and back in) to undo pastes.";

async function undoStep(step: UndoStep, kikiHasKeyboard: boolean): Promise<string | null> {
  switch (step.type) {
    case "write": {
      const { start, now, original, whole } = step;
      const request = { ...placeOf(step.pid, step), start, expected: now, text: original, ...(whole ? { whole: true } : {}) };
      const result = await runHelper<{ ok: boolean; reason?: string }>(["--edit", JSON.stringify(request)], 5_000).catch(
        (): { ok: boolean; reason?: string } => ({ ok: false, reason: "failed" }),
      );
      return result.ok ? null : reasonText(result.reason);
    }
    case "selectPaste": {
      const { start, now, original, all } = step;
      const how = all ? { all: true, expected: now } : { start, end: start + now.length, expected: now };
      const result = await selectAndPaste(placeOf(step.pid, step), how, original, kikiHasKeyboard);
      if (result.ok) return null;
      return result.pasted ? "pasted, but Kiki couldn't confirm it" : reasonText(result.reason);
    }
    case "toggle": {
      const request = { ...placeOf(step.pid, step), checked: step.checked };
      const result = await runHelper<{ ok: boolean }>(["--press", JSON.stringify(request)], 5_000).catch(() => ({ ok: false }));
      return result.ok ? null : "couldn't be clicked";
    }
    case "keys": {
      if (step.steps.length === 0) return null;
      if (extensionVersion() < UNDO_VERSION) return UPDATE_HELPER;
      return (await keysToSource(step.steps)) ? null : HELPER_REASONS.focus!;
    }
  }
}

/** What an undo says when it worked: where the text went back. */
function doneMessage(record: UndoRecord, done: number, where: string): string {
  if (record.kind === "edit") {
    const step = record.steps[0];
    const insert = step?.type === "keys" || (step && "original" in step && !step.original);
    return insert ? `Took the text back out${where}.` : `Put the original back${where}.`;
  }
  if (record.kind === "changes") {
    const total = record.steps.length;
    return `Undid ${done === total ? plural(total, "change") : `${done} of ${plural(total, "change")}`}${where}.`;
  }
  return `Put the old values back${where}.`;
}

/**
 * Puts back what a card wrote, step by step, with the person's clipboard kept around any paste. Stops between
 * steps when `signal` is aborted. Returns what happened for the card; throws (UndoGone when nothing is left to
 * undo) when nothing could be taken back.
 */
export async function undoRecord(record: UndoRecord, signal?: AbortSignal): Promise<ActionStatus> {
  const where = record.appName ? ` in ${record.appName}` : "";
  const pastes = record.steps.some((step) => step.type === "selectPaste");
  const restore = pastes ? await keepClipboard() : async () => {};
  const failed: string[] = [];
  let done = 0;
  let stopped = false;
  let gone = 0;
  // Only the first paste starts with the keyboard on Kiki: each one hands it to the window.
  let kikiHasKeyboard = true;
  try {
    for (const step of record.steps) {
      if (signal?.aborted) {
        stopped = true;
        break;
      }
      const problem = await undoStep(step, kikiHasKeyboard);
      if (step.type === "selectPaste") kikiHasKeyboard = false;
      if (problem === null) {
        done++;
        continue;
      }
      if (problem === HELPER_REASONS.changed || problem === HELPER_REASONS.gone) gone++;
      failed.push(`${describeStep(step)} (${problem})`);
      if (problem === HELPER_REASONS.focus || problem === UPDATE_HELPER) break;
    }
  } finally {
    await restore();
  }
  if (done === 0 && !stopped) {
    const message = failed.length === 1 && failed[0]!.includes(UPDATE_HELPER) ? UPDATE_HELPER : `Kiki couldn't undo this: ${failed.join("; ")}.`;
    throw gone === failed.length && gone > 0 ? new UndoGone(message) : new Error(message);
  }
  const notes = [
    ...(stopped ? [`stopped after ${plural(done, "step")}`] : []),
    ...(failed.length ? [`not undone: ${failed.join("; ")}`] : []),
    ...(record.skipped.length ? [`Kiki can't undo: ${record.skipped.join(", ")}`] : []),
  ];
  const message = done === 0 ? `Stopped before anything was undone${where}.` : doneMessage(record, done, where);
  return {
    outcome: done === 0 ? "applied" : "undone",
    message: notes.length ? `${message} ${notes.map((note) => `${note[0]!.toUpperCase()}${note.slice(1)}`).join(". ")}.` : message,
  };
}

/** A step as the card names it when it fails. */
function describeStep(step: UndoStep): string {
  if (step.type === "keys") return "the paste";
  if (step.type === "toggle") return "the check box";
  const text = step.now.length > 40 ? `${step.now.slice(0, 40)}…` : step.now;
  return JSON.stringify(text);
}
