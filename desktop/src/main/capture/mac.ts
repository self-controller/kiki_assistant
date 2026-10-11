import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { clipboard, ClipboardItem, desktopCapturer, screen, systemPreferences, type ClipboardBookmark } from "electron";
import type { ScreenshotPolicy } from "../../shared-types.ts";
import { toScreenshot, type Capture } from "./common.ts";

// NOTE: written against the macOS Accessibility and System Events APIs but not yet
// tested on a Mac. See the README's macOS checklist.

const run = promisify(execFile);

function jxa(script: string, timeoutMs = 2_000): Promise<string> {
  return run("osascript", ["-l", "JavaScript", "-e", script], { timeout: timeoutMs }).then((r) => r.stdout.trim());
}

const FRONT_APP_SCRIPT = `
const se = Application("System Events");
const proc = se.processes.whose({ frontmost: true })[0];
const out = { appName: "", windowTitle: "", selection: "" };
try { out.appName = proc.name(); } catch (e) {}
try { out.windowTitle = proc.windows[0].name() || ""; } catch (e) {}
try {
  const focused = proc.attributes.byName("AXFocusedUIElement").value();
  out.selection = focused.attributes.byName("AXSelectedText").value() || "";
} catch (e) {}
JSON.stringify(out);
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads every format on the clipboard now, so it can be put back later. */
async function snapshotClipboard(): Promise<ClipboardItem[]> {
  const items = await clipboard.read();
  return Promise.all(
    items.map(async (item) => {
      const entries: Record<string, Blob | ClipboardBookmark> = {};
      for (const type of item.types) {
        try {
          entries[type] = await item.getType(type);
        } catch {
          // Skip formats that can't be read back.
        }
      }
      return new ClipboardItem(entries);
    }),
  );
}

/** Copies the selection with Cmd+C, then restores whatever was on the clipboard. */
async function copySelection(): Promise<string> {
  const saved = await snapshotClipboard().catch(() => []);
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
    if (saved.length > 0) await clipboard.write(saved).catch(() => clipboard.clear());
    else clipboard.clear();
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

export async function captureMac(policy: ScreenshotPolicy): Promise<Capture> {
  const notes: string[] = [];
  if (!systemPreferences.isTrustedAccessibilityClient(false)) {
    notes.push("Give Kiki Accessibility access in Settings so it can read the selected text.");
    return { selection: "", notes };
  }

  let front = { appName: "", windowTitle: "", selection: "" };
  try {
    front = JSON.parse(await jxa(FRONT_APP_SCRIPT)) as typeof front;
  } catch (error) {
    console.warn("[kiki] front app script:", error);
  }
  // Many apps (browsers especially) don't expose AXSelectedText; fall back to copying.
  const selection = front.selection || (await copySelection().catch(() => ""));

  let screenshot;
  if (policy !== "never") {
    if (systemPreferences.getMediaAccessStatus("screen") === "granted") {
      screenshot = await screenUnderCursor().catch(() => undefined);
    } else {
      notes.push("Give Kiki Screen Recording access in Settings so it can see the page around your selection.");
    }
  }

  return {
    selection,
    appName: front.appName || undefined,
    windowTitle: front.windowTitle || undefined,
    screenshot,
    notes,
  };
}
