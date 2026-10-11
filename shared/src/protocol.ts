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

/** POST /v1/conversations */
export interface StartConversationRequest {
  question: string;
  selection: string;
  context: CaptureContext;
  /** Images the person attached to this question. */
  images?: Screenshot[];
  options?: QuestionOptions;
}

/** POST /v1/conversations/:id/messages */
export interface FollowUpRequest {
  question: string;
  images?: Screenshot[];
  options?: QuestionOptions;
}

/** GET /v1/me */
export interface MeResponse {
  name: string;
  usedToday: number;
  dailyLimit: number;
  /** Optional server features. Missing on older servers. */
  features?: { voice: boolean };
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
  | { kind: "read"; url: string; title?: string };

export type KikiEvent =
  | { type: "conversation"; id: string }
  | { type: "status"; phase: StatusPhase; query?: string }
  /** Summarized reasoning and progress notes; blocks are separated by a blank line. */
  | { type: "thinking"; delta: string }
  | { type: "activity"; activity: Activity }
  | { type: "text"; delta: string }
  | { type: "sources"; items: Source[] }
  | { type: "done"; stopReason: string }
  | { type: "error"; code: ErrorCode; message: string };
