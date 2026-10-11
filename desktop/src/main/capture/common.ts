import { LIMITS, type Screenshot } from "@kiki/shared";
import type { NativeImage } from "electron";

/** A terminal or editor, where only the lines around the selection (or the caret) matter. */
export type VicinityKind = "terminal" | "editor";

/** Raw text on either side of the selection, or of the caret when nothing is selected. */
export interface Vicinity {
  kind: VicinityKind;
  before: string;
  /** The selected text; empty at a caret. */
  anchor: string;
  after: string;
}

/** Everything Kiki saw when the hotkey was pressed. */
export interface Capture {
  selection: string;
  appName?: string;
  windowTitle?: string;
  /** Text around the selection, trimmed to CONTEXT_CHARS. */
  text?: string;
  /** Terminal or editor text around the selection, trimmed to whole lines instead of `text`. */
  vicinity?: Vicinity;
  /** The whole text, when reading `text` ran out of time; read alongside it and settles after the popup opens. */
  fullText?: Promise<string | undefined>;
  screenshot?: Screenshot;
  /** Takes a screenshot of the same window later, once the popup is open, where the platform can. */
  takeScreenshot?: () => Promise<Screenshot | undefined>;
  /** Hints for the user, e.g. how to give Kiki more context. */
  notes: string[];
}

/** How much nearby text to send: enough to place the selection, not the whole page. */
export const CONTEXT_CHARS = 24_000;

export interface LineBudget {
  /** Lines kept above the selection's first line. */
  before: number;
  /** Lines kept below its last line. */
  after: number;
  chars: number;
}

/**
 * Terminals: the output above the selection explains it, and the cursor is usually at the bottom.
 * Editors: the code on both sides.
 */
export const VICINITY: Record<VicinityKind, LineBudget> = {
  terminal: { before: 90, after: 10, chars: 8_000 },
  editor: { before: 60, after: 40, chars: 8_000 },
};
/** In "auto" mode, take a screenshot when the window gave us less text than this. */
export const AUTO_SCREENSHOT_MIN_TEXT = 500;
const SCREENSHOT_MAX_EDGE = 1568;

/** Downscales and JPEG-encodes a screen image to fit the server's limits. */
export function toScreenshot(image: NativeImage): Screenshot | undefined {
  if (image.isEmpty()) return undefined;
  const { width, height } = image.getSize();
  let edge = Math.min(SCREENSHOT_MAX_EDGE, Math.max(width, height));
  for (const quality of [80, 65, 50]) {
    const scaled =
      Math.max(width, height) > edge
        ? image.resize(width >= height ? { width: edge, quality: "good" } : { height: edge, quality: "good" })
        : image;
    const data = scaled.toJPEG(quality).toString("base64");
    if (data.length <= LIMITS.screenshotBase64Chars) return { mediaType: "image/jpeg", data };
    edge = Math.round(edge * 0.8);
  }
  return undefined;
}
