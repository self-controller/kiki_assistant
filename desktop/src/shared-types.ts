// Types shared by the main process, the preload bridge and the renderer pages.
import type {
  ActionOutcomeKind,
  ChangesMode,
  EditMode,
  FormField,
  KikiEvent,
  MeResponse,
  ProposedAction,
  QuestionOptions,
  Screenshot,
  Source,
} from "@kiki/shared";

/** "button": only when the popup's camera button is pressed. */
export type ScreenshotPolicy = "button" | "always" | "never";

/** How Kiki talks: its usual voice, a built-in personality, or the person's own prompt. */
export type PersonalityChoice = "default" | "camus" | "dostoevsky" | "nietzsche" | "custom";

/** What the popup shows before the first question. */
export interface PopupInit {
  appName?: string;
  windowTitle?: string;
  textChars: number;
  textPreview?: string;
  /** Small data: URL preview of the attached screenshot. */
  screenshotThumb?: string;
  /**
   * The screenshot button: "on" with a screenshot attached, "off" when Kiki can take one on request,
   * "unavailable" when it can't. Absent when screenshots are turned off in Settings.
   */
  screenshot?: "on" | "off" | "unavailable";
  configured: boolean;
  /** A Google account is connected, so action cards can add, draft and send directly. */
  google: boolean;
  /** Kiki can write at the cursor in the window the question came from. */
  edit?: EditInfo;
  /** Form fields Kiki can fill in that window. */
  fields?: FormField[];
}

/** Where edit cards write, as the popup shows it. */
export interface EditInfo {
  /** Replace the highlighted text, or insert at the caret. */
  mode: EditMode;
  /**
   * "terminal": text goes in at its prompt. "unknown": an app that shares no text, pasted into. "docs": a
   * Google Doc, pasted into at its cursor.
   */
  kind: "terminal" | "editor" | "field" | "unknown" | "docs";
  /** The start of the text a replace changes. */
  original: string;
  /** Changes cards can be applied here: see ChangesMode. */
  changes?: ChangesMode;
  /** Kiki read the whole text, so a changes card can copy it with the changes made. */
  wholeText?: boolean;
}

/**
 * What a button on an action card does. "open" finishes it in the browser instead. Edit cards: "apply"
 * writes the text into the app, "copy" puts it on the clipboard.
 */
export type ActionMode = "add" | "draft" | "send" | "open" | "apply" | "copy" | "dismiss";

/** What happened to an action card. */
export interface ActionStatus {
  outcome: ActionOutcomeKind;
  /** Shown on the card: "Added to Google Calendar", or the error. */
  message: string;
  /** Where to see the result (the event, the draft, the sent email). */
  link?: string;
}

/** An action card, as shown and saved: what Kiki proposed (with the person's edits), and what happened. */
export interface SavedAction {
  action: ProposedAction;
  status?: ActionStatus;
}

/** `edit`: where edit cards write now, after an edit moved it onto Kiki's text (or cleared it). */
export type ActionRunResult = { ok: true; saved: SavedAction; edit?: EditInfo | null } | { ok: false; message: string };

/** Where the popup's chat box sits in its window, which is sized once for the tallest box. */
export interface PopupLayout {
  /** The window's height. */
  height: number;
  /** Where the chat box's bottom edge (its input) sits, from the window's top. */
  anchorY: number;
  /** The tallest the chat box grows before its conversation scrolls. */
  maxCard: number;
  /** The page asks Kiki's GNOME extension to move the window (`move`), instead of CSS drag regions. */
  shellMove?: boolean;
  /**
   * Clicks outside the chat box (`hitRect`) go to the window below, so the popup stays open until it's
   * closed. Without it (Wayland without Kiki's GNOME extension v5), it closes when focus leaves.
   */
  staysOpen?: boolean;
}

/** A rectangle in the popup window, in CSS pixels. */
export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One finished question and answer, as saved in Kiki's history on this computer. */
export interface PastTurn {
  question: string;
  answer: string;
  sources?: Source[];
  /** The answer hit the length limit. */
  cutOff?: boolean;
  /** How many images went with the question (the images themselves aren't saved). */
  images?: number;
  /** Action cards Kiki proposed in this answer. */
  actions?: SavedAction[];
}

/** A row in the popup's list of past sessions. */
export interface HistoryItem {
  id: string;
  /** The first question. */
  title: string;
  appName?: string;
  windowTitle?: string;
  updatedAt: number;
  turns: number;
  /** The session this popup is showing. */
  current: boolean;
}

/** A past session, reopened in the popup to read and continue. */
export interface PastSession {
  id: string;
  appName?: string;
  windowTitle?: string;
  textChars: number;
  textPreview?: string;
  turns: PastTurn[];
}

export interface ContextOmissions {
  window?: boolean;
  text?: boolean;
  screenshot?: boolean;
}

export interface AskOptions {
  question: string;
  /**
   * Context the user removed before the first question; ignored on follow-ups, except that a screenshot
   * turned on after the first question goes with the next one.
   */
  omit: ContextOmissions;
  /** Images the user attached to this question. */
  images?: Screenshot[];
  /** Search, the model and the effort level. */
  options?: QuestionOptions;
}

export type PopupEvent =
  | KikiEvent
  | { type: "notice"; message: string }
  /** The window's text changed: its slower full read finished. */
  | { type: "context"; textChars: number; textPreview?: string }
  /** Fill cards can set more fields now: a scroll found them on screen. */
  | { type: "fields"; fields: FormField[] }
  /** Sent last for every ask, on the same channel as the stream, so it always arrives in order. */
  | { type: "end" };

/** Kiki's GNOME Shell extension, which opens the popup at the pointer on Wayland. */
/** "outdated": running, but older than the copy bundled with this Kiki. */
export type ExtensionStatus = "active" | "outdated" | "installed" | "missing";

export interface LinuxStatus {
  gnome: boolean;
  wayland: boolean;
  shortcutInstalled: boolean;
  shortcutBinding?: string;
  shortcutCommand: string;
  extension: ExtensionStatus;
  accessibilityEnabled: boolean;
  helperError?: string;
  clipboardTool: boolean;
}

export interface MacStatus {
  accessibility: boolean;
  screen: string;
}

export interface SettingsView {
  serverUrl: string;
  hasAccessCode: boolean;
  hotkey: string;
  screenshot: ScreenshotPolicy;
  launchAtLogin: boolean;
  personality: PersonalityChoice;
  customPersonality: string;
  platform: string;
  storageWarning?: string;
  hotkeyError?: string;
  linux?: LinuxStatus;
  mac?: MacStatus;
  google: { available: boolean; connected: boolean; email?: string };
}

export interface SettingsUpdate {
  serverUrl?: string;
  accessCode?: string;
  hotkey?: string;
  screenshot?: ScreenshotPolicy;
  launchAtLogin?: boolean;
  personality?: PersonalityChoice;
  customPersonality?: string;
}

export type ActionResult = { ok: true; message?: string } | { ok: false; message: string };
export type TestResult = { ok: true; me: MeResponse } | { ok: false; message: string };

/** The API the preload script exposes as `window.kiki`. */
export interface KikiBridge {
  popup: {
    init(): Promise<PopupInit>;
    ask(options: AskOptions): Promise<void>;
    cancel(): void;
    onEvent(listener: (event: PopupEvent) => void): () => void;
    close(): void;
    /** Moves the window with the pointer while the button is down (only with `PopupLayout.shellMove`). */
    move(): void;
    /** Where the chat box (with Kiki and its ✕) is; clicks anywhere else in the window go to the one below. */
    hitRect(rect: WindowRect): void;
    /** Whether the pointer is over `hitRect`, for platforms where the page decides what takes clicks. */
    pointerOver(inside: boolean): void;
    openLink(url: string): void;
    openSettings(): void;
    /** Takes the screenshot now (if there isn't one yet) and returns its thumbnail, or null. */
    screenshot(): Promise<string | null>;
    /** Places and shows the window for a chat box opening `cardHeight` tall. */
    show(cardHeight: number): Promise<PopupLayout | null>;
    /** Past sessions, newest first. */
    history(): Promise<HistoryItem[]>;
    /** Switches the popup to a past session; null while an answer is streaming or when it's gone. */
    openSession(id: string): Promise<PastSession | null>;
    clearHistory(): Promise<void>;
    /** Runs a button on an action card, with the person's edits to it. */
    runAction(id: string, edited: ProposedAction, mode: ActionMode): Promise<ActionRunResult>;
  };
  settings: {
    get(): Promise<SettingsView>;
    save(update: SettingsUpdate): Promise<ActionResult>;
    test(): Promise<TestResult>;
    installShortcut(): Promise<ActionResult>;
    installExtension(): Promise<ActionResult>;
    enableAccessibility(): Promise<ActionResult>;
    requestMacPermissions(): Promise<ActionResult>;
    connectGoogle(): Promise<ActionResult>;
    disconnectGoogle(): Promise<ActionResult>;
    quit(): void;
  };
}
