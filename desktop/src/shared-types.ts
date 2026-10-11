// Types shared by the main process, the preload bridge and the renderer pages.
import type { KikiEvent, MeResponse, QuestionOptions, Screenshot } from "@kiki/shared";

export type ScreenshotPolicy = "auto" | "always" | "never";

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
}

/** Where the popup's chat box sits in its window, which is sized once for the tallest box. */
export interface PopupLayout {
  /** The window's height. */
  height: number;
  /** Where the chat box's bottom edge (its input) sits, from the window's top. */
  anchorY: number;
  /** The tallest the chat box grows before its conversation scrolls. */
  maxCard: number;
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
  platform: string;
  storageWarning?: string;
  hotkeyError?: string;
  linux?: LinuxStatus;
  mac?: MacStatus;
}

export interface SettingsUpdate {
  serverUrl?: string;
  accessCode?: string;
  hotkey?: string;
  screenshot?: ScreenshotPolicy;
  launchAtLogin?: boolean;
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
    openLink(url: string): void;
    openSettings(): void;
    /** Takes the screenshot now (if there isn't one yet) and returns its thumbnail, or null. */
    screenshot(): Promise<string | null>;
    /** Places and shows the window for a chat box opening `cardHeight` tall. */
    show(cardHeight: number): Promise<PopupLayout | null>;
  };
  settings: {
    get(): Promise<SettingsView>;
    save(update: SettingsUpdate): Promise<ActionResult>;
    test(): Promise<TestResult>;
    installShortcut(): Promise<ActionResult>;
    installExtension(): Promise<ActionResult>;
    enableAccessibility(): Promise<ActionResult>;
    requestMacPermissions(): Promise<ActionResult>;
    quit(): void;
  };
}
