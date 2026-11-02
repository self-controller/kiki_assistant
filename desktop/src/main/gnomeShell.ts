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
    runningVersion = Number(out.match(/(?<!\w)\d+/)?.[0] ?? 0);
    return out.includes("true") ? runningVersion : null;
  } catch {
    return null;
  }
}

/** The extension's version as `rememberSource` last saw it: 0 before the first hotkey, or without the extension. */
let runningVersion = 0;

/** The running extension's version, from the last hotkey (0 without it); it only changes at a login. */
export function extensionVersion(): number {
  return runningVersion;
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

/**
 * Shortcuts `keysToSource` presses; the extension refuses any others. "backspace*N" presses Backspace N times
 * (v12, at most MAX_REPEATED_KEYS), for taking back text Kiki pasted at a terminal's prompt.
 */
export type KeyStep =
  | "ctrl+a"
  | "ctrl+f"
  | "ctrl+h"
  | "ctrl+v"
  | "ctrl+shift+v"
  | "ctrl+z"
  | "backspace"
  | `backspace*${number}`
  | "escape"
  | "enter"
  | "tab";

/** The extension version that presses Ctrl+Z and repeated Backspaces (Kiki's Undo button). */
export const UNDO_VERSION = 12;
/** The most Backspaces one step presses; the extension refuses more. */
export const MAX_REPEATED_KEYS = 2000;
/** About how long the extension takes per repeated key, for the call's timeout. */
const REPEATED_KEY_MS = 12;

/** How many key presses `steps` make, counting repeats. */
export function keyPresses(steps: KeyStep[]): number {
  return steps.reduce((sum, step) => sum + (Number(/^backspace\*(\d+)$/.exec(step)?.[1]) || 1), 0);
}

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
    const timeout = 3_000 + steps.length * 500 + keyPresses(steps) * REPEATED_KEY_MS;
    return (await callExtension(timeout, "KeysToSource", list)).includes("true");
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


/** `text` as a GVariant string in gdbus's text format: quoted, with backslashes, quotes and control characters escaped. */
export function gvariantString(text: string): string {
  const escaped = text.replace(/[\\'\u0000-\u001f\u007f]/g, (char) =>
    char === "\\" || char === "'" ? `\\${char}` : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `'${escaped}'`;
}

/**
 * Puts `text` on the clipboard from the shell. GNOME drops a clipboard write from an app that doesn't have
 * the keyboard, but the shell can write it whichever window does. False without version 9 of the extension.
 */
export async function setClipboard(text: string): Promise<boolean> {
  try {
    // "(uint32 9, true)"
    return (await callExtension(2_000, "SetClipboard", gvariantString(text))).includes("true");
  } catch {
    return false;
  }
}

/** The extension version that has `scrollSource`. */
export const SCROLL_VERSION = 8;

/** What `scrollSource` did: scrolled, or why not (see the extension's ScrollSource). */
export const SCROLL_OUTCOMES = ["scrolled", "gone", "hidden", "busy", "covered"] as const;
export type ScrollOutcome = (typeof SCROLL_OUTCOMES)[number];

/**
 * Scrolls the window `rememberSource` saw by `percent` of its height plus `pixels` (down when positive), with
 * a virtual touchpad over it; the focus stays with Kiki. Null when the extension can't.
 */
export async function scrollSource(percent: number, pixels: number): Promise<ScrollOutcome | null> {
  try {
    // "(uint32 8, 'scrolled')". Typed, so gdbus doesn't take a negative number for an option.
    const out = await callExtension(5_000, "ScrollSource", `int32 ${Math.round(percent)}`, `int32 ${Math.round(pixels)}`);
    const outcome = out.match(/'([a-z]+)'/)?.[1];
    return (SCROLL_OUTCOMES as readonly string[]).includes(outcome ?? "") ? (outcome as ScrollOutcome) : null;
  } catch {
    return null;
  }
}

/** The extension version that has `sourceApp`. */
export const SOURCE_APP_VERSION = 11;

/** The app the window `rememberSource` saw belongs to, as Kiki's GNOME extension knows it. */
export interface ShellApp {
  /** The desktop file's id, e.g. "google-chrome.desktop"; empty when GNOME can't tell. */
  id: string;
  name: string;
  wmClass: string;
  /** A flatpak's app id. */
  sandboxedId: string;
  title: string;
  pid: number;
}

const GVARIANT_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", a: "\u0007" };

/** The first string in gdbus's text output, unquoted and unescaped; the inverse of `gvariantString`. Null when there's none. */
export function parseGVariantString(out: string): string | null {
  const start = out.search(/['"]/);
  if (start < 0) return null;
  const quote = out[start];
  let text = "";
  for (let i = start + 1; i < out.length; i++) {
    const char = out[i]!;
    if (char === quote) return text;
    if (char !== "\\") {
      text += char;
      continue;
    }
    const next = out[++i] ?? "";
    const hex = next === "u" ? 4 : next === "U" ? 8 : 0;
    if (hex) {
      text += String.fromCodePoint(parseInt(out.slice(i + 1, i + 1 + hex), 16));
      i += hex;
    } else {
      text += GVARIANT_ESCAPES[next] ?? next;
    }
  }
  return null;
}

/** What `sourceApp` reads from the extension's JSON, or null when it isn't one. */
export function parseShellApp(json: string): ShellApp | null {
  try {
    const value = JSON.parse(json) as Partial<Record<keyof ShellApp, unknown>>;
    const text = (key: keyof ShellApp) => (typeof value[key] === "string" ? (value[key] as string) : "");
    if (!text("id") && !text("wmClass") && !text("sandboxedId")) return null;
    return {
      id: text("id"),
      name: text("name"),
      wmClass: text("wmClass"),
      sandboxedId: text("sandboxedId"),
      title: text("title"),
      pid: typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 ? value.pid : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Which app the window `rememberSource` saw belongs to: works for every window, including apps that share
 * nothing over accessibility (VS Code, most terminals). Null without version 11 of the extension.
 */
export async function sourceApp(): Promise<ShellApp | null> {
  try {
    // "(uint32 11, '{"id":"google-chrome.desktop",...}')"
    const json = parseGVariantString(await callExtension(1_000, "SourceApp"));
    return json ? parseShellApp(json) : null;
  } catch {
    return null;
  }
}

/**
 * The extension version that lists the desktop's windows, takes one of them as the source, starts apps, clicks
 * and drags at coordinates, presses key chords, and shows the "Kiki is using your computer" banner.
 */
export const WINDOWS_VERSION = 13;

/** A window on the desktop, as Kiki's GNOME extension lists it (v13). */
export interface ShellWindow {
  /** The window's id in GNOME Shell, stable while it's open. */
  id: string;
  pid: number;
  /** The desktop file's id, e.g. "org.gnome.Nautilus.desktop"; empty when GNOME can't tell. */
  app: string;
  /** The app's name, e.g. "Files". */
  name: string;
  wmClass: string;
  sandboxedId: string;
  title: string;
  focused: boolean;
  minimized: boolean;
  /** On the workspace the person is looking at. */
  onWorkspace: boolean;
  /** One of Kiki's own windows. */
  kiki: boolean;
  /** The window the hotkey was pressed in (the extension's remembered source), while Kiki hasn't switched. */
  source: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

/** The windows in the extension's JSON, or [] when it isn't a list of them. */
export function parseShellWindows(json: string): ShellWindow[] {
  try {
    const list = JSON.parse(json) as unknown;
    if (!Array.isArray(list)) return [];
    return list.flatMap((item): ShellWindow[] => {
      if (typeof item !== "object" || item === null) return [];
      const w = item as Record<string, unknown>;
      const id = typeof w["id"] === "number" ? String(w["id"]) : str(w["id"]);
      if (!id) return [];
      return [
        {
          id,
          pid: int(w["pid"]),
          app: str(w["app"]),
          name: str(w["name"]),
          wmClass: str(w["wmClass"]),
          sandboxedId: str(w["sandboxedId"]),
          title: str(w["title"]),
          focused: w["focused"] === true,
          minimized: w["minimized"] === true,
          onWorkspace: w["onWorkspace"] !== false,
          kiki: w["kiki"] === true,
          source: w["source"] === true,
          x: int(w["x"]),
          y: int(w["y"]),
          width: int(w["width"]),
          height: int(w["height"]),
        },
      ];
    });
  } catch {
    return [];
  }
}

/** The windows open on the desktop, top of the stack first. Null without version 13 of the extension. */
export async function listWindows(): Promise<ShellWindow[] | null> {
  try {
    // "(uint32 13, '[{"id":"1234",...}]')"
    const json = parseGVariantString(await callExtension(2_000, "ListWindows"));
    return json === null ? null : parseShellWindows(json);
  } catch {
    return null;
  }
}

/**
 * Makes `id` (from `listWindows`) the source window: what screenshots, scrolls, pastes, keys and clicks at
 * coordinates act on, until the next hotkey or `selectSource`. False when it's gone, or without v13.
 */
export async function selectSource(id: string): Promise<boolean> {
  try {
    // "(uint32 13, true)"
    return (await callExtension(1_000, "SelectSource", gvariantString(id))).includes("true");
  } catch {
    return false;
  }
}

/** An installed app, as the extension lists it. */
export interface ShellAppInfo {
  /** The desktop file's id, for `launchApp`. */
  id: string;
  name: string;
}

/** The apps installed on this computer that show in the app grid. Null without v13. */
export async function listApps(): Promise<ShellAppInfo[] | null> {
  try {
    const json = parseGVariantString(await callExtension(3_000, "ListApps"));
    if (json === null) return null;
    const list = JSON.parse(json) as unknown;
    if (!Array.isArray(list)) return [];
    return list.flatMap((item): ShellAppInfo[] => {
      const app = item as Record<string, unknown>;
      return typeof app?.["id"] === "string" && typeof app["name"] === "string" ? [{ id: app["id"], name: app["name"] }] : [];
    });
  } catch {
    return null;
  }
}

/** Starts the app with desktop id `id` (or brings it up when it's running). False when GNOME doesn't know it. */
export async function launchApp(id: string): Promise<boolean> {
  try {
    return (await callExtension(5_000, "LaunchApp", gvariantString(id))).includes("true");
  } catch {
    return false;
  }
}

/** What a click or drag at coordinates did: done, or why not (as `scrollSource`, plus "covered" after raising failed). */
export const POINTER_OUTCOMES = ["done", "gone", "hidden", "busy", "covered", "cancelled"] as const;
export type PointerOutcome = (typeof POINTER_OUTCOMES)[number];

function pointerOutcome(out: string): PointerOutcome | null {
  const outcome = out.match(/'([a-z]+)'/)?.[1];
  return (POINTER_OUTCOMES as readonly string[]).includes(outcome ?? "") ? (outcome as PointerOutcome) : null;
}

/**
 * Clicks in the source window at (`x`, `y`), fractions (0 to 1) of its width and height, with the virtual
 * pointer. The window is raised first when something covers that spot. Null without v13.
 */
export async function clickAt(x: number, y: number, button: "left" | "right" | "middle", count: number): Promise<PointerOutcome | null> {
  try {
    const out = await callExtension(5_000, "ClickAt", `double ${fraction(x)}`, `double ${fraction(y)}`, gvariantString(button), `int32 ${Math.min(3, Math.max(1, Math.round(count)))}`);
    return pointerOutcome(out);
  } catch {
    return null;
  }
}

/** Drags the virtual pointer through `points` (fractions of the source window) with the button down. Null without v13. */
export async function dragPath(points: Array<{ x: number; y: number }>): Promise<PointerOutcome | null> {
  try {
    const flat = points.flatMap((point) => [fraction(point.x), fraction(point.y)]);
    const out = await callExtension(8_000, "DragPath", `[${flat.join(", ")}]`);
    return pointerOutcome(out);
  } catch {
    return null;
  }
}

function fraction(value: number): string {
  const clamped = Math.min(1, Math.max(0, value));
  // Always with a decimal point, so gdbus reads a double.
  return clamped.toFixed(4);
}

/**
 * Focuses the source window and presses a key chord there ("enter", "ctrl+a", "pageup"...): the extension's
 * whitelist of named keys, with ctrl, alt and shift. False when it couldn't, or without v13.
 */
export async function keyChord(chord: string): Promise<boolean> {
  try {
    return (await callExtension(3_000, "KeyChord", gvariantString(chord))).includes("true");
  } catch {
    return false;
  }
}

/**
 * Shows "Kiki is using your computer" at the top of the screen, with a Stop button; Esc stops too (both say
 * "stop" on Kiki's socket). False without v13.
 */
export async function showBanner(text: string): Promise<boolean> {
  try {
    return (await callExtension(1_000, "ShowBanner", gvariantString(text))).includes("true");
  } catch {
    return false;
  }
}

export async function hideBanner(): Promise<boolean> {
  try {
    return (await callExtension(1_000, "HideBanner")).includes("true");
  } catch {
    return false;
  }
}
