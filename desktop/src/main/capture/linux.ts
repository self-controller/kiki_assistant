import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, clipboard, nativeImage } from "electron";
import type { Screenshot } from "@kiki/shared";
import type { ScreenshotPolicy } from "../../shared-types.ts";
import { captureSource, rememberSource } from "../gnomeShell.ts";
import { AUTO_SCREENSHOT_MIN_TEXT, toScreenshot, type Capture, type Vicinity } from "./common.ts";

const run = promisify(execFile);

/** The most of the focused window to send as a screenshot, in logical pixels: the strip around the pointer. */
const CROP = { width: 1400, height: 700 };
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
async function sourceScreenshot(): Promise<ScreenshotResult> {
  const path = await captureSource(CROP.width, CROP.height);
  const screenshot = path ? await takeImage(path, "pointer").catch(() => undefined) : undefined;
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

export async function captureLinux(policy: ScreenshotPolicy): Promise<Capture> {
  const notes: string[] = [];

  // Both go before wl-paste, which briefly grabs focus on GNOME and would change which window
  // looks "active". The GNOME extension remembers the window for screenshots after the popup opens.
  const fullRead = new AbortController();
  const full = readContext(FULL_READ, fullRead.signal);
  const [context, sourceKnown] = await Promise.all([
    readContext(QUICK_READ),
    policy === "never" ? Promise.resolve(false) : rememberSource(),
  ]);
  // Terminals and editors send only the lines near the selection, which the quick read has.
  const fullText =
    context.ok && context.truncated && !context.vicinity
      ? full.then((result) => (result.ok && !result.vicinity && result.text) || undefined)
      : undefined;
  if (!fullText) fullRead.abort();
  if (!context.ok) {
    notes.push("Kiki couldn't read the window's text (accessibility helper failed).");
    console.warn("[kiki] accessibility helper:", context.error);
  } else if (context.source === "none") {
    notes.push("This app doesn't share its text with Kiki. For browsers, turn on “Read text in browsers” in Settings.");
  }

  const text = context.text ?? "";
  const { vicinity } = context;
  // A terminal's or editor's own text covers what a screenshot would show.
  const wantScreenshot =
    policy === "always" || (policy === "auto" && !vicinity && text.length < AUTO_SCREENSHOT_MIN_TEXT);
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

  return {
    selection: context.selection || (fresh ? primary : ""),
    appName: context.appName ?? undefined,
    windowTitle: context.windowTitle ?? undefined,
    text: text || undefined,
    vicinity,
    fullText,
    screenshot: shot?.screenshot,
    takeScreenshot: sourceKnown ? async () => (await sourceScreenshot()).screenshot : undefined,
    notes,
  };
}
