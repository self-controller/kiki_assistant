import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { clipboard, desktopCapturer, screen, systemPreferences } from "electron";
import type { ScreenshotPolicy } from "../../shared-types.ts";
import { keepClipboard } from "../clipboard.ts";
import { toScreenshot, type EditTarget, type RawCapture } from "./common.ts";

// NOTE: written against the macOS Accessibility and System Events APIs but not yet
// tested on a Mac. See the README's macOS checklist.

const run = promisify(execFile);

function jxa(script: string, timeoutMs = 2_000): Promise<string> {
  return run("osascript", ["-l", "JavaScript", "-e", script], { timeout: timeoutMs }).then((r) => r.stdout.trim());
}

const FRONT_APP_SCRIPT = `
const se = Application("System Events");
const proc = se.processes.whose({ frontmost: true })[0];
const out = { appName: "", windowTitle: "", selection: "", pid: 0, role: "" };
try { out.appName = proc.name(); } catch (e) {}
try { out.pid = proc.unixId(); } catch (e) {}
try { out.windowTitle = proc.windows[0].name() || ""; } catch (e) {}
try {
  const focused = proc.attributes.byName("AXFocusedUIElement").value();
  try { out.role = focused.role() || ""; } catch (e) {}
  out.selection = focused.attributes.byName("AXSelectedText").value() || "";
} catch (e) {}
JSON.stringify(out);
`;

/** Focused elements that take typed text, so a paste goes in at their cursor. */
const TEXT_ROLES = new Set(["AXTextField", "AXTextArea", "AXComboBox"]);
const TERMINALS = new Set(["Terminal", "iTerm2", "Ghostty", "WezTerm", "Alacritty", "kitty", "Warp"]);

interface FrontApp {
  appName: string;
  windowTitle: string;
  selection: string;
  pid: number;
  /** The focused element's accessibility role, e.g. "AXTextArea". */
  role: string;
}

/** Where an edit card pastes: the focused text field of the front app, brought back to the front. */
function macEditTarget(front: FrontApp, selection: string): EditTarget | undefined {
  if (!front.pid || !TEXT_ROLES.has(front.role)) return undefined;
  // What's highlighted in a terminal is its output: text goes in at the prompt.
  const terminal = TERMINALS.has(front.appName);
  const original = terminal ? "" : selection;
  return { mode: original ? "replace" : "insert", original, kind: terminal ? "terminal" : "field", macPid: front.pid };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Copies the selection with Cmd+C, then restores whatever was on the clipboard. */
async function copySelection(): Promise<string> {
  const restore = await keepClipboard();
  const marker = `kiki-${Date.now()}`;
  await clipboard.writeText(marker);
  let copied = "";
  try {
    await jxa(`Application("System Events").keystroke("c", { using: "command down" })`);
    for (let i = 0; i < 10 && !copied; i++) {
      await sleep(40);
      const now = await clipboard.readText();
      if (now !== marker) copied = now;
    }
  } finally {
    await restore();
  }
  return copied;
}

async function screenUnderCursor() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1568, height: 1568 },
  });
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
  return source ? toScreenshot(source.thumbnail) : undefined;
}

export async function captureMac(policy: ScreenshotPolicy): Promise<RawCapture> {
  const notes: string[] = [];
  if (!systemPreferences.isTrustedAccessibilityClient(false)) {
    notes.push("Give Kiki Accessibility access in Settings so it can read the selected text.");
    return { selection: "", notes };
  }

  let front: FrontApp = { appName: "", windowTitle: "", selection: "", pid: 0, role: "" };
  try {
    front = JSON.parse(await jxa(FRONT_APP_SCRIPT)) as FrontApp;
  } catch (error) {
    console.warn("[kiki] front app script:", error);
  }
  // Many apps (browsers especially) don't expose AXSelectedText; fall back to copying.
  const selection = front.selection || (await copySelection().catch(() => ""));

  let screenshot;
  let takeScreenshot;
  if (policy !== "never") {
    if (systemPreferences.getMediaAccessStatus("screen") === "granted") {
      // Taken later from the camera button, it also shows Kiki's popup.
      if (policy === "always") screenshot = await screenUnderCursor().catch(() => undefined);
      else takeScreenshot = screenUnderCursor;
    } else {
      notes.push("Give Kiki Screen Recording access in Settings so it can see the page around your selection.");
    }
  }

  const editTarget = macEditTarget(front, selection);
  return {
    selection,
    ...(editTarget ? { editTarget } : {}),
    appName: front.appName || undefined,
    windowTitle: front.windowTitle || undefined,
    screenshot,
    takeScreenshot,
    notes,
  };
}

/** Brings the app with `pid` back to the front and types Cmd+V in it. False when it isn't running. */
export async function pasteIntoApp(pid: number): Promise<boolean> {
  try {
    await jxa(
      `const se = Application("System Events");
const proc = se.processes.whose({ unixId: ${Math.trunc(pid)} })[0];
proc.frontmost = true;
delay(0.15);
se.keystroke("v", { using: "command down" });`,
      3_000,
    );
    return true;
  } catch {
    return false;
  }
}
