// Wire protocol between the Kiki desktop app and the Kiki server.
// Requests are JSON; responses to ask requests are Server-Sent Events whose
// `data` is one JSON-encoded KikiEvent.

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
  bodyBytes: 6 * 1024 * 1024,
  /** Raw audio for one voice question (~60 s of Opus). */
  audioBytes: 2 * 1024 * 1024,
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
} as const;

export type ScreenshotMediaType = "image/jpeg" | "image/png";

export interface Screenshot {
  mediaType: ScreenshotMediaType;
  /** Base64 without a data: prefix. */
  data: string;
  /** For the context screenshot: the whole screen, or the focused window around the pointer. */
  area?: "screen" | "pointer";
}

/** What the desktop app saw around the highlighted text. Every field is optional. */
export interface CaptureContext {
  appName?: string;
  windowTitle?: string;
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

/** The models the composer offers; the server maps each to a Claude model. */
export const MODEL_CHOICES = ["haiku", "sonnet", "opus"] as const;
export type ModelChoice = (typeof MODEL_CHOICES)[number];

/** How hard Claude thinks, from the composer's effort button. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Per-question choices from the composer. */
export interface QuestionOptions {
  /** Search the web before answering. */
  search?: boolean;
  /** Which model answers. The server's default when missing. */
  model?: ModelChoice;
  /** How hard it thinks. The server's default when missing. */
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
  | { id: string; kind: "fill"; fields: FieldValue[] };

export type ActionKind = ProposedAction["kind"];

export const ACTION_OUTCOMES = ["added", "drafted", "sent", "opened", "applied", "copied", "dismissed", "failed"] as const;
export type ActionOutcomeKind = (typeof ACTION_OUTCOMES)[number];

/** What the person did with an action card, reported with their next question. */
export interface ActionOutcome {
  id: string;
  kind: ActionKind;
  outcome: ActionOutcomeKind;
  /** A short description, e.g. the event title and time as finally saved, or the error. */
  summary: string;
}

/** POST /v1/conversations */
export interface StartConversationRequest {
  question: string;
  selection: string;
  context: CaptureContext;
  /** Images the person attached to this question. */
  images?: Screenshot[];
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

/** POST /v1/conversations/:id/messages */
export interface FollowUpRequest {
  question: string;
  images?: Screenshot[];
  options?: QuestionOptions;
  tools?: ToolAccess;
  clock?: Clock;
  actionOutcomes?: ActionOutcome[];
}

/** POST /v1/conversations/:id/tool-results: answers to `tool_call` events in a streaming turn. */
export interface ToolResultsRequest {
  results: ToolResult[];
}

export interface ToolResult {
  id: string;
  /** Plain text (or JSON) for Claude to read. */
  content: string;
  isError?: boolean;
}

/** The read tools the app runs for Kiki. */
export const READ_TOOLS = ["list_calendar_events", "list_tasks"] as const;
export type ReadToolName = (typeof READ_TOOLS)[number];

/**
 * Proposals the app checks before they become cards, against the text or form as it is now: its result is
 * an error for Claude to fix (e.g. a change whose text appears twice), or anything else to go ahead.
 */
export const CHECK_TOOLS = ["propose_changes", "propose_fill"] as const;
export type CheckToolName = (typeof CHECK_TOOLS)[number];

/** Tools the app runs right away, without a card: opening a search in the person's browser. */
export const OPEN_TOOLS = ["open_search"] as const;
export type OpenToolName = (typeof OPEN_TOOLS)[number];

/** The tools the app runs during a turn (`tool_call` events). */
export type AppToolName = ReadToolName | CheckToolName | OpenToolName;

/** GET /v1/me */
export interface MeResponse {
  name: string;
  usedToday: number;
  dailyLimit: number;
  /** Optional server features. Missing on older servers. */
  features?: { voice: boolean; actions?: boolean };
}

/** POST /v1/transcribe (raw audio body) */
export interface TranscribeResponse {
  text: string;
}

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

/** Body of every non-2xx JSON response. */
export interface ErrorResponse {
  error: { code: ErrorCode; message: string };
}

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
  | { kind: "open"; label: string; query: string };

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
   * The app should run a read tool (or check a proposal) and POST its result to
   * /v1/conversations/:id/tool-results.
   */
  | { type: "tool_call"; id: string; name: AppToolName; input: Record<string, unknown> }
  | { type: "done"; stopReason: string }
  | { type: "error"; code: ErrorCode; message: string };
