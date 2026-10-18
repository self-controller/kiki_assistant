import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Calls Kiki's GNOME Shell extension (resources/gnome-extension) over D-Bus. */
export async function callExtension(timeoutMs: number, method: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(
    "gdbus",
    [
      "call",
      "--session",
      "--dest",
      "org.gnome.Shell",
      "--object-path",
      "/app/kiki/Shell",
      "--method",
      `app.kiki.Shell.${method}`,
      ...args,
    ],
    { timeout: timeoutMs },
  );
  return stdout;
}

/**
 * Tells Kiki's GNOME extension to remember the focused window and the pointer, so `captureSource` can
 * take a screenshot of them later, even under Kiki's popup, and `pasteToSource` can paste into it.
 * Returns the extension's version, or null without a focused window, or without version 3 of the
 * extension (it loads at the next login).
 */
export async function rememberSource(): Promise<number | null> {
  try {
    // "(uint32 3, true)"
    const out = await callExtension(1_000, "RememberSource");
    return out.includes("true") ? Number(out.match(/(?<!\w)\d+/)?.[0] ?? 0) : null;
  } catch {
    return null;
  }
}

/** The extension version that has `pasteToSource`. */
export const PASTE_VERSION = 6;

/**
 * Focuses the window `rememberSource` saw and types the paste shortcut there (Ctrl+Shift+V in a
 * terminal). False when the window is gone, or won't take focus.
 */
export async function pasteToSource(terminal: boolean): Promise<boolean> {
  try {
    // "(uint32 6, true)"
    return (await callExtension(3_000, "PasteToSource", terminal ? "true" : "false")).includes("true");
  } catch {
    return false;
  }
}

/** The extension version that has `focusSource` and `keysToSource`. */
export const KEYS_VERSION = 7;

/** Shortcuts `keysToSource` presses; the extension refuses any others. */
export type KeyStep =
  | "ctrl+a"
  | "ctrl+f"
  | "ctrl+h"
  | "ctrl+v"
  | "ctrl+shift+v"
  | "backspace"
  | "escape"
  | "enter"
  | "tab";

/**
 * Focuses the window `rememberSource` saw and waits until it has the keyboard, so Kiki can select text in it
 * over accessibility and paste. False when the window is gone, or won't take focus.
 */
export async function focusSource(): Promise<boolean> {
  try {
    // "(uint32 7, true)"
    return (await callExtension(3_000, "FocusSource")).includes("true");
  } catch {
    return false;
  }
}

/** Focuses the window `rememberSource` saw and presses `steps` there, in order. False when it couldn't. */
export async function keysToSource(steps: KeyStep[]): Promise<boolean> {
  try {
    const list = `[${steps.map((step) => `'${step}'`).join(", ")}]`;
    return (await callExtension(3_000 + steps.length * 500, "KeysToSource", list)).includes("true");
  } catch {
    return false;
  }
}

/**
 * A PNG of the window `rememberSource` saw, around the pointer, at most `maxWidth`×`maxHeight` (logical
 * pixels). Returns the file's path, or null when the window is gone.
 */
export async function captureSource(maxWidth: number, maxHeight: number): Promise<string | null> {
  try {
    // "(uint32 3, '/run/user/1000/kiki/source.png')"
    const out = await callExtension(3_000, "CaptureSource", String(maxWidth), String(maxHeight));
    return out.match(/'([^']+)'/)?.[1] ?? null;
  } catch {
    return null;
  }
}
