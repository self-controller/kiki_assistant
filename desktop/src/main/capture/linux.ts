import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, clipboard, nativeImage } from "electron";
import type { FieldKind, Screenshot } from "@kiki/shared";
import type { NearbyTextPolicy, ScreenshotPolicy } from "../../shared-types.ts";
import { linuxIdentity, procIdentity } from "../apps/identity.ts";
import { readApp, resolveApp, type AppExtras, type AppHandler, type AppIdentity, type AppKind } from "../apps/registry.ts";
import {
  captureSource,
  KEYS_VERSION,
  PASTE_VERSION,
  rememberSource,
  SCROLL_VERSION,
  SOURCE_APP_VERSION,
  sourceApp,
  type ShellApp,
  type ShellWindow,
} from "../gnomeShell.ts";
import { isWayland } from "../windows.ts";
import {
  toScreenshot,
  type EditTarget,
  type FieldTarget,
  type FormTarget,
  type LateText,
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
 * Reading a page over accessibility takes a second or more, so the popup doesn't wait for it. The quick read
 * finds only what needs the source window to still be the active one (which window, the selection, the caret)
 * and the popup opens; the full read of its text starts with it and settles while the popup is open.
 * `seconds` limits the quick read's text, read only where the toolkit can't say where the cursor is quickly.
 */
const QUICK_READ = { args: ["--quick"], seconds: 0.2, timeoutMs: 2_500 };
const FULL_READ = { args: ["--text"], seconds: 5, timeoutMs: 7_000 };

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
  /** A quick read: the window has text, left for the full read. */
  hasText?: boolean;
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
  /** A browser page's own title (the window's has the browser's name too). */
  pageTitle?: string;
  /** Whether anything is highlighted in the page (quick read), when the toolkit says. */
  pageSelected?: boolean;
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
  /** A password field (its value is never read). */
  password?: boolean;
}

/** What `--find-window` says about a desktop window: where AT-SPI has it. */
interface HelperWindow {
  ok: boolean;
  reason?: string;
  error?: string;
  pid?: number | null;
  window?: number[];
  toolkit?: string;
  source?: "document" | "window";
  appName?: string | null;
  windowTitle?: string | null;
  url?: string;
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

let interpreter: string | undefined;

/** The system Python, which has PyGObject; a conda/venv python3 on PATH usually doesn't. */
export function python(): string {
  return (interpreter ??= existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3");
}

async function runCold<T>(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const { stdout } = await run(python(), [helperPath(), ...args], {
    timeout: timeoutMs,
    signal,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

/** How many helpers wait for their arguments: the hotkey's two reads, and the next card's or scroll's call. */
const POOL = 3;
/** Helpers started ahead of their calls: Python and its modules take ~0.2 s to load. Each serves one call. */
const warm: ChildProcess[] = [];

/** Starts helpers until POOL of them are waiting. */
export function warmHelpers(): void {
  while (warm.length < POOL) {
    const child = spawn(python(), [helperPath(), "--wait"], { stdio: ["pipe", "pipe", "ignore"] });
    const drop = () => {
      const index = warm.indexOf(child);
      if (index >= 0) warm.splice(index, 1);
    };
    child.once("error", drop);
    child.once("exit", drop);
    // Writing to one that has stopped fails here; its read then fails like any other.
    child.stdin!.on("error", () => {});
    warm.push(child);
  }
}

/** A waiting helper, if there is one. */
function takeWarm(): ChildProcess | undefined {
  return warm.shift();
}

/** Runs the helper with `args` in `child` (started by `warmHelpers`), or in a new process without one. */
function runIn<T>(child: ChildProcess | undefined, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (!child) return runCold<T>(args, timeoutMs, signal);
  return new Promise((resolve, reject) => {
    let stdout = "";
    // Settles once: on the helper's output, or when it times out, is aborted or stopped without any.
    const stop = (error?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.kill();
      if (error) return reject(error);
      try {
        resolve(JSON.parse(stdout) as T);
      } catch {
        reject(new Error(`the helper stopped (${child.exitCode ?? child.signalCode})`));
      }
    };
    const abort = () => stop(new Error("aborted"));
    const timer = setTimeout(() => stop(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    if (child.exitCode !== null || child.signalCode !== null) return stop(new Error("the helper had stopped"));
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => (stdout += chunk));
    child.once("close", () => stop());
    child.stdin!.end(`${JSON.stringify(args)}\n`);
  });
}

/** Runs the helper with `args`: in a helper started ahead when one is waiting, and starts the next ones. */
export function runHelper<T>(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const result = runIn<T>(takeWarm(), args, timeoutMs, signal);
  warmHelpers();
  return result;
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

/**
 * A page that says nothing is highlighted in it rules out the primary selection, which then came from another
 * window (or from long ago). Not a Google Doc, which draws its text and its highlight itself.
 */
export function pageRulesOutPrimary(read: HelperContext): boolean {
  return read.ok && read.source === "document" && read.pageSelected === false && !isGoogleDoc(read.url);
}

/** A page the full read has the final say on what's highlighted in. */
function readsPageHighlight(result: HelperContext): boolean {
  return result.ok && result.source === "document" && !isGoogleDoc(result.url);
}

async function readPrimarySelection(): Promise<string> {
  try {
    if (isWayland) {
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

function isGoogleDoc(url: string | undefined): boolean {
  return Boolean(url && GOOGLE_DOC.test(url));
}

/**
 * Where an edit card can write in the window the hotkey was pressed in: the editable text at its cursor
 * (directly over AT-SPI, by selecting it and pasting, or with a paste at the cursor), or, in an app that
 * shares no text at all (VS Code), wherever its cursor is, with a paste. `pasteReady`: the GNOME extension
 * remembered the window and can paste; `keysReady`: it can also focus the window and press shortcuts (v7).
 * `app`: what kind of app Kiki knows the window to be, so a terminal that shares no text still gets its paste.
 */
export function linuxEditTarget(
  context: HelperContext,
  selection: string,
  pasteReady: boolean,
  keysReady = false,
  app?: AppKind,
): EditTarget | undefined {
  // A Google Doc draws its text itself: Kiki pastes at its cursor, and changes it with its Find and replace.
  if (context.ok && isGoogleDoc(context.url) && context.pid && (pasteReady || keysReady)) {
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
  if (!sharesNoText(context) || !pasteReady) return undefined;
  // What's highlighted in a terminal is its output: text goes in at the prompt, with the terminal's paste.
  if (app === "terminal") return { mode: "insert", original: "", kind: "terminal", paste: true };
  return { mode: selection ? "replace" : "insert", original: selection, kind: "unknown", paste: true };
}

/** A window that shared no text over AT-SPI: an app that isn't there (VS Code, most terminals), or an empty one. */
function sharesNoText(context: HelperContext): boolean {
  return context.ok && (context.source === "none" || (!context.text && !context.vicinity && !context.hasText));
}

/**
 * What an app's own reader found, as the window's late text. Without the app's word on what's highlighted, a
 * primary selection that isn't in the window's text came from another window, as with AT-SPI terminals.
 */
export function lateFromApp(extras: AppExtras | undefined, selection: string): LateText | undefined {
  if (!extras || (!extras.vicinity && extras.selection === undefined)) return undefined;
  const { vicinity } = extras;
  const elsewhere = vicinity && extras.selection === undefined && !primaryFitsVicinity(selection, vicinity);
  const highlighted = extras.selection ?? (elsewhere ? "" : undefined);
  return {
    text: "",
    ...(vicinity ? { vicinity } : {}),
    ...(highlighted !== undefined && highlighted !== selection ? { selection: highlighted } : {}),
  };
}

/** Which app the window is, from Kiki's GNOME extension (v11), its process and AT-SPI; no handler when it's none Kiki knows. */
async function identify(read: HelperContext, shell: ShellApp | null): Promise<{ identity: AppIdentity; handler?: AppHandler }> {
  const proc = read.ok && read.pid ? await procIdentity(read.pid) : {};
  const identity = linuxIdentity(read, shell, proc);
  const app = resolveApp(identity);
  if (app) console.info(`[kiki] capture: ${app.handler.id} (by ${app.by})`);
  return { identity, ...(app ? { handler: app.handler } : {}) };
}

/**
 * The form on the page (or in the window), when it has at least two text fields on screen: a list of
 * results with check boxes isn't a form. Not in Google Docs, whose fields are its own toolbar.
 */
export function linuxForm(context: HelperContext, keysReady: boolean): FormTarget | undefined {
  if (!context.ok || !context.fields || !context.pid || isGoogleDoc(context.url)) return undefined;
  // Only labelled fields: nobody could say what goes in the others.
  const onScreen = context.fields.filter((field) => field.onScreen && field.label.trim());
  if (onScreen.filter((field) => field.kind === "text" || field.kind === "textarea").length < 2) return undefined;
  const selectPaste = SELECT_PASTE_TOOLKITS.has(context.toolkit ?? "");
  // Text in a browser goes in with a paste, which needs the extension to focus the window first.
  if (selectPaste && !keysReady) return undefined;
  return { pid: context.pid, selectPaste, fields: onScreen.map((field, index) => fieldTarget(`f${index + 1}`, field)) };
}

/** What a field holds now: whether a check box or radio button is checked, or a text field's value (cut short at `length`). */
export function fieldState(field: HelperField): Pick<FieldTarget, "checked" | "value" | "length"> {
  return field.kind === "checkbox" || field.kind === "radio"
    ? { checked: Boolean(field.checked) }
    : { value: field.value ?? "", ...(field.length !== undefined ? { length: field.length } : {}) };
}

/** A helper's field as Kiki keeps it, under `id`. */
export function fieldTarget(id: string, field: HelperField): FieldTarget {
  return {
    id,
    label: field.label,
    kind: field.kind,
    path: field.path,
    ...(field.role ? { role: field.role } : {}),
    ...(field.password ? { password: true } : {}),
    ...fieldState(field),
  };
}

/**
 * A capture for another window on the desktop (`use_window`, `open_app`): where AT-SPI has it, so the screen
 * tools can read and act in it, and the extension's screenshots of it once it's the selected source. Its text,
 * controls and fields come with the first read. Undefined when Kiki can reach it neither way.
 */
export async function windowCapture(
  window: ShellWindow,
  version: number,
  camera: boolean,
): Promise<RawCapture | undefined> {
  const found = await runHelper<HelperWindow>(["--find-window", JSON.stringify({ pid: window.pid, title: window.title })], 5_000).catch(
    (error: unknown): HelperWindow => ({ ok: false, error: String(error) }),
  );
  const readable = found.ok && Boolean(found.pid) && Boolean(found.window);
  const wheel = version >= SCROLL_VERSION;
  if (!readable && !camera) return undefined;
  const source: SourceWindow = {
    ...(readable ? { pid: found.pid!, window: found.window! } : {}),
    ...(found.toolkit ? { toolkit: found.toolkit } : {}),
    page: Boolean(readable && found.source === "document"),
    wheel,
    keys: version >= KEYS_VERSION,
    ...(camera ? { screenshot: async () => (await sourceScreenshot(WHOLE_WINDOW)).screenshot } : {}),
  };
  const notes: string[] = [];
  if (!readable) notes.push(`${window.name || window.title} doesn't share its text with Kiki; only screenshots show it.`);
  return {
    selection: "",
    appName: window.name || found.appName || undefined,
    windowTitle: found.windowTitle || window.title || undefined,
    ...(found.url ? { url: found.url } : {}),
    ...(camera ? { takeScreenshot: async () => (await sourceScreenshot(WHOLE_WINDOW)).screenshot } : {}),
    source,
    notes,
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

/** A read of the window, in a waiting helper when there is one (the pool refills once the popup is open). */
async function readContext(read: { args: string[]; seconds: number; timeoutMs: number }, extra: string[] = []): Promise<HelperContext> {
  const args = [...read.args, ...extra, "--max-seconds", String(read.seconds)];
  try {
    return await runIn<HelperContext>(takeWarm(), args, read.timeoutMs);
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** `--source` for a later read of the window the quick read found, once Kiki's popup may be the active window. */
function sourceArgs(read: HelperContext): string[] {
  return read.ok && read.pid && read.window ? ["--source", JSON.stringify({ pid: read.pid, window: read.window })] : [];
}

/**
 * The context without the window's text, when Settings says not to send it: what's highlighted, which window,
 * and where the cursor is, for edits. The lines around a terminal's or editor's caret are only for checking the
 * primary selection.
 */
export function withoutText(context: HelperContext): HelperContext {
  const { text, vicinity, focus: _focus, fields: _fields, edit, ...rest } = context;
  // Changes in several places need the text.
  const { full: _full, ...cursor } = edit ?? {};
  return {
    ...rest,
    ...(edit ? { edit: cursor as HelperEdit } : {}),
    ...(context.ok && context.source !== "none" ? { hasText: Boolean(text || vicinity || context.hasText) } : {}),
  };
}

export async function captureLinux(policy: ScreenshotPolicy, nearbyText: NearbyTextPolicy): Promise<RawCapture> {
  const notes: string[] = [];
  const sendText = nearbyText !== "never";

  // The quick read and RememberSource go before wl-paste, which briefly grabs focus on GNOME and would change which
  // window looks "active"; so does Kiki's popup, which opens once the quick read is in. The GNOME extension
  // remembers the window for screenshots after the popup opens.
  const remembered = rememberSource().then(async (version) => ({
    version,
    // Which app the window is: the only way to tell for apps that share nothing over AT-SPI.
    shell: version !== null && version >= SOURCE_APP_VERSION ? await sourceApp() : null,
  }));
  const [read, { version: sourceVersion, shell }] = await Promise.all([readContext(QUICK_READ), remembered]);
  const { identity, handler } = await identify(read, shell);
  const sourceKnown = policy !== "never" && sourceVersion !== null;
  const version = sourceVersion ?? 0;
  const keysReady = version >= KEYS_VERSION;
  const form = sendText ? linuxForm(read, keysReady) : undefined;
  // Terminals and editors send only the lines near the selection, which the quick read has. A page leaves its text
  // to the full read, which starts now that the quick read has found the window: by its pid and path, so it needs
  // neither the window to stay active nor the quick read's attention. It also stands in when the quick read failed:
  // a big page read for the first time can be slow.
  const lateText =
    sendText && (!read.ok || (!read.vicinity && (read.truncated || read.hasText)))
      ? readContext(FULL_READ, sourceArgs(read)).then((result): LateText | undefined => {
          if (!result.ok) console.warn("[kiki] full read:", result.error);
          if (!result.ok || result.vicinity || !result.text) return undefined;
          const lateForm = form ? undefined : linuxForm(result, keysReady);
          // What's highlighted in the page, unless the quick read found it at the cursor. Nothing highlighted
          // there clears a primary selection the quick read couldn't rule out.
          const selection = read.selection ? undefined : result.selection || (readsPageHighlight(result) ? "" : undefined);
          return {
            text: result.text,
            focus: result.focus,
            ...(selection !== undefined ? { selection } : {}),
            ...(lateForm ? { form: lateForm } : {}),
          };
        })
      : undefined;
  if (!read.ok) {
    notes.push(sendText ? "Kiki's quick read of the window failed; the full read stands in." : "Kiki couldn't read the window.");
    console.warn("[kiki] accessibility helper:", read.error);
  } else if (read.source === "none") {
    notes.push(
      handler?.kind === "browser"
        ? `${handler.name} doesn't share its text with Kiki: turn on “Read text in browsers” in Settings, then restart it.`
        : handler?.read
          ? `${handler.name} doesn't share its text over accessibility; Kiki asks it directly.`
          : "This app doesn't share its text with Kiki. For browsers, turn on “Read text in browsers” in Settings.",
    );
  }

  // Unless Settings says "always", a screenshot waits for the popup's camera button.
  const wantScreenshot = policy === "always";
  const screenshotNow = async (): Promise<ScreenshotResult> => {
    const fromSource = sourceKnown ? await sourceScreenshot() : undefined;
    return fromSource?.screenshot ? fromSource : portalScreenshot();
  };
  const otherWindow = pageRulesOutPrimary(read);
  if (otherWindow) console.info("[kiki] capture: nothing highlighted on the page; ignored the primary selection");
  const [primary, shot] = await Promise.all([
    // A selection found through accessibility is fresher than the primary selection.
    read.selection || otherWindow ? Promise.resolve("") : readPrimarySelection(),
    wantScreenshot ? screenshotNow() : Promise.resolve(undefined),
  ]);
  const fresh = primaryFitsVicinity(primary, read.vicinity);
  if (!fresh) console.info("[kiki] capture: ignored a highlight from another window");
  if (shot?.error) {
    notes.push("Kiki couldn't take a screenshot for extra context.");
    console.warn("[kiki] screenshot:", shot.error);
  }

  const context = sendText ? read : withoutText(read);
  const text = context.text ?? "";
  const selection = context.selection || (fresh ? primary : "");
  const editTarget = linuxEditTarget(context, selection, version >= PASTE_VERSION, keysReady, handler?.kind);
  const source = linuxSource(
    // Without the text, scrolls and looks can't read the window either: only screenshots of it.
    sendText ? context : { ...context, pid: null, window: null },
    sourceVersion,
    sourceKnown ? async () => (await sourceScreenshot(WHOLE_WINDOW)).screenshot : undefined,
  );
  const title = context.windowTitle ?? shell?.title ?? undefined;
  // The app's own reader, for a window that shared no text: it settles once the popup is open, never before.
  const fromApp =
    sendText && handler?.read && sharesNoText(read)
      ? readApp(handler, { identity, windowTitle: title, selection }).then((extras) =>
          lateFromApp(extras, selection),
        )
      : undefined;
  return {
    selection,
    appName: handler?.name ?? context.appName ?? (shell?.name || undefined),
    windowTitle: title && handler?.title ? handler.title(title, context.pageTitle) : title,
    // Only a page's: the helper reads it from the page's document.
    ...(context.source === "document" && context.url ? { url: context.url } : {}),
    text: text || undefined,
    focus: context.focus,
    vicinity: context.vicinity,
    fullText: lateText ?? fromApp,
    screenshot: shot?.screenshot,
    takeScreenshot: sourceKnown ? async () => (await sourceScreenshot()).screenshot : undefined,
    ...(editTarget ? { editTarget } : {}),
    ...(form ? { form } : {}),
    ...(source ? { source } : {}),
    helperVersion: version,
    notes,
  };
}
