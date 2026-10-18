import { LIMITS, type EditMode, type FormField, type Screenshot } from "@kiki/shared";
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

/** A page's text, and where in it the window is scrolled to. */
export interface PageText {
  text: string;
  /** Offset in `text` of the middle of what's on screen, when some of the page is off screen. */
  focus?: number;
}

/** An AT-SPI text object that takes writes directly, as the Linux helper found it (see its --edit). */
export interface AtspiTarget {
  pid: number;
  /** Child indices from the app down to the object. */
  path: number[];
  role?: string;
  /** The span `original` covers, in characters. */
  start: number;
  end: number;
}

/**
 * Where an edit card writes: at the cursor in the window the hotkey was pressed in. It replaces the
 * highlighted text, or goes in at the caret.
 */
export interface EditTarget {
  mode: EditMode;
  /** The text an edit replaces; empty for an insert. */
  original: string;
  /**
   * "terminal": text goes in at the prompt, with the terminal's paste shortcut. "unknown": no accessibility.
   * "docs": a Google Doc, whose text Kiki can't read; changes go through Docs' Find and replace.
   */
  kind: "terminal" | "editor" | "field" | "unknown" | "docs";
  atspi?: AtspiTarget;
  /**
   * The app takes no AT-SPI writes (Firefox, Zen) or isn't known to: Kiki selects the text there over AT-SPI
   * and pastes over it, once Kiki's GNOME extension (v7) has focused the window.
   */
  selectPaste?: boolean;
  /** The whole text the cursor is in, for changes in several places. Missing in editors and terminals. */
  full?: { text: string; truncated?: boolean };
  /** Kiki can paste into the window instead: Kiki's GNOME extension remembered it (Linux). */
  paste?: boolean;
  /** Kiki's GNOME extension can focus the window and press shortcuts there (v7): changes in Google Docs. */
  keys?: boolean;
  /** The app's process, for a Google Doc's Find and replace dialog. */
  pid?: number;
  /** macOS: the app to bring back to the front and paste into. */
  macPid?: number;
}

/** A form field Kiki can fill, as Claude sees it plus where it is. */
export interface FieldTarget extends FormField {
  path: number[];
  role?: string;
  /** The field's text is longer than `value`, which is cut short. */
  length?: number;
}

/** The fields on the page (or in the window) the hotkey was pressed in, and how to fill them. */
export interface FormTarget {
  pid: number;
  fields: FieldTarget[];
  /** Text fields take a select-all and a paste, not AT-SPI writes; see EditTarget.selectPaste. */
  selectPaste: boolean;
}

/** Everything Kiki saw when the hotkey was pressed. */
export interface Capture {
  selection: string;
  appName?: string;
  windowTitle?: string;
  /** Text around the selection (or what's on screen), trimmed to CONTEXT_CHARS. */
  text?: string;
  /**
   * The whole text, when reading `text` ran out of time or failed; read alongside it and settles after the
   * popup opens.
   */
  fullText?: Promise<string | undefined>;
  screenshot?: Screenshot;
  /** Takes a screenshot of the same window later, once the popup is open, where the platform can. */
  takeScreenshot?: () => Promise<Screenshot | undefined>;
  /** Where Kiki can write at the cursor, when the window takes text. */
  editTarget?: EditTarget;
  /** Form fields Kiki can fill, when there are at least two. */
  form?: FormTarget;
  /** Hints for the user, e.g. how to give Kiki more context. */
  notes: string[];
}

/** What a platform reads, before captureContext trims it into a Capture. */
export interface RawCapture extends Omit<Capture, "fullText"> {
  /** Where `text` is scrolled to; see PageText. */
  focus?: number;
  /** Terminal or editor text around the selection, trimmed to whole lines instead of `text`. */
  vicinity?: Vicinity;
  fullText?: Promise<PageText | undefined>;
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
