// Writes an edit card's text into the window the question came from: straight into its text over AT-SPI
// where it can, else by pasting it there, else onto the clipboard for the person to paste.
import type { ChangesMode } from "@kiki/shared";
import { clipboard } from "electron";
import type { ActionMode, ActionStatus, EditInfo } from "../shared-types.ts";
import type { EditTarget } from "./capture/common.ts";
import { runHelper } from "./capture/linux.ts";
import { pasteIntoApp } from "./capture/mac.ts";
import { selectAndPaste } from "./changes.ts";
import { clipboardForPaste } from "./clipboard.ts";
import { pasteToSource } from "./gnomeShell.ts";

interface HelperEditResult {
  ok: boolean;
  reason?: "gone" | "changed" | "not_editable" | "failed";
  error?: string;
  /** Where the new text is, in characters. */
  start?: number;
  end?: number;
}

const PASTE_KEYS = process.platform === "darwin" ? "Cmd+V" : "Ctrl+V";

/**
 * Where changes cards can go: the text at the cursor, which Kiki can write in over AT-SPI or by selecting
 * and pasting ("text"), or a Google Doc, through its Find and replace with the GNOME helper's keys ("docs").
 */
export function changesMode(target: EditTarget | undefined): ChangesMode | undefined {
  if (target?.kind === "docs") return target.keys ? "docs" : undefined;
  return target?.atspi && target.kind !== "terminal" ? "text" : undefined;
}

/** What the popup's edit cards show about the target. */
export function editInfo(target: EditTarget | undefined): EditInfo | undefined {
  if (!target) return undefined;
  const changes = changesMode(target);
  return {
    mode: target.mode,
    kind: target.kind,
    original: target.original.slice(0, 300),
    ...(changes ? { changes } : {}),
    ...(target.full ? { wholeText: true } : {}),
  };
}

/**
 * After a write, the target is what's there now, so a follow-up ("shorter") edits Kiki's text. A direct
 * write knows where the new text is; a paste leaves the cursor after it, with nothing highlighted.
 */
export function retarget(target: EditTarget, text: string, written?: { start: number; end: number }): void {
  if (target.atspi && written && target.kind !== "terminal") {
    target.atspi = { ...target.atspi, start: written.start, end: written.end };
    target.mode = "replace";
    target.original = text;
    return;
  }
  delete target.atspi;
  target.mode = "insert";
  target.original = "";
}

async function writeOverAtspi(target: EditTarget, text: string): Promise<HelperEditResult> {
  try {
    const request = { ...target.atspi, expected: target.original, text };
    return await runHelper<HelperEditResult>(["--edit", JSON.stringify(request)], 5_000);
  } catch (error) {
    return { ok: false, reason: "failed", error: String(error) };
  }
}

/**
 * Runs a button on an edit card: "apply" writes the text at the target, "copy" puts it on the clipboard.
 * Throws with a message for the card when it can't; the card stays open, with Copy.
 */
export async function applyEdit(
  target: EditTarget | undefined,
  text: string,
  mode: ActionMode,
  appName: string | undefined,
): Promise<ActionStatus> {
  if (mode === "dismiss") return { outcome: "dismissed", message: "Dismissed." };
  if (mode === "copy" || !target) {
    await clipboard.writeText(text);
    return { outcome: "copied", message: `Copied. Paste it with ${PASTE_KEYS}.` };
  }
  const where = appName ? ` in ${appName}` : "";

  // GNOME drops a clipboard write from Kiki once it has handed the keyboard to the window it pastes into.
  let kikiHasKeyboard = true;
  let onClipboard = false;
  // Firefox and Zen take no AT-SPI writes: select the original there, and paste over it.
  if (target.atspi && target.selectPaste) {
    const { pid, path, role, start, end } = target.atspi;
    const message = target.mode === "replace" ? `Replaced${where}.` : `Inserted${where}.`;
    const place = { pid, path, ...(role ? { role } : {}) };
    const result = await selectAndPaste(place, { start, end, expected: target.original }, text, true);
    if (result.pasted) {
      const written = result.start !== undefined ? { start: result.start, end: result.start + text.length } : undefined;
      retarget(target, text, written);
      return { outcome: "applied", message: result.ok ? message : `${message.slice(0, -1)}; Kiki couldn't confirm it. Check it there.` };
    }
    if (result.reason === "changed") {
      throw new Error("The text changed since Kiki read it. Highlight it again and ask, or copy this.");
    }
    console.warn("[kiki] select and paste:", result.reason);
    // It put the text on the clipboard first, then focused the window: the paste below uses that.
    kikiHasKeyboard = false;
    onClipboard = Boolean(text);
  } else if (target.atspi) {
    const result = await writeOverAtspi(target, text);
    if (result.ok) {
      const message = target.mode === "replace" ? `Replaced${where}.` : `Inserted${where}.`;
      const written = result.start !== undefined && result.end !== undefined ? { start: result.start, end: result.end } : undefined;
      retarget(target, text, written);
      return { outcome: "applied", message };
    }
    if (result.reason === "changed") {
      throw new Error("The text changed since Kiki read it. Highlight it again and ask, or copy this.");
    }
    console.warn("[kiki] edit over accessibility:", result.reason ?? result.error);
    if (!target.paste) throw new Error(`Kiki couldn't write there. Copy this and paste it with ${PASTE_KEYS}.`);
  }

  // A trailing newline would run a terminal command as it's pasted.
  const terminal = target.kind === "terminal";
  if (!onClipboard && !(await clipboardForPaste(terminal ? text.replace(/\n+$/, "") : text, kikiHasKeyboard))) {
    throw new Error(`Kiki couldn't paste there. Copy this and paste it with ${PASTE_KEYS}.`);
  }
  const pasted = target.macPid ? await pasteIntoApp(target.macPid) : target.paste ? await pasteToSource(terminal) : false;
  if (!pasted) {
    throw new Error(`Kiki couldn't get back to ${appName ?? "the window"}. It's on your clipboard: paste it with ${PASTE_KEYS}.`);
  }
  retarget(target, text);
  return { outcome: "applied", message: `Pasted${where}. It's on your clipboard too.` };
}
