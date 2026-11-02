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

/** What the full read of a window adds once the popup is open: its text, and what's found on the way. */
export interface LateText {
  text: string;
  /** Offset in `text` of the middle of what's on screen, when some of the page is off screen. */
  focus?: number;
  /**
   * What's highlighted in the page, when the quick read didn't find it at the cursor. Empty: nothing is, so the
   * primary selection Kiki had was from another window.
   */
  selection?: string;
  /** The page's form, when the quick read didn't get that far. */
  form?: FormTarget;
  /** Terminal or editor lines an app's own reader found (kitty, WezTerm, VS Code's file), instead of `text`. */
  vicinity?: Vicinity;
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
  /** A password field: `act` never types into it; a fill card may, once the person approves. */
  password?: boolean;
}

/** The fields on the page (or in the window) the hotkey was pressed in, and how to fill them. */
export interface FormTarget {
  pid: number;
  fields: FieldTarget[];
  /** Text fields take a select-all and a paste, not AT-SPI writes; see EditTarget.selectPaste. */
  selectPaste: boolean;
  /** The last id given to a field on a page a click left, so fields on the new one don't reuse it. */
  lastId?: number;
}

/** The window the hotkey was pressed in, for scrolling it and reading it again once the popup is open. */
export interface SourceWindow {
  /** Where AT-SPI has it: the app's process and the window's child index. Missing when it shares no text. */
  pid?: number;
  window?: number[];
  /** The app's toolkit ("gecko", "gtk"...). */
  toolkit?: string;
  /** A web page, which AT-SPI can scroll too. */
  page: boolean;
  /** Kiki's GNOME extension can scroll it (v8), and focus it and press shortcuts there (v7). */
  wheel: boolean;
  keys: boolean;
  /** A screenshot of the whole window, where Kiki can take one. */
  screenshot?: () => Promise<Screenshot | undefined>;
}

/** Everything Kiki saw when the hotkey was pressed. */
export interface Capture {
  selection: string;
  appName?: string;
  windowTitle?: string;
  /** The address of the browser page the hotkey was pressed on. */
  url?: string;
  /** Text around the selection (or what's on screen), trimmed to CONTEXT_CHARS. */
  text?: string;
  /**
   * The window's text (trimmed like `text`), when the quick read left it for later or failed; read alongside
   * it, it settles after the popup opens.
   */
  fullText?: Promise<Omit<LateText, "focus"> | undefined>;
  screenshot?: Screenshot;
  /** Takes a screenshot of the same window later, once the popup is open, where the platform can. */
  takeScreenshot?: () => Promise<Screenshot | undefined>;
  /** Where Kiki can write at the cursor, when the window takes text. */
  editTarget?: EditTarget;
  /** Form fields Kiki can fill, when there are at least two. */
  form?: FormTarget;
  /** The window itself, for scrolling it and reading what's on screen later. */
  source?: SourceWindow;
  /** Kiki's GNOME extension's version when the capture was taken (Linux); 0 when it isn't running. */
  helperVersion?: number;
  /** Hints for the user, e.g. how to give Kiki more context. */
  notes: string[];
}

/** What a platform reads, before captureContext trims it into a Capture. */
export interface RawCapture extends Omit<Capture, "fullText"> {
  /** Where `text` is scrolled to; see LateText. */
  focus?: number;
  /** Terminal or editor text around the selection, trimmed to whole lines instead of `text`. */
  vicinity?: Vicinity;
  fullText?: Promise<LateText | undefined>;
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
