// Changes in several places in the text at the cursor, and form fills. While Claude proposes them, they're
// checked against the text (or form) as it is now; when the person applies the card, they're written in:
// over AT-SPI where the app takes writes (GTK), by selecting each piece over AT-SPI and pasting over it where
// it doesn't (Firefox, Zen), or with Google Docs' own Find and replace.
import { clipboard } from "electron";
import type { FieldValue, FormField, TextChange, ToolResult } from "@kiki/shared";
import type { ActionStatus } from "../shared-types.ts";
import type { EditTarget, FieldTarget, FormTarget } from "./capture/common.ts";
import { runHelper } from "./capture/linux.ts";
import { clipboardForPaste, keepClipboard } from "./clipboard.ts";
import { focusSource, keysToSource, pasteToSource } from "./gnomeShell.ts";
import { plural } from "./google/format.ts";

/** Why a change can't go in, from the helper's --check-changes. */
export type ChangeStatus = "ok" | "missing" | "ambiguous" | "spans" | "overlaps";

interface CheckResult {
  ok: boolean;
  reason?: string;
  results?: Array<{ status: ChangeStatus; count: number }>;
}

interface ApplyResult {
  ok: boolean;
  reason?: string;
  applied?: number[];
  results?: Array<{ status: ChangeStatus; count: number }>;
}

interface SelectResult {
  ok: boolean;
  reason?: string;
  count?: number;
  path?: number[] | null;
  role?: string | null;
  start?: number;
}

interface Place {
  pid: number;
  path: number[];
  role?: string;
}

const quote = (text: string, max = 80) => JSON.stringify(text.length > max ? `${text.slice(0, max)}…` : text);

/** What Claude hears about changes that don't fit the text; null when they all do. */
export function changeProblems(changes: TextChange[], results: Array<{ status: ChangeStatus; count: number }>): string | null {
  const lines = changes.flatMap((change, index) => {
    const what = `Change ${index + 1}: ${quote(change.find)}`;
    switch (results[index]?.status ?? "missing") {
      case "ok":
        return [];
      case "missing":
        return [`${what} isn't in the text. Copy it exactly, spaces and punctuation included.`];
      case "ambiguous":
        return [`${what} appears ${results[index]!.count} times; include more of the words around it so it appears once.`];
      case "spans":
        return [`${what} runs from one line or paragraph into the next; make one change per line.`];
      case "overlaps":
        return [`${what} overlaps an earlier change; merge them into one.`];
    }
  });
  if (lines.length === 0) return null;
  return `${lines.join("\n")}\nThe other changes fit. Propose them all again, with these fixed or left out.`;
}

/** Checks proposed changes against the text the cursor is in, as it is now. */
export async function checkChanges(target: EditTarget | undefined, changes: TextChange[]): Promise<Omit<ToolResult, "id">> {
  if (target?.kind === "docs") {
    // Kiki can't read a Google Doc: its Find and replace checks each change as it goes.
    return { content: "Kiki applies these with Docs' Find and replace, which skips any it doesn't find exactly once." };
  }
  if (!target?.atspi) return { content: "Kiki can't change the text in this window.", isError: true };
  try {
    const result = await runHelper<CheckResult>(["--check-changes", JSON.stringify({ ...placeOf(target), changes })], 5_000);
    if (!result.ok || !result.results) return { content: "Kiki can't read that text anymore; the window closed or changed.", isError: true };
    const problems = changeProblems(changes, result.results);
    return problems ? { content: problems, isError: true } : { content: `All ${plural(changes.length, "change")} fit the text.` };
  } catch (error) {
    return { content: `Kiki couldn't check the text: ${String(error)}`, isError: true };
  }
}

function placeOf(target: EditTarget): Place {
  const { pid, path, role } = target.atspi!;
  return { pid, path, ...(role ? { role } : {}) };
}

/**
 * `text` with each change made where its `find` is the only match in it, as the helper finds them: in the
 * text as it was, not after the other changes. Changes that are missing, ambiguous or overlap are left out.
 */
export function newText(text: string, changes: TextChange[]): string {
  const spans: Array<{ start: number; end: number; replace: string }> = [];
  for (const change of changes) {
    const start = text.indexOf(change.find);
    if (start < 0 || text.indexOf(change.find, start + 1) >= 0) continue;
    const end = start + change.find.length;
    if (spans.some((span) => start < span.end && span.start < end)) continue;
    spans.push({ start, end, replace: change.replace });
  }
  let out = text;
  for (const span of spans.sort((a, b) => b.start - a.start)) out = out.slice(0, span.start) + span.replace + out.slice(span.end);
  return out;
}

async function selectThen(place: Place, how: Record<string, unknown>): Promise<SelectResult> {
  try {
    return await runHelper<SelectResult>(["--select", JSON.stringify({ ...place, ...how })], 5_000);
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}

/** Whether `text` is at `start` in the object --select chose, after a paste. */
async function landed(pid: number, selected: SelectResult, text: string): Promise<boolean> {
  if (!selected.path || selected.start === undefined) return true;
  try {
    const request = { pid, path: selected.path, ...(selected.role ? { role: selected.role } : {}), start: selected.start, text };
    return (await runHelper<{ ok: boolean }>(["--verify", JSON.stringify(request)], 5_000)).ok;
  } catch {
    return false;
  }
}

/**
 * Selects `how` (a {find}, a {start, end, expected}, or {all}) in the source window over AT-SPI and pastes
 * `text` over it (deletes it when `text` is empty). The window has to have focus first: a text field drops a
 * selection made in the background. So `text` goes on the clipboard before that, while Kiki still has the
 * keyboard, if it does (`kikiHasKeyboard`); after that, only the GNOME helper can put it there.
 */
export async function selectAndPaste(
  place: Place,
  how: Record<string, unknown>,
  text: string,
  kikiHasKeyboard: boolean,
): Promise<SelectResult & { pasted?: boolean }> {
  if (text && !(await clipboardForPaste(text, kikiHasKeyboard))) return { ok: false, reason: "helper" };
  if (!(await focusSource())) return { ok: false, reason: "focus" };
  const selected = await selectThen(place, how);
  if (!selected.ok) return selected;
  if (!(await (text ? pasteToSource(false) : keysToSource(["backspace"])))) return { ...selected, ok: false, reason: "focus" };
  return { ...selected, pasted: true, ok: await landed(place.pid, selected, text) };
}

const REASONS: Record<string, string> = {
  missing: "isn't there anymore",
  ambiguous: "is there more than once now",
  spans: "runs across two lines",
  overlaps: "overlaps another change",
  changed: "isn't there anymore",
  not_selected: "couldn't be selected",
  focus: "couldn't be reached",
  helper: "needs Kiki's newer GNOME helper: update it in Settings, then log out and back in",
  gone: "is gone",
};

/** "Applied 2 of 3 changes in Zen. Not changed: "teh" (isn't there anymore)." */
function summary(done: number, total: number, noun: string, verb: string, where: string, failed: string[]): string {
  const count = done === total ? plural(total, noun) : `${done} of ${plural(total, noun)}`;
  return `${verb} ${count}${where}.${failed.length ? ` Not ${verb.toLowerCase()}: ${failed.join("; ")}.` : ""}`;
}

/** Runs a changes card's button. Throws with a message for the card when nothing went in. */
export async function applyChanges(
  target: EditTarget | undefined,
  changes: TextChange[],
  mode: "apply" | "copy",
  appName: string | undefined,
): Promise<ActionStatus> {
  if (mode === "copy") {
    if (!target?.full) throw new Error("Kiki doesn't have the whole text to copy.");
    await clipboard.writeText(newText(target.full.text, changes));
    return { outcome: "copied", message: "Copied the whole text with the changes." };
  }
  const where = appName ? ` in ${appName}` : "";
  if (target?.kind === "docs") return applyInDocs(target, changes, where);
  if (!target?.atspi) throw new Error("Kiki can't change the text in this window.");

  const failed: string[] = [];
  let done = 0;
  if (!target.selectPaste) {
    const result = await runHelper<ApplyResult>(["--apply-changes", JSON.stringify({ ...placeOf(target), changes })], 10_000).catch(
      (error: unknown): ApplyResult => ({ ok: false, reason: String(error) }),
    );
    done = result.applied?.length ?? 0;
    if (!result.ok && result.results) {
      const problems = changes.flatMap((change, index) =>
        result.results![index]?.status === "ok" ? [] : [`${quote(change.find, 40)} (${REASONS[result.results![index]!.status] ?? "failed"})`],
      );
      throw new Error(`The text changed since Kiki read it: ${problems.join("; ")}. Ask again, or copy this.`);
    }
    if (!result.ok && done === 0) throw new Error("Kiki couldn't write there. Copy the text instead.");
    if (!result.ok) failed.push(`${changes.length - done} (the app refused a write)`);
  } else {
    // The person's clipboard comes back afterwards: Kiki pasted several times through it.
    const restore = await keepClipboard();
    try {
      // Only the first change starts with the keyboard on Kiki: each one hands it to the window.
      for (const [index, change] of [...changes].reverse().entries()) {
        const result = await selectAndPaste(placeOf(target), { find: change.find }, change.replace, index === 0);
        if (result.ok) done++;
        else if (result.pasted) failed.push(`${quote(change.find, 40)} (pasted, but Kiki couldn't confirm it)`);
        else failed.push(`${quote(change.find, 40)} (${REASONS[result.reason ?? ""] ?? "failed"})`);
        if (result.reason === "focus" || result.reason === "helper") break;
      }
    } finally {
      await restore();
    }
    if (done === 0 && !failed.some((line) => line.includes("pasted"))) {
      throw new Error(`Kiki couldn't make these changes: ${failed.join("; ")}.`);
    }
  }
  if (target.full) target.full = { ...target.full, text: newText(target.full.text, changes) };
  return { outcome: "applied", message: summary(done, changes.length, "change", "Applied", where, failed) };
}

/** The parts of Docs' Find and replace dialog Kiki uses, from --docs-dialog. */
export interface DocsDialog {
  fields: Array<{ path: number[]; role?: string; name: string; text: string }>;
  checks: Array<{ path: number[]; role?: string; name: string; checked: boolean }>;
  buttons: Array<{ path: number[]; role?: string; name: string }>;
  count: string | null;
}

/** Picks the Find and Replace-with fields, the case and regular-expression boxes, and Replace all. */
export function docsParts(dialog: DocsDialog) {
  const named = <T extends { name: string }>(items: T[], pattern: RegExp) => items.find((item) => pattern.test(item.name));
  const replace = named(dialog.fields, /replace/i) ?? dialog.fields[1];
  const find = named(dialog.fields.filter((field) => field !== replace), /find/i) ?? dialog.fields.find((field) => field !== replace);
  return {
    find,
    replace,
    matchCase: named(dialog.checks, /case/i),
    regex: named(dialog.checks, /regular|regex/i),
    replaceAll: named(dialog.buttons, /^replace all$/i),
  };
}

/** How many matches Docs' count shows: "1 of 3" is 3, "No results" is 0, null when it shows none. */
export function docsMatches(count: string | null): number | null {
  if (!count) return null;
  if (/no results/i.test(count)) return 0;
  const match = /(\d+)\s+of\s+(\d+)/.exec(count);
  return match ? Number(match[2]) : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function docsDialog(pid: number, wait: number): Promise<DocsDialog | null> {
  try {
    const result = await runHelper<{ ok: boolean } & DocsDialog>(["--docs-dialog", JSON.stringify({ pid, wait })], (wait + 5) * 1_000);
    return result.ok ? result : null;
  } catch {
    return null;
  }
}

async function press(pid: number, item: { path: number[]; role?: string }, checked?: boolean): Promise<boolean> {
  const request = { pid, path: item.path, ...(item.role ? { role: item.role } : {}), ...(checked === undefined ? {} : { checked }) };
  return (await runHelper<{ ok: boolean }>(["--press", JSON.stringify(request)], 5_000).catch(() => ({ ok: false }))).ok;
}

/**
 * Makes each change with Google Docs' Find and replace: Ctrl+H opens it, Kiki pastes the text to find and
 * goes on only when Docs counts exactly one match, then pastes the replacement and presses Replace all.
 */
async function applyInDocs(target: EditTarget, changes: TextChange[], where: string): Promise<ActionStatus> {
  if (!target.keys || !target.pid) {
    throw new Error("Update Kiki's GNOME helper in Settings (then log out and back in) so Kiki can use Docs' Find and replace.");
  }
  const pid = target.pid;
  // Saved while Kiki has the keyboard: Ctrl+H hands it to the document.
  const restore = await keepClipboard();
  if (!(await keysToSource(["ctrl+h"]))) throw new Error(`Kiki couldn't get back to the document.`);
  const dialog = await docsDialog(pid, 3);
  const parts = dialog && docsParts(dialog);
  if (!parts?.find || !parts.replace || !parts.replaceAll) {
    await keysToSource(["escape"]);
    throw new Error("Kiki couldn't find Docs' Find and replace. Copy the changes instead.");
  }
  const failed: string[] = [];
  let done = 0;
  try {
    // Exact text only: matching case on, regular expressions off. Without Match case, the count of one
    // match (any case) still means at most one exact one.
    if (parts.matchCase) await press(pid, parts.matchCase, true);
    if (parts.regex && !(await press(pid, parts.regex, false))) throw new Error("Kiki couldn't turn off regular expressions in Docs.");
    for (const change of changes) {
      const typed = await selectAndPaste(place(pid, parts.find), { all: true }, change.find, false);
      if (typed.reason === "helper") {
        failed.push(`${quote(change.find, 40)} (${REASONS.helper})`);
        break;
      }
      if (!typed.pasted) {
        failed.push(`${quote(change.find, 40)} (couldn't type it in Find)`);
        continue;
      }
      await sleep(400);
      const matches = docsMatches((await docsDialog(pid, 0))?.count ?? null);
      if (matches !== 1) {
        failed.push(`${quote(change.find, 40)} (${matches === null ? "Docs showed no count" : `found ${plural(matches, "time")}`})`);
        continue;
      }
      const replaced = await selectAndPaste(place(pid, parts.replace), { all: true }, change.replace, false);
      if (!replaced.pasted && change.replace) {
        failed.push(`${quote(change.find, 40)} (couldn't type the replacement)`);
        continue;
      }
      if (!(await press(pid, parts.replaceAll))) {
        failed.push(`${quote(change.find, 40)} (Replace all didn't respond)`);
        continue;
      }
      await sleep(300);
      done++;
    }
  } finally {
    await keysToSource(["escape"]);
    await restore();
  }
  if (done === 0) throw new Error(`Kiki couldn't make these changes: ${failed.join("; ")}.`);
  return { outcome: "applied", message: summary(done, changes.length, "change", "Applied", where, failed) };
}

function place(pid: number, item: { path: number[]; role?: string }): Place {
  return { pid, path: item.path, ...(item.role ? { role: item.role } : {}) };
}

/** What Claude hears about values that don't fit the form; null when they all do. */
export function fillProblems(form: FormTarget | undefined, values: FieldValue[]): string | null {
  if (!form) return "Kiki can't fill a form in this window.";
  const lines = values.flatMap((item) => {
    const field = form.fields.find((candidate) => candidate.id === item.field);
    if (!field) return [`${item.field} isn't one of the fields in <form_fields>.`];
    const toggle = field.kind === "checkbox" || field.kind === "radio";
    if (toggle && typeof item.value !== "boolean") return [`${item.field} is a ${field.kind}: use true or false.`];
    if (!toggle && typeof item.value !== "string") return [`${item.field} is a text field: give it text.`];
    if (field.kind === "radio" && item.value === false) return [`${item.field} is a radio button: pick another option instead of unchecking it.`];
    if (field.kind === "text" && typeof item.value === "string" && item.value.includes("\n")) {
      return [`${item.field} takes one line of text.`];
    }
    return [];
  });
  return lines.length ? `${lines.join("\n")}\nPropose the fill again with these fixed or left out.` : null;
}

/** The fields as Claude sees them, without where they are. */
export function formFields(form: FormTarget): FormField[] {
  return form.fields.map(({ path: _path, role: _role, length: _length, ...field }) => field);
}

async function fillOne(form: FormTarget, field: FieldTarget, value: string | boolean, kikiHasKeyboard: boolean): Promise<string | null> {
  const where = place(form.pid, field);
  if (typeof value === "boolean") return (await press(form.pid, field, value)) ? null : "couldn't be clicked";
  if (!form.selectPaste) {
    const request = { ...where, start: 0, expected: field.value ?? "", text: value, whole: true };
    const result = await runHelper<{ ok: boolean; reason?: string }>(["--edit", JSON.stringify(request)], 5_000).catch(() => ({
      ok: false,
      reason: "failed",
    }));
    if (result.ok) return null;
    return result.reason === "changed" ? "changed since Kiki read it" : "didn't take the text";
  }
  const result = await selectAndPaste(where, { all: true, expected: field.value ?? "" }, value, kikiHasKeyboard);
  if (result.ok) return null;
  return result.pasted ? "pasted, but Kiki couldn't confirm it" : (REASONS[result.reason ?? ""] ?? "failed");
}

/** Runs a fill card's Fill button. Throws with a message for the card when nothing was filled. */
export async function applyFill(form: FormTarget | undefined, values: FieldValue[], appName: string | undefined): Promise<ActionStatus> {
  if (!form) throw new Error("Kiki can't fill a form in this window.");
  const restore = form.selectPaste ? await keepClipboard() : async () => {};
  const failed: string[] = [];
  const needHelper: string[] = [];
  let done = 0;
  // Until the first paste hands the keyboard to the window; check boxes are clicked without it.
  let kikiHasKeyboard = true;
  try {
    for (const item of values) {
      const field = form.fields.find((candidate) => candidate.id === item.field);
      const problem = field ? await fillOne(form, field, item.value, kikiHasKeyboard) : "isn't on the page anymore";
      if (field && form.selectPaste && typeof item.value === "string") kikiHasKeyboard = false;
      if (problem === REASONS.helper) {
        needHelper.push(field!.label);
        continue;
      }
      if (problem) {
        failed.push(`${field?.label || item.field} (${problem})`);
        continue;
      }
      done++;
      // What's there now, for the next fill.
      if (typeof item.value === "boolean") field!.checked = item.value;
      else field!.value = item.value.slice(0, 200);
    }
  } finally {
    await restore();
  }
  if (needHelper.length > 0) failed.push(`${needHelper.join(", ")} (${REASONS.helper})`);
  if (done === 0) throw new Error(`Kiki couldn't fill these: ${failed.join("; ")}.`);
  return { outcome: "applied", message: summary(done, values.length, "field", "Filled", appName ? ` in ${appName}` : "", failed) };
}
