// Types shared by the main process, the preload bridge and the renderer pages.
import type {
  ActionOutcomeKind,
  AttachedFile,
  ChangesMode,
  EditMode,
  FormField,
  CustomModelChoice,
  KikiEvent,
  ProposedAction,
  Provider,
  QuestionOptions,
  Screenshot,
  Source,
} from "@kiki/shared";
import type { ServiceId } from "./services.ts";

/** "button": only when the popup's camera button is pressed. */
export type ScreenshotPolicy = "button" | "always" | "never";

/** The providers whose models can also run on the person's own Claude Code or Codex (their plan). */
export type AgentProvider = Extract<Provider, "anthropic" | "openai">;
export const AGENT_PROVIDERS: readonly AgentProvider[] = ["anthropic", "openai"];

/** How a provider's questions run: on the person's Claude Code or Codex ("agent"), or their API key. */
export type AccountChoice = "agent" | "key";

/** Each provider the model menu offers: ready to ask, or waiting for the person to set it up in Settings. */
export type ProviderStatus = "ready" | "needsSetup";

/** How the person's own Claude Code or Codex is set up on this computer. */
export interface AgentStatus {
  /** Where it's installed; null when Kiki can't find it. */
  path: string | null;
  version?: string;
  signedIn: boolean;
  /** What it's signed in with: "Claude Pro", "ChatGPT", "an API key". */
  account?: string;
}

/** A model the person added in Settings, as the popup's model menu lists it. */
export interface CustomModelInfo {
  choice: CustomModelChoice;
  name: string;
  /** Its service's name ("Ollama", "OpenRouter"). */
  service: string;
  /** It runs on the person's computer. */
  local: boolean;
}

/** A model the person added, as Settings shows it (its key stays in the main process). */
export interface CustomModelView {
  id: string;
  name: string;
  service: ServiceId;
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

/** A model to add in Settings › Models. */
export interface NewCustomModel {
  name: string;
  service: ServiceId;
  baseUrl: string;
  model: string;
  key?: string;
}

/** The models a service offers, for Settings' model list, or why Kiki couldn't get them. */
export type ModelListResult = { ok: true; models: string[] } | { ok: false; message: string };

/** Whether Kiki reads and sends the text around what's highlighted (Linux; macOS doesn't read it). */
export type NearbyTextPolicy = "always" | "never";

/** What Kiki may do on the computer besides the window the question came from. */
export interface ComputerUseSettings {
  /** Open pages in Kiki's own browser. */
  browser: boolean;
  /** Work in other windows and start apps. */
  windows: boolean;
  /** Click and drag at coordinates in a screenshot, where accessibility has nothing to click. */
  coordinates: boolean;
  /**
   * Act without asking: click any button, and apply press, fill, edit and changes cards as soon as they're
   * proposed. Passwords, card and ID numbers, payments, and calendar, task and email cards still wait.
   */
  autoApprove: boolean;
}

/** What the browser window's toolbar shows. */
export interface BrowserState {
  url: string;
  title: string;
  /** This page stays after the answer. */
  kept: boolean;
  /** The person clicked or typed in the page, so Kiki stopped acting in it. */
  takenOver: boolean;
  tabs: number;
}

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
  /** Some model is set up to answer. */
  configured: boolean;
  /** A Google account is connected, so action cards can add, draft and send directly. */
  google: boolean;
  /** Whether each provider's models are set up to answer. */
  providers: Record<Provider, ProviderStatus>;
  /** The models the person added in Settings. */
  customModels: CustomModelInfo[];
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
 * writes the text into the app, "copy" puts it on the clipboard. "undo" puts back what an applied edit,
 * changes or fill card wrote.
 */
export type ActionMode = "add" | "draft" | "send" | "open" | "apply" | "copy" | "dismiss" | "undo";

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
  /** Kiki can still put back what this card wrote (only while the popup session that applied it is open). */
  undoable?: boolean;
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
  /** Kiki's GNOME extension is installed but switched off: the popup says so (once a launch), with a way to turn it on. */
  helperOff?: boolean;
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
  /** The names of the files that went with the question (their text isn't saved). */
  files?: string[];
  /** Action cards Kiki proposed in this answer. */
  actions?: SavedAction[];
  /** What was highlighted for this question, when the hotkey brought it into a chat that was already open. */
  highlight?: string;
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
  /** Kept until deleted; unsaved sessions go a week after they were last used. */
  saved: boolean;
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
  /** A highlight the hotkey brought into the chat after the first question. */
  selection?: boolean;
}

/** A window's context as the popup shows it: its chips, and where cards can write in it. */
export type WindowContext = Pick<
  PopupInit,
  "appName" | "windowTitle" | "textChars" | "textPreview" | "screenshotThumb" | "screenshot" | "edit" | "fields"
>;

export interface AskOptions {
  question: string;
  /**
   * Context the user removed before the first question, or from a highlight the hotkey brought in later;
   * otherwise ignored on follow-ups, except that a screenshot turned on after the first question goes with
   * the next one.
   */
  omit: ContextOmissions;
  /** Images the user attached to this question. */
  images?: Screenshot[];
  /** Text files the user attached to this question. */
  files?: AttachedFile[];
  /** Search, the model and the effort level. */
  options?: QuestionOptions;
}

export type PopupEvent =
  | KikiEvent
  | { type: "notice"; message: string }
  /**
   * The window's text changed: its slower full read finished. `selection`: it's the window of a highlight the
   * hotkey brought into the chat, still waiting for the next question, and that's what's highlighted there.
   */
  | { type: "context"; textChars: number; textPreview?: string; selection?: string }
  /**
   * Fill cards can set more fields now: a scroll found them on screen. `next`: they're in the window of a
   * highlight the hotkey brought in, which the next question is about.
   */
  | { type: "fields"; fields: FormField[]; next?: boolean }
  /**
   * The hotkey, pressed again while the popup is open: the chat takes in the new highlight. `fresh`: no
   * question yet, so the popup starts over with this window. Otherwise the next question carries the
   * highlight; `withWindow`: the window's chips show too (another app, window or page, or nothing highlighted).
   */
  | ({ type: "recapture"; fresh: boolean; withWindow: boolean; selection: string } & WindowContext)
  /** Where Kiki is looking now, when it isn't the window the question came from (null: back to it). */
  | { type: "target"; kind: "browser" | "window"; label: string | null }
  /**
   * A card Kiki applied right away ("Act without asking"), with what happened: shown as done, with Undo. `edit`:
   * where edit cards write now, when the card moved it (see ActionRunResult).
   */
  | { type: "card"; saved: SavedAction; edit?: EditInfo | null }
  /** Sent last for every ask, on the same channel as the stream, so it always arrives in order. */
  | { type: "end" };

/** Kiki's GNOME Shell extension, which opens the popup at the pointer on Wayland. */
/**
 * "outdated": running, but older than the copy bundled with this Kiki. "off": installed, but switched off in
 * GNOME (the Extensions app, or something else rewriting GNOME's list of enabled extensions).
 */
export type ExtensionStatus = "active" | "outdated" | "installed" | "off" | "missing";

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
  hotkey: string;
  nearbyText: NearbyTextPolicy;
  screenshot: ScreenshotPolicy;
  computerUse: ComputerUseSettings;
  launchAtLogin: boolean;
  personality: PersonalityChoice;
  customPersonality: string;
  platform: string;
  storageWarning?: string;
  hotkeyError?: string;
  linux?: LinuxStatus;
  mac?: MacStatus;
  google: { available: boolean; connected: boolean; email?: string };
  /** Which of the person's own API keys are saved. The keys themselves stay in the main process. */
  providerKeys: Record<Provider, boolean>;
  /** How Claude's and GPT's questions run: on Claude Code / Codex, or the person's key. */
  accounts: Record<AgentProvider, AccountChoice>;
  /** The person's Claude Code and Codex, as Kiki last found them (null: not checked yet). */
  agents: Record<AgentProvider, AgentStatus | null>;
  customModels: CustomModelView[];
}

export interface SettingsUpdate {
  hotkey?: string;
  nearbyText?: NearbyTextPolicy;
  screenshot?: ScreenshotPolicy;
  computerUse?: Partial<ComputerUseSettings>;
  launchAtLogin?: boolean;
  personality?: PersonalityChoice;
  customPersonality?: string;
  /** The person's own API keys: a new key to check and save, or null to remove it. */
  providerKeys?: Partial<Record<Provider, string | null>>;
  accounts?: Partial<Record<AgentProvider, AccountChoice>>;
}

export type ActionResult = { ok: true; message?: string } | { ok: false; message: string };

/** The API the preload script exposes as `window.kiki`. */
export interface KikiBridge {
  popup: {
    init(): Promise<PopupInit>;
    ask(options: AskOptions): Promise<void>;
    /** The composer is up with these options: a Claude Code process for the question starts, so it won't wait for one. */
    warm(options: QuestionOptions): void;
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
    /** Saves a past session for good, or lets it go after a week; false when it's gone. */
    saveSession(id: string, saved: boolean): Promise<boolean>;
    /** Runs a button on an action card, with the person's edits to it. */
    runAction(id: string, edited: ProposedAction, mode: ActionMode): Promise<ActionRunResult>;
    /** Puts text from the popup (a code block's code) on the clipboard. */
    copyText(text: string): Promise<void>;
    /** Switches Kiki's GNOME extension back on (`PopupLayout.helperOff`). */
    enableExtension(): Promise<ActionResult>;
  };
  settings: {
    get(): Promise<SettingsView>;
    save(update: SettingsUpdate): Promise<ActionResult>;
    /** Looks for the person's Claude Code and Codex again, and how they're signed in. */
    checkAgents(): Promise<Record<AgentProvider, AgentStatus>>;
    /** The models a service at `baseUrl` offers, which also checks the key. */
    listModels(service: ServiceId, baseUrl: string, key?: string): Promise<ModelListResult>;
    addModel(model: NewCustomModel): Promise<ActionResult>;
    removeModel(id: string): Promise<ActionResult>;
    installShortcut(): Promise<ActionResult>;
    installExtension(): Promise<ActionResult>;
    enableAccessibility(): Promise<ActionResult>;
    requestMacPermissions(): Promise<ActionResult>;
    connectGoogle(): Promise<ActionResult>;
    disconnectGoogle(): Promise<ActionResult>;
    quit(): void;
  };
  /** The toolbar page of Kiki's browser window. */
  browser: {
    onState(listener: (state: BrowserState) => void): () => void;
    /** Stops what Kiki is doing. */
    stop(): void;
    /** Keeps this page after the answer, or lets it go. */
    keep(): void;
    hide(): void;
  };
}
