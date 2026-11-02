// What the Kiki app and its engine (which asks the models, see engine/) say to each other: the questions the
// app sends, and the KikiEvents a turn streams back.

export const LIMITS = {
  questionChars: 4_000,
  selectionChars: 10_000,
  contextTextChars: 60_000,
  appNameChars: 200,
  windowTitleChars: 500,
  // Base64 length; ~3 MB of binary image data.
  screenshotBase64Chars: 4_000_000,
  /** Images the person attaches to one question (pasted, dropped or picked). */
  imagesPerQuestion: 3,
  /** Text files (Markdown, notes, code) the person attaches to one question, and how much of each is sent. */
  filesPerQuestion: 3,
  fileChars: 50_000,
  fileNameChars: 200,
  /** Earlier turns a restarted conversation carries over, and how much of each answer. */
  earlierTurns: 10,
  earlierAnswerChars: 12_000,
  /** What the app sends back for one read tool call (a list of events or tasks). */
  toolResultChars: 20_000,
  /** Outcomes of action cards reported with one question. */
  actionOutcomes: 10,
  /** Text Kiki may write into the person's app with one edit card. */
  editChars: 20_000,
  /** The personality prompt the person set in Settings. */
  personalityChars: 2_000,
  /** The whole text at the cursor (a field, a compose box) sent for changes in several places. */
  editableChars: 16_000,
  /** Changes on one card, and how long the text each one finds may be. */
  changesPerCard: 50,
  changeFindChars: 2_000,
  /** Form fields sent for a fill, and how much of each one's current value. */
  formFields: 40,
  fieldValueChars: 200,
  fieldLabelChars: 120,
  /** What a fill may put in one field. */
  fillValueChars: 2_000,
  /** What `open_search` may search for. */
  searchQueryChars: 500,
  /** The text on screen that one `scroll` or `look` sends back. */
  screenTextChars: 12_000,
  /** How long the text `scroll` brings back into view may be. */
  scrollToChars: 300,
  /** Buttons and links on one press card, and how much of each one's name and the text before it the card shows. */
  pressesPerCard: 10,
  controlLabelChars: 120,
  /** A browser page's address, sent with the context and with what a scroll, look or click saw. */
  urlChars: 2_000,
  /** Steps in one `act` call. */
  actActions: 8,
  /** The longest an `act` step waits for text to appear. */
  waitSeconds: 10,
  /** Windows `list_windows` reports. */
  windowsListed: 40,
  /** An app's name for `open_app`. */
  appQueryChars: 100,
} as const;

export type ScreenshotMediaType = "image/jpeg" | "image/png";

export interface Screenshot {
  mediaType: ScreenshotMediaType;
  /** Base64 without a data: prefix. */
  data: string;
  /** For the context screenshot: the whole screen, or the focused window around the pointer. */
  area?: "screen" | "pointer";
}

/** A text file the person attached to a question: Markdown, notes, code. */
export interface AttachedFile {
  name: string;
  /** Its text, cut to LIMITS.fileChars. */
  text: string;
  /** The file was longer than LIMITS.fileChars. */
  truncated?: boolean;
}

/** What the desktop app saw around the highlighted text. Every field is optional. */
export interface CaptureContext {
  appName?: string;
  windowTitle?: string;
  /** The address of the browser page the question came from. */
  url?: string;
  /** Text near the selection (page or window text), already trimmed client-side. */
  text?: string;
  screenshot?: Screenshot;
  /**
   * The whole text of the field or compose box the cursor is in, as `propose_changes` finds in it. Missing
   * in editors, where `text` is the lines around the cursor of that same text.
   */
  editable?: { text: string; truncated?: boolean };
  /** Fields on the page (or in the window) that `propose_fill` can set, by id. */
  fields?: FormField[];
}

export const FIELD_KINDS = ["text", "textarea", "checkbox", "radio"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** A form field as Claude sees it; the app keeps where it is. */
export interface FormField {
  /** "f1", "f2"... in reading order. */
  id: string;
  label: string;
  kind: FieldKind;
  /** Text fields: what's in it now, cut to LIMITS.fieldValueChars. */
  value?: string;
  /** Check boxes and radio buttons. */
  checked?: boolean;
}

/**
 * The companies behind the composer's built-in models. Anthropic's and OpenAI's run on the person's own Claude
 * Code or Codex sign-in, or their own API key; Google's on their own key.
 */
export const PROVIDERS = ["anthropic", "google", "openai"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** The models the composer offers, three per provider from fastest to best; the engine maps each to a model. */
export const MODEL_CHOICES = ["haiku", "sonnet", "opus", "flash-lite", "flash", "argon", "luna", "sol", "astra"] as const;
export type ModelChoice = (typeof MODEL_CHOICES)[number];

export const MODEL_PROVIDERS: Record<ModelChoice, Provider> = {
  haiku: "anthropic",
  sonnet: "anthropic",
  opus: "anthropic",
  "flash-lite": "google",
  flash: "google",
  argon: "google",
  luna: "openai",
  sol: "openai",
  astra: "openai",
};

/**
 * A model the person added in Settings (another service's, or a local one), by the id Settings gave it:
 * "custom:<id>". Its service's address and the model's name stay with the app.
 */
export type CustomModelChoice = `custom:${string}`;
export const CUSTOM_MODEL_PREFIX = "custom:";
/** A custom model's id in Settings: letters, digits, _ and -. */
export const CUSTOM_MODEL_PATTERN = /^custom:[A-Za-z0-9_-]{1,40}$/;

/** Every model the composer can pick: a built-in one, or one the person added. */
export type ModelPick = ModelChoice | CustomModelChoice;

export function isCustomModel(model: string | undefined): model is CustomModelChoice {
  return model !== undefined && CUSTOM_MODEL_PATTERN.test(model);
}

/** How hard Claude thinks, from the composer's effort button. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Per-question choices from the composer. */
export interface QuestionOptions {
  /** Search the web before answering. */
  search?: boolean;
  /** Which model answers. Claude Opus when missing. */
  model?: ModelPick;
  /** How hard it thinks. Low when missing. */
  effort?: EffortLevel;
  /** Older apps: spend more effort on this question. Ignored when `effort` is set. */
  think?: boolean;
}

/** Which of Kiki's tools the app can handle. Older apps send none, and get web search only. */
export interface ToolAccess {
  /** The app shows action cards (calendar events, tasks, emails) for the person to approve. */
  actions?: boolean;
  /** The app can list the person's calendar events (a Google account is connected). */
  calendarRead?: boolean;
  /** The app can list the person's open tasks. */
  tasksRead?: boolean;
  /**
   * The app can write text into the window the question came from: replace the highlighted text, or insert
   * at the caret when nothing is highlighted.
   */
  edit?: EditMode;
  /**
   * The app can change the text the cursor is in, in several places (`propose_changes`): "text" where Kiki
   * read that text (`context.editable`, or `context.text` in editors), "docs" in a Google Doc, whose text Kiki
   * can't read and changes with Docs' own Find and replace.
   */
  changes?: ChangesMode;
  /** The app can fill the fields in `context.fields` (`propose_fill`). */
  fill?: boolean;
  /** The app can open a search in a new tab of the person's browser (`open_search`). */
  open?: boolean;
  /**
   * The app can scroll the window the question came from and read what's on screen then (`scroll`, `look`):
   * its text, and a screenshot when the person turned the camera on.
   */
  screen?: boolean;
  /** The app can press the buttons and links it read on screen (`propose_press`). */
  press?: boolean;
  /**
   * The app clicks links, tabs and harmless buttons it read on screen right away (`click`), and shows the
   * window afterwards. Buttons that change something still go on a press card.
   */
  click?: boolean;
  /** The app opens pages in Kiki's own browser (`open_url`, `browser`). */
  browse?: boolean;
  /** The app lists the other windows, switches to one and starts apps (`list_windows`, `use_window`, `open_app`). */
  windows?: boolean;
  /** The app runs a few steps in a row on what Kiki is looking at (`act`). */
  act?: boolean;
  /** `act` may click and drag at coordinates in a screenshot (`click_at`, `drag`). */
  coordinates?: boolean;
  /**
   * "Act without asking" is on: `click` may press any button, and press, fill, edit and changes cards are
   * applied as soon as they're proposed (the app answers with what happened). Passwords, card and ID numbers,
   * payments, and calendar, task and email cards still wait for the person.
   */
  autoApprove?: boolean;
}

/** Where `open_search` searches. The app builds each URL itself, so it only ever opens one of these. */
export const SEARCH_PLACES = ["web", "images", "videos", "maps", "news"] as const;
export type SearchPlace = (typeof SEARCH_PLACES)[number];
/** The places whose search can be limited to one site. */
export const SITE_SEARCH_PLACES: readonly SearchPlace[] = ["web", "images"];
/** A site for `open_search`: a bare lowercase domain, e.g. "substack.com". */
export const SEARCH_SITE_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** A search for `open_search`: `site` limits a web or image search to one site, e.g. "substack.com". */
export interface SearchRequest {
  where: SearchPlace;
  query: string;
  site?: string;
}

export const EDIT_MODES = ["replace", "insert"] as const;
export type EditMode = (typeof EDIT_MODES)[number];

export const CHANGES_MODES = ["text", "docs"] as const;
export type ChangesMode = (typeof CHANGES_MODES)[number];

export const SCROLL_DIRECTIONS = ["down", "up"] as const;
export type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number];

/**
 * What `scroll` does: move a screen (one at a time, so Claude sees everything it passes), or bring text Claude
 * saw back into view.
 */
export type ScrollRequest = { direction: ScrollDirection } | { to: string };

/** The keys an `act` step may press: shortcuts only; text goes in with `type`, never key by key. */
export const ACT_KEYS = [
  "enter",
  "tab",
  "escape",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "space",
  "ctrl+a",
  "ctrl+z",
  "ctrl+f",
] as const;
export type ActKey = (typeof ACT_KEYS)[number];

export const MOUSE_BUTTONS = ["left", "right", "middle"] as const;
export type MouseButton = (typeof MOUSE_BUTTONS)[number];

export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * One step of `act`, on what Kiki is looking at: a window, or a page in Kiki's browser. `click_at` and `drag`
 * use pixel coordinates in the last screenshot of it.
 */
export type ActAction =
  | { click: string }
  | { type: { field: string; text: string } }
  | { key: ActKey }
  | { scroll: ScrollRequest }
  | { click_at: ScreenPoint & { button?: MouseButton; count?: number } }
  | { drag: { from: ScreenPoint; to: ScreenPoint } }
  /** Waits for `text` to appear on the page (results that take a moment), up to LIMITS.waitSeconds. */
  | { wait: { text: string } };

/** `open_url`: a page for Kiki's own browser. `show` puts the browser in front of the person. */
export interface OpenUrlRequest {
  url: string;
  show?: boolean;
  new_tab?: boolean;
}

/** `browser`: what to do with Kiki's own browser. At least one is set. */
export interface BrowserRequest {
  show?: boolean;
  hide?: boolean;
  keep?: boolean;
  close?: boolean;
  back?: boolean;
  forward?: boolean;
  reload?: boolean;
}

/** What a `scroll`, `look` or `click` saw in the window afterwards. */
export interface ScreenRead {
  windowTitle?: string;
  /** The page's address, in a browser. */
  url?: string;
  /** The text on screen now, with "⟦b3 Like⟧" where a button or link Kiki can press is. */
  text?: string;
  /** Form fields on screen now, by id; ids carry over from earlier reads. */
  fields?: FormField[];
  /** The window, when the person turned the camera on. */
  screenshot?: Screenshot;
  /** Scrolling moved nothing: that's as far as the window scrolls that way. */
  atEnd?: boolean;
  /** The page hadn't finished loading when it was read: what's here may be incomplete. */
  loading?: boolean;
  /** Where this was read, when it isn't the window the question came from: Kiki's browser, or another window. */
  target?: { kind: "browser" | "window"; title?: string };
  /** The screenshot's size in pixels: `click_at` and `drag` coordinates are in it. */
  screenshotSize?: { width: number; height: number };
}

/** A button or link to press, by its id in the text on screen ("b3"). */
export interface PressTarget {
  control: string;
  /** Filled in by the app from what it read, for the card: the control's name, and the text just before it. */
  label?: string;
  near?: string;
}

/** One change in a text: its one occurrence of `find` becomes `replace`. */
export interface TextChange {
  find: string;
  replace: string;
}

/** What a fill puts in a field: text, or checked (true) or not for check boxes and radio buttons. */
export interface FieldValue {
  field: string;
  value: string | boolean;
}

/** The person's local clock, so "tomorrow at 3" means their tomorrow. */
export interface Clock {
  /** IANA time zone, e.g. "America/Toronto". */
  timeZone: string;
  /** Local time as ISO 8601 with its offset, e.g. "2026-10-16T14:03:00-04:00". */
  now: string;
}

/**
 * Something Kiki suggests doing. The app shows it as a card, and nothing happens until the person approves
 * it there. Times are local ISO 8601 ("2026-10-20T13:00") in the person's time zone; dates are "2026-10-20".
 */
export type ProposedAction =
  | {
      id: string;
      kind: "event";
      title: string;
      start: string;
      end: string;
      allDay?: boolean;
      location?: string;
      description?: string;
      attendees?: string[];
    }
  | { id: string; kind: "task"; title: string; notes?: string; due?: string }
  | {
      id: string;
      kind: "email";
      to: string[];
      cc?: string[];
      subject: string;
      body: string;
      /** The person asked to send it, not just draft it. */
      send?: boolean;
    }
  /** Text for the person's app, at their cursor: it replaces the highlight, or goes in at the caret. */
  | { id: string; kind: "edit"; text: string }
  /** Changes in several places in the text the cursor is in. */
  | { id: string; kind: "changes"; changes: TextChange[] }
  /** Values for form fields, by the ids in `context.fields`. */
  | { id: string; kind: "fill"; fields: FieldValue[] }
  /** Buttons or links to press in the person's window. */
  | { id: string; kind: "press"; presses: PressTarget[] };

export type ActionKind = ProposedAction["kind"];

export const ACTION_OUTCOMES = ["added", "drafted", "sent", "opened", "applied", "copied", "pressed", "undone", "dismissed", "failed"] as const;
export type ActionOutcomeKind = (typeof ACTION_OUTCOMES)[number];

/** What the person did with an action card, reported with their next question. */
export interface ActionOutcome {
  id: string;
  kind: ActionKind;
  outcome: ActionOutcomeKind;
  /** A short description, e.g. the event title and time as finally saved, or the error. */
  summary: string;
}

/** The first question of a conversation. */
export interface StartConversationRequest {
  question: string;
  selection: string;
  context: CaptureContext;
  /** Images the person attached to this question. */
  images?: Screenshot[];
  /** Text files the person attached to this question. */
  files?: AttachedFile[];
  options?: QuestionOptions;
  /**
   * Turns from an earlier conversation this one continues (it expired, or was reopened from history),
   * oldest first. The context goes with the first of them; `question` follows them all.
   */
  earlier?: EarlierTurn[];
  tools?: ToolAccess;
  clock?: Clock;
  actionOutcomes?: ActionOutcome[];
  /** How Kiki should talk, from Settings. Sent once per conversation; follow-ups keep it. */
  personality?: string;
}

export interface EarlierTurn {
  question: string;
  answer: string;
}

/** A question in a conversation that's already going. */
export interface FollowUpRequest {
  question: string;
  /**
   * Text the person highlighted since the last question: pressing the hotkey while Kiki is open brings it
   * into the conversation instead of starting a new one.
   */
  selection?: string;
  /**
   * The window that new highlight is in, when it's another window or page, or the highlight is outside the
   * text the conversation already has.
   */
  context?: CaptureContext;
  images?: Screenshot[];
  files?: AttachedFile[];
  options?: QuestionOptions;
  tools?: ToolAccess;
  clock?: Clock;
  actionOutcomes?: ActionOutcome[];
}

export interface ToolResult {
  id: string;
  /** Plain text (or JSON) for Claude to read. */
  content: string;
  isError?: boolean;
  /** For `scroll`, `look` and `click`: what's on screen now. */
  screen?: ScreenRead;
  /**
   * For a proposal the app applied right away ("Act without asking"): `content` and `screen` say what happened
   * and are the tool's result; the card shows as done.
   */
  applied?: boolean;
}

/** The read tools the app runs for Kiki. */
export const READ_TOOLS = ["list_calendar_events", "list_tasks"] as const;
export type ReadToolName = (typeof READ_TOOLS)[number];

/**
 * Proposals the app checks before they become cards, against the text or form as it is now: its result is
 * an error for Claude to fix (e.g. a change whose text appears twice), or anything else to go ahead.
 */
export const CHECK_TOOLS = ["propose_changes", "propose_fill", "propose_press", "propose_edit"] as const;
export type CheckToolName = (typeof CHECK_TOOLS)[number];

/** Tools the app runs right away, without a card: opening a search in the person's browser. */
export const OPEN_TOOLS = ["open_search"] as const;
export type OpenToolName = (typeof OPEN_TOOLS)[number];

/** Tools that move, read or click around the window the question came from, without a card. */
export const SCREEN_TOOLS = ["scroll", "look", "click"] as const;
export type ScreenToolName = (typeof SCREEN_TOOLS)[number];

/** Tools for Kiki's own browser: opening a page, and showing, keeping or moving the browser. */
export const BROWSE_TOOLS = ["open_url", "browser"] as const;
export type BrowseToolName = (typeof BROWSE_TOOLS)[number];

/** Tools for the other windows on the desktop: listing them, switching to one, starting an app. */
export const WINDOW_TOOLS = ["list_windows", "use_window", "open_app"] as const;
export type WindowToolName = (typeof WINDOW_TOOLS)[number];

/** A few steps in a row on what Kiki is looking at, then one read. */
export const ACT_TOOLS = ["act"] as const;
export type ActToolName = (typeof ACT_TOOLS)[number];

/**
 * Tools that work on what Kiki is looking at (the window the question came from, another window, or a page in
 * Kiki's browser): they take screen steps, not card rounds, and answer with what's on screen afterwards.
 */
export const TARGET_TOOLS = [...SCREEN_TOOLS, ...ACT_TOOLS, ...BROWSE_TOOLS, ...WINDOW_TOOLS] as const;
export type TargetToolName = (typeof TARGET_TOOLS)[number];

/** The tools the app runs during a turn (`tool_call` events). */
export type AppToolName = ReadToolName | CheckToolName | OpenToolName | TargetToolName;

export type StatusPhase = "thinking" | "searching" | "writing";

export interface Source {
  title: string;
  url: string;
}

export type ErrorCode =
  | "unauthorized"
  | "limit"
  | "busy"
  | "expired"
  | "invalid"
  | "refused"
  | "upstream"
  | "internal";

/** Something Kiki is doing while it works, shown in the popup's thinking feed. */
export type Activity =
  | { kind: "search"; query: string }
  /** Results of a web search, before Claude has read them. */
  | { kind: "results"; sources: Source[] }
  /** Claude is reading a page; sent again with the title once it has loaded. */
  | { kind: "read"; url: string; title?: string }
  /** Kiki is looking something up in the person's accounts, e.g. "Checking your calendar". */
  | { kind: "lookup"; label: string }
  /** Kiki is opening a search in the person's browser; `label` is where, e.g. "Google Images". */
  | { kind: "open"; label: string; query: string }
  /** Kiki is scrolling the person's window or looking at it, e.g. "Scrolling down". */
  | { kind: "scroll"; label: string }
  /** Kiki is clicking a link or button in the person's window; `label` is what the control says. */
  | { kind: "click"; label: string }
  /** Kiki is opening a page in its own browser; `label` is the site, e.g. "github.com". */
  | { kind: "browse"; label: string; url?: string }
  /** Kiki is switching to another window or starting an app; `label` says which. */
  | { kind: "window"; label: string }
  /** Kiki is doing a few steps where it's looking; `label` sums them up ("Clicking, typing, pressing Enter"). */
  | { kind: "act"; label: string };

export type KikiEvent =
  | { type: "conversation"; id: string }
  | { type: "status"; phase: StatusPhase; query?: string }
  /** Summarized reasoning and progress notes; blocks are separated by a blank line. */
  | { type: "thinking"; delta: string }
  | { type: "activity"; activity: Activity }
  | { type: "text"; delta: string }
  /**
   * The last `chars` characters of text were Claude's working notes before it used one of Kiki's tools,
   * not part of the answer: show them with the thinking instead.
   */
  | { type: "notes"; chars: number }
  | { type: "sources"; items: Source[] }
  /** A card for the person to approve. */
  | { type: "action"; action: ProposedAction }
  /**
   * The app should run a read tool (or check a proposal) and hand its result back to the engine
   * (`Engine.toolResults`).
   */
  | { type: "tool_call"; id: string; name: AppToolName; input: Record<string, unknown> }
  | { type: "done"; stopReason: string }
  | { type: "error"; code: ErrorCode; message: string };
