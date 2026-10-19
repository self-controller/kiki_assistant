import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, clipboard, nativeImage } from "electron";
import type { Screenshot } from "@kiki/shared";
import type { ScreenshotPolicy } from "../../shared-types.ts";
import type { FieldKind } from "@kiki/shared";
import { captureSource, KEYS_VERSION, PASTE_VERSION, rememberSource, SCROLL_VERSION } from "../gnomeShell.ts";
import {
  toScreenshot,
  type EditTarget,
  type FormTarget,
  type PageText,
  type RawCapture,
  type SourceWindow,
  type Vicinity,
} from "./common.ts";

const run = promisify(execFile);

/** The most of the focused window to send as a screenshot, in logical pixels: the strip around the pointer. */
const CROP = { width: 1400, height: 700 };
/** Screenshots while scrolling take the whole window (the extension's largest crop). */
const WHOLE_WINDOW = { width: 4096, height: 4096 };
/**
 * Reading a long web page over accessibility takes a couple of seconds. The quick read stops early so
 * the popup opens at once; the full read starts with it (while the source window is still active) and
 * is used for the first question.
 */
const QUICK_READ = { seconds: 0.8, timeoutMs: 2_500 };
const FULL_READ = { seconds: 5, timeoutMs: 7_000 };

interface HelperContext {
  ok: boolean;
  error?: string;
  appName?: string | null;
  windowTitle?: string | null;
  text?: string;
  selection?: string;
  source?: "document" | "window" | "terminal" | "editor" | "none";
  /** The read stopped at its time or size limit. */
  truncated?: boolean;
  /** Set for terminals and editors (source "terminal"/"editor"), instead of `text`. */
  vicinity?: Vicinity;
  /** Where `text` is scrolled to; see PageText. */
  focus?: number;
  /** The text object at the cursor, when it's editable or a terminal. */
  edit?: HelperEdit;
  /** The app's process and toolkit ("gtk", "gecko", "chromium"...). */
  pid?: number | null;
  toolkit?: string;
  /** The window's child index in its app, for reading it again later. */
  window?: number[] | null;
  /** A browser page's address. */
  url?: string;
  /** Fields a form fill could set, when the page or window has at least two. */
  fields?: HelperField[];
}

export interface HelperField {
  path: number[];
  role?: string | null;
  label: string;
  kind: FieldKind;
  onScreen: boolean;
  value?: string;
  length?: number;
  checked?: boolean;
}

interface HelperEdit {
  pid: number | null;
  path: number[];
  role?: string | null;
  start: number;
  end: number;
  /** The text at start..end: what an edit replaces. */
  expected: string;
  /** AT-SPI can write there; otherwise only a paste can. */
  editable: boolean;
  kind: "terminal" | "editor" | "field";
  toolkit?: string;
  /** The whole text (rich text flattened), for changes in several places; not for terminals or editors. */
  full?: { text: string; truncated?: boolean };
}

interface ScreenshotResult {
  screenshot?: Screenshot;
  error?: string;
}

interface HelperScreenshot {
  ok: boolean;
  error?: string;
  path?: string;
}

export function helperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "kiki_context.py")
    : join(app.getAppPath(), "resources", "kiki_context.py");
}

/** The system Python, which has PyGObject; a conda/venv python3 on PATH usually doesn't. */
function python(): string {
  return existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3";
}

export async function runHelper<T>(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const { stdout } = await run(python(), [helperPath(), ...args], {
    timeout: timeoutMs,
    signal,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

/**
 * The primary selection is "the last text highlighted anywhere". When a terminal or editor reports only
 * its caret, nothing is highlighted in it, so trust the primary selection only if that window shows it.
 */
export function primaryFitsVicinity(primary: string, vicinity: Vicinity | undefined): boolean {
  if (!vicinity || vicinity.anchor) return true;
  const squash = (text: string) => text.replace(/\s+/g, " ").trim();
  const needle = squash(primary);
  return !needle || squash(vicinity.before + vicinity.after).includes(needle);
}

async function readPrimarySelection(): Promise<string> {
  try {
    if (process.env.WAYLAND_DISPLAY) {
      const { stdout } = await run("wl-paste", ["--primary", "--no-newline", "--type", "text"], { timeout: 1500 });
      return stdout;
    }
    const { stdout } = await run("xclip", ["-o", "-selection", "primary"], { timeout: 1500 });
    return stdout;
  } catch {
    // wl-paste exits non-zero when nothing is selected; also covers a missing tool.
    return (await clipboard.selection?.readText().catch(() => "")) ?? "";
  }
}

/** Reads and deletes a screenshot file that was only for Kiki. */
async function takeImage(path: string, area: Screenshot["area"]): Promise<Screenshot | undefined> {
  const image = nativeImage.createFromPath(path);
  await unlink(path).catch(() => {});
  const screenshot = toScreenshot(image);
  return screenshot && { ...screenshot, area };
}

/**
 * The window the hotkey was pressed in, around the pointer, from Kiki's GNOME extension: no permission
 * prompt, no file left behind, and Kiki's popup doesn't show even when it's open on top.
 */
async function sourceScreenshot(size = CROP): Promise<ScreenshotResult> {
  const path = await captureSource(size.width, size.height);
  const screenshot = path ? await takeImage(path, size === CROP ? "pointer" : undefined).catch(() => undefined) : undefined;
  return screenshot ? { screenshot } : { error: "the GNOME helper couldn't take a screenshot" };
}

async function portalScreenshot(): Promise<ScreenshotResult> {
  try {
    const result = await runHelper<HelperScreenshot>(["--screenshot"], 15_000);
    if (!result.ok || !result.path) return { error: result.error ?? "no screenshot" };
    // The portal saves into the user's Pictures folder.
    return { screenshot: await takeImage(result.path, "screen") };
  } catch (error) {
    return { error: String(error) };
  }
}

/**
 * Toolkits whose AT-SPI text writes do nothing (Firefox and Zen: verified) or aren't known to work (Chromium,
 * Electron). Kiki selects the text there over AT-SPI and pastes over it.
 */
export const SELECT_PASTE_TOOLKITS = new Set(["gecko", "chromium"]);
const GOOGLE_DOC = /^https:\/\/docs\.google\.com\/document\/d\//;

/**
 * Where an edit card can write in the window the hotkey was pressed in: the editable text at its cursor
 * (directly over AT-SPI, by selecting it and pasting, or with a paste at the cursor), or, in an app that
 * shares no text at all (VS Code), wherever its cursor is, with a paste. `pasteReady`: the GNOME extension
 * remembered the window and can paste; `keysReady`: it can also focus the window and press shortcuts (v7).
 */
export function linuxEditTarget(
  context: HelperContext,
  selection: string,
  pasteReady: boolean,
  keysReady = false,
): EditTarget | undefined {
  // A Google Doc draws its text itself: Kiki pastes at its cursor, and changes it with its Find and replace.
  if (context.ok && context.url && GOOGLE_DOC.test(context.url) && context.pid && (pasteReady || keysReady)) {
    const keys = keysReady ? { keys: true } : {};
    return { mode: selection ? "replace" : "insert", original: selection, kind: "docs", paste: pasteReady, ...keys, pid: context.pid };
  }
  const { edit } = context;
  if (context.ok && edit) {
    const viaPaste = SELECT_PASTE_TOOLKITS.has(edit.toolkit ?? "");
    const selectPaste = viaPaste && keysReady && Boolean(edit.pid) && edit.kind !== "terminal";
    const atspi =
      (edit.editable && edit.pid && !viaPaste) || selectPaste
        ? { pid: edit.pid!, path: edit.path, ...(edit.role ? { role: edit.role } : {}), start: edit.start, end: edit.end }
        : undefined;
    if (!atspi && !pasteReady) return undefined;
    // What's highlighted in a terminal is its output: text goes in at the prompt.
    const original = edit.kind === "terminal" ? "" : edit.expected;
    return {
      mode: original ? "replace" : "insert",
      original,
      kind: edit.kind,
      ...(atspi ? { atspi } : {}),
      ...(selectPaste ? { selectPaste: true } : {}),
      // Changes in several places need the text, and a way to write in it.
      ...(atspi && edit.full ? { full: edit.full } : {}),
      paste: pasteReady,
      ...(keysReady ? { keys: true } : {}),
    };
  }
  // A window that shares its text, without an editable cursor, is something to read, not to write in.
  const opaque = context.ok && (context.source === "none" || (!context.text && !context.vicinity));
  if (!opaque || !pasteReady) return undefined;
  return { mode: selection ? "replace" : "insert", original: selection, kind: "unknown", paste: true };
}

/**
 * The form on the page (or in the window), when it has at least two text fields on screen: a list of
 * results with check boxes isn't a form. Not in Google Docs, whose fields are its own toolbar.
 */
export function linuxForm(context: HelperContext, keysReady: boolean): FormTarget | undefined {
  if (!context.ok || !context.fields || !context.pid || (context.url && GOOGLE_DOC.test(context.url))) return undefined;
  // Only labelled fields: nobody could say what goes in the others.
  const onScreen = context.fields.filter((field) => field.onScreen && field.label.trim());
  if (onScreen.filter((field) => field.kind === "text" || field.kind === "textarea").length < 2) return undefined;
  const selectPaste = SELECT_PASTE_TOOLKITS.has(context.toolkit ?? "");
  // Text in a browser goes in with a paste, which needs the extension to focus the window first.
  if (selectPaste && !keysReady) return undefined;
  return {
    pid: context.pid,
    selectPaste,
    fields: onScreen.map((field, index) => ({
      id: `f${index + 1}`,
      label: field.label,
      kind: field.kind,
      path: field.path,
      ...(field.role ? { role: field.role } : {}),
      ...(field.kind === "checkbox" || field.kind === "radio"
        ? { checked: Boolean(field.checked) }
        : { value: field.value ?? "", ...(field.length !== undefined ? { length: field.length } : {}) }),
    })),
  };
}

/**
 * The window the hotkey was pressed in, for Kiki's scroll and look tools: where AT-SPI has it (to read it again
 * and, for pages, to scroll it), and whether the GNOME extension remembered it (to scroll any app, v8, and to
 * take screenshots unless Settings says never). Undefined when Kiki can do neither.
 */
export function linuxSource(
  context: HelperContext,
  version: number | null,
  screenshot?: () => Promise<Screenshot | undefined>,
): SourceWindow | undefined {
  const readable = context.ok && context.pid && context.window && context.source !== "none";
  const wheel = version !== null && version >= SCROLL_VERSION;
  if (!readable && !wheel && !screenshot) return undefined;
  return {
    ...(readable ? { pid: context.pid!, window: context.window! } : {}),
    ...(context.toolkit ? { toolkit: context.toolkit } : {}),
    page: Boolean(readable && context.source === "document"),
    wheel,
    keys: version !== null && version >= KEYS_VERSION,
    ...(screenshot ? { screenshot } : {}),
  };
}

async function readContext(
  read: { seconds: number; timeoutMs: number },
  signal?: AbortSignal,
): Promise<HelperContext> {
  try {
    return await runHelper<HelperContext>(["--max-seconds", String(read.seconds)], read.timeoutMs, signal);
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export async function captureLinux(policy: ScreenshotPolicy): Promise<RawCapture> {
  const notes: string[] = [];

  // Both go before wl-paste, which briefly grabs focus on GNOME and would change which window
  // looks "active". The GNOME extension remembers the window for screenshots after the popup opens.
  const fullRead = new AbortController();
  const full = readContext(FULL_READ, fullRead.signal);
  const [context, sourceVersion] = await Promise.all([readContext(QUICK_READ), rememberSource()]);
  const sourceKnown = policy !== "never" && sourceVersion !== null;
  // Terminals and editors send only the lines near the selection, which the quick read has. The full
  // read also stands in when the quick read fails: a big page read for the first time can be slow.
  const fullText =
    !context.ok || (context.truncated && !context.vicinity)
      ? full.then((result): PageText | undefined =>
          result.ok && !result.vicinity && result.text ? { text: result.text, focus: result.focus } : undefined,
        )
      : undefined;
  if (!fullText) fullRead.abort();
  if (!context.ok) {
    notes.push("Kiki's quick read of the window's text failed; the full read stands in.");
    console.warn("[kiki] accessibility helper:", context.error);
  } else if (context.source === "none") {
    notes.push("This app doesn't share its text with Kiki. For browsers, turn on “Read text in browsers” in Settings.");
  }

  const text = context.text ?? "";
  const { vicinity } = context;
  // Unless Settings says "always", a screenshot waits for the popup's camera button.
  const wantScreenshot = policy === "always";
  const screenshotNow = async (): Promise<ScreenshotResult> => {
    const fromSource = sourceKnown ? await sourceScreenshot() : undefined;
    return fromSource?.screenshot ? fromSource : portalScreenshot();
  };
  const [primary, shot] = await Promise.all([
    // A selection found through accessibility is fresher than the primary selection.
    context.selection ? Promise.resolve("") : readPrimarySelection(),
    wantScreenshot ? screenshotNow() : Promise.resolve(undefined),
  ]);
  const fresh = primaryFitsVicinity(primary, vicinity);
  if (!fresh) console.info("[kiki] capture: ignored a highlight from another window");
  if (shot?.error) {
    notes.push("Kiki couldn't take a screenshot for extra context.");
    console.warn("[kiki] screenshot:", shot.error);
  }

  const selection = context.selection || (fresh ? primary : "");
  const version = sourceVersion ?? 0;
  const editTarget = linuxEditTarget(context, selection, version >= PASTE_VERSION, version >= KEYS_VERSION);
  const form = linuxForm(context, version >= KEYS_VERSION);
  const source = linuxSource(
    context,
    sourceVersion,
    sourceKnown ? async () => (await sourceScreenshot(WHOLE_WINDOW)).screenshot : undefined,
  );
  return {
    selection,
    appName: context.appName ?? undefined,
    windowTitle: context.windowTitle ?? undefined,
    // Only a page's: the helper reads it from the page's document.
    ...(context.source === "document" && context.url ? { url: context.url } : {}),
    text: text || undefined,
    focus: context.focus,
    vicinity,
    fullText,
    screenshot: shot?.screenshot,
    takeScreenshot: sourceKnown ? async () => (await sourceScreenshot()).screenshot : undefined,
    ...(editTarget ? { editTarget } : {}),
    ...(form ? { form } : {}),
    ...(source ? { source } : {}),
    notes,
  };
}
