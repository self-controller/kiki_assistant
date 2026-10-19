import {
  LIMITS,
  type ActionOutcome,
  type FieldValue,
  type FollowUpRequest,
  type KikiEvent,
  type PressTarget,
  type ProposedAction,
  type Screenshot,
  type Source,
  type StartConversationRequest,
  type TextChange,
  type ToolAccess,
  type ToolResult,
} from "@kiki/shared";
import { BrowserWindow, ipcMain, screen, type Rectangle, type WebContents } from "electron";
import {
  INSETS,
  maxCardHeight,
  popupGeometry,
  type Point,
} from "../../resources/gnome-extension/kiki-popup@kiki.app/placement.js";
import { POPUP_WIDTH } from "../renderer/layout.ts";
import type {
  ActionMode,
  ActionRunResult,
  ActionStatus,
  AskOptions,
  ContextOmissions,
  HistoryItem,
  PastSession,
  PastTurn,
  PopupEvent,
  PopupInit,
  PopupLayout,
  SavedAction,
  WindowRect,
} from "../shared-types.ts";
import { outcomeFor, runAction, runReadTool } from "./actions.ts";
import { applyChanges, applyFill, checkChanges, fillProblems, formFields } from "./changes.ts";
import { postToolResults, streamRequest } from "./api.ts";
import { captureContext, type Capture } from "./capture/index.ts";
import { applyEdit, changesMode, editInfo } from "./edit.ts";
import {
  clearHistory,
  earlierTurns,
  getEntry,
  listHistory,
  newEntry,
  saveEntry,
  type HistoryEntry,
} from "./history.ts";
import { applyEdits, currentClock } from "./google/format.ts";
import { googleAccount } from "./google/oauth.ts";
import { expectPopup, movePopup, placePopup, setHitRect } from "./linuxSetup.ts";
import { personalityPrompt } from "./personalities.ts";
import {
  applyPresses,
  clickControl,
  describePresses,
  newScreenState,
  pressProblems,
  runScreenTool,
  screenTools,
  type ScreenAccess,
  type ScreenState,
} from "./screen.ts";
import { openSearch } from "./search.ts";
import { getAccessCode, getSettings } from "./settings.ts";
import { createPopupWindow, isMac, isWayland, openExternal } from "./windows.ts";

interface PopupSession {
  window: BrowserWindow;
  /** Where the pointer was when the popup opened. Unknown on Wayland, where the GNOME extension reads it. */
  pointer: Point;
  /** Set once the window is placed and showing. */
  shown: Promise<PopupLayout> | null;
  capture: Capture;
  omit: ContextOmissions;
  /** Whether the screenshot has gone to Claude in this conversation. */
  screenshotSent: boolean;
  conversationId: string | null;
  abort: AbortController | null;
  /** This session in Kiki's history, once a question has been answered (or a past session was opened). */
  entry: HistoryEntry | null;
  /** Where the chat box is, for the GNOME extension: the latest one, and whether a call is on its way. */
  hitRect: { latest: WindowRect | null; sending: boolean };
  /** Action cards in this session, by id; the same objects as in its history entry. */
  actions: Map<string, SavedAction>;
  /** What the person did with cards since the last question, for Claude to hear with the next one. */
  outcomes: ActionOutcome[];
  /** What scrolls and looks read in the window: the controls they gave ids to. */
  screen: ScreenState;
  /** What the person lets scrolls and looks send for the question being answered. */
  look: ScreenAccess;
}

const sessions = new Map<number, PopupSession>();
let capturing = false;

/** Captures what's on screen, then opens a fresh popup (replacing any open one). */
export async function openPopup(openSettings: () => void): Promise<void> {
  if (capturing) return;
  if (!getAccessCode()) {
    openSettings();
    return;
  }
  capturing = true;
  const pointer = screen.getCursorScreenPoint();
  let capture: Capture;
  try {
    // Capture before any Kiki window takes focus, so the source app is still "active".
    capture = await captureContext(getSettings().screenshot);
  } catch (error) {
    console.error("[kiki] capture failed:", error);
    capture = { selection: "", notes: ["Kiki couldn't read the screen."] };
  } finally {
    capturing = false;
  }
  // What Kiki couldn't read; the popup doesn't show these.
  if (capture.notes.length > 0) console.info("[kiki] capture:", capture.notes.join(" "));

  for (const session of sessions.values()) session.window.close();

  const window = createPopupWindow();
  const id = window.webContents.id;
  sessions.set(id, {
    window,
    pointer,
    shown: null,
    capture,
    omit: {},
    screenshotSent: false,
    conversationId: null,
    abort: null,
    entry: null,
    hitRect: { latest: null, sending: false },
    actions: new Map(),
    outcomes: [],
    screen: newScreenState(),
    look: { text: false, window: false, screenshot: false },
  });
  window.on("closed", () => {
    sessions.get(id)?.abort?.abort();
    sessions.delete(id);
  });
  if (capture.fullText) {
    // The popup shows the whole text as soon as its slower read is done.
    void settleFullText(capture).then(() => {
      // Not once the popup has switched to a past session.
      if (window.isDestroyed() || sessions.get(id)?.capture !== capture) return;
      window.webContents.send("popup:event", { type: "context", ...textSummary(capture) });
    });
  }
  // The page shows the window once it has measured the chat box; this covers a page that never does.
  window.once("ready-to-show", () => {
    setTimeout(() => {
      const session = sessions.get(id);
      if (session && !session.shown) void showPopup(session, 120);
    }, 1_500);
  });
}

/**
 * Places the popup for a chat box opening `cardHeight` tall, then shows it. The window is sized once,
 * for the tallest chat box, and never resizes: the box grows and moves inside it.
 */
function showPopup(session: PopupSession, cardHeight: number): Promise<PopupLayout> {
  session.shown ??= placeWindow(session, cardHeight).then((layout) => {
    if (!session.window.isDestroyed()) {
      session.window.show();
      session.window.focus();
    }
    return layout;
  });
  return session.shown;
}

async function placeWindow(session: PopupSession, cardHeight: number): Promise<PopupLayout> {
  const { window } = session;
  let bounds: Rectangle | null = null;
  let size: { width: number; height: number };
  let anchorY: number;
  let shellMove = false;
  // Clicks outside the chat box can go to the window below, so the popup stays open until it's closed.
  let staysOpen = true;
  if (isWayland) {
    // Apps can't place windows on Wayland: Kiki's GNOME extension opens it at the pointer.
    const placed = await placePopup(cardHeight);
    if (placed) {
      size = placed;
      anchorY = placed.anchorY;
      shellMove = placed.shellMove;
      staysOpen = placed.clickThrough;
    } else {
      staysOpen = false;
      // No extension, or its first version (until the next login): the chat box sits at the bottom.
      const { workArea } = screen.getPrimaryDisplay();
      size = { width: POPUP_WIDTH, height: INSETS.top + maxCardHeight(workArea.height) + INSETS.bottom };
      anchorY = size.height - INSETS.bottom;
      await expectPopup(size.width, size.height);
    }
  } else {
    const { workArea } = screen.getDisplayNearestPoint(session.pointer);
    const geometry = popupGeometry(session.pointer, cardHeight, workArea);
    bounds = { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height };
    size = geometry;
    anchorY = geometry.anchorY;
  }
  if (!window.isDestroyed()) {
    // Electron on Linux only shrinks a window that can't be resized once its minimum size has gone down.
    window.setMinimumSize(size.width, size.height);
    if (bounds) window.setBounds(bounds);
    else window.setSize(size.width, size.height);
  }
  return {
    height: size.height,
    anchorY,
    maxCard: size.height - INSETS.top - INSETS.bottom,
    shellMove,
    staysOpen,
  };
}

function validRect(value: unknown): WindowRect | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y, width, height } = value as Record<string, unknown>;
  const numbers = [x, y, width, height];
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const [left, top, w, h] = (numbers as number[]).map((n) => Math.round(Math.min(Math.max(n, 0), 10_000)));
  return { x: left!, y: top!, width: w!, height: h! };
}

/**
 * Lets the popup window take clicks only over the chat box: everywhere else, they go to the window
 * below. The GNOME extension does it on Wayland (one call at a time, sending only the latest), and the
 * window's shape on X11. On macOS, the page says when the pointer crosses the box (`popup:pointerOver`).
 */
function updateHitRect(session: PopupSession, rect: WindowRect): void {
  if (isMac) return;
  if (!isWayland) {
    session.window.setShape([rect]);
    return;
  }
  const state = session.hitRect;
  state.latest = rect;
  if (state.sending) return;
  state.sending = true;
  void (async () => {
    while (state.latest && !session.window.isDestroyed()) {
      const next = state.latest;
      state.latest = null;
      await setHitRect(next);
    }
    state.sending = false;
  })();
}

function sessionFor(sender: WebContents): PopupSession | undefined {
  return sessions.get(sender.id);
}

function textSummary(capture: Capture): { textChars: number; textPreview?: string } {
  return { textChars: capture.text?.length ?? 0, textPreview: capture.text?.slice(0, 600) };
}

function thumbnail(capture: Capture): string | undefined {
  if (!capture.screenshot) return undefined;
  return `data:${capture.screenshot.mediaType};base64,${capture.screenshot.data}`;
}

/**
 * Swaps in the whole page text once its slower read is done; the conversation starts with it. It reached
 * past the quick read, so it can center on what's on screen even when it isn't longer.
 */
async function settleFullText(capture: Capture): Promise<void> {
  const full = await capture.fullText?.catch(() => undefined);
  capture.fullText = undefined;
  if (full) capture.text = full;
}

/** A new conversation; one that continues a session (expired, or reopened from history) carries its turns. */
function startRequest(
  session: PopupSession,
  turn: FollowUpRequest,
  screenshot: Screenshot | undefined,
): StartConversationRequest {
  const { capture, omit } = session;
  const earlier = earlierTurns(session.entry?.turns ?? []);
  const personality = personalityPrompt(getSettings());
  return {
    ...turn,
    selection: capture.selection,
    context: {
      appName: omit.window ? undefined : capture.appName,
      windowTitle: omit.window ? undefined : capture.windowTitle,
      url: omit.window ? undefined : capture.url,
      text: omit.text ? undefined : capture.text,
      screenshot,
      // The whole text at the cursor and the form's fields, for changes and fills; they're screen text too.
      ...(!omit.text && capture.editTarget?.full && changesMode(capture.editTarget) === "text"
        ? { editable: capture.editTarget.full }
        : {}),
      ...(!omit.text && capture.form ? { fields: formFields(capture.form) } : {}),
    },
    ...(earlier.length > 0 ? { earlier } : {}),
    ...(personality ? { personality } : {}),
  };
}

/**
 * Saves a finished turn to history, so it mirrors what the server keeps. A session's first turn starts
 * its entry, with the context `start` sent.
 */
function recordTurn(session: PopupSession, turn: PastTurn, start: StartConversationRequest | null): void {
  if (!session.entry) {
    if (!start) return;
    const { appName, windowTitle, text } = start.context;
    session.entry = newEntry({ selection: start.selection, appName, windowTitle, text });
  }
  session.entry.conversationId = session.conversationId;
  session.entry.turns.push(turn);
  session.entry.updatedAt = Date.now();
  saveEntry(session.entry);
}

function screenshotState(capture: Capture): PopupInit["screenshot"] {
  if (getSettings().screenshot === "never") return undefined;
  if (capture.screenshot) return "on";
  return capture.takeScreenshot ? "off" : "unavailable";
}

async function ask(session: PopupSession, options: AskOptions): Promise<void> {
  if (session.abort) return;
  const controller = new AbortController();
  session.abort = controller;
  const send = (event: PopupEvent) => {
    if (!session.window.isDestroyed()) session.window.webContents.send("popup:event", event);
  };

  let expired = false;
  let pendingId: string | null = null;
  let start: StartConversationRequest | null = null;
  let answer = "";
  let sources: Source[] | undefined;
  const actions: SavedAction[] = [];
  // Sent with this question; put back if it doesn't go through.
  const outcomes = session.outcomes.splice(0);
  const onEvent = (event: KikiEvent) => {
    if (event.type === "conversation") {
      pendingId = event.id;
      return;
    }
    if (event.type === "tool_call") {
      const conversationId = pendingId;
      if (conversationId) void runAppTool(session, event, send).then((result) => postToolResults(conversationId, [result]));
      return;
    }
    if (event.type === "action" && event.action.kind === "press") {
      // The card says what Kiki read on those controls, not what Claude called them.
      event.action.presses = describePresses(event.action.presses, session.screen);
    }
    if (event.type === "action") {
      const saved: SavedAction = { action: event.action };
      actions.push(saved);
      session.actions.set(event.action.id, saved);
    }
    if (event.type === "error" && event.code === "expired") {
      expired = true;
      return;
    }
    if (event.type === "text") answer += event.delta;
    if (event.type === "notes") answer = answer.slice(0, Math.max(0, answer.length - event.chars));
    if (event.type === "sources") sources = event.items;
    // Only keep a conversation the server finished, so a failed first turn starts over.
    if (event.type === "done" && pendingId) {
      session.conversationId = pendingId;
      recordTurn(
        session,
        {
          question: options.question.trim(),
          answer,
          ...(sources ? { sources } : {}),
          ...(event.stopReason === "max_tokens" ? { cutOff: true } : {}),
          ...(options.images?.length ? { images: options.images.length } : {}),
          ...(actions.length ? { actions } : {}),
        },
        start,
      );
      outcomes.length = 0;
    }
    send(event);
  };

  try {
    const google = googleAccount().connected;
    const omitted = session.conversationId ? session.omit : options.omit;
    session.look = {
      text: !omitted.text,
      window: !omitted.window,
      // The camera: on when it took a screenshot and the person didn't turn it off for this question.
      screenshot: Boolean(session.capture.screenshot) && !options.omit.screenshot,
    };
    const turn: FollowUpRequest = {
      question: options.question.trim(),
      ...(options.images?.length ? { images: options.images } : {}),
      ...(options.options ? { options: options.options } : {}),
      tools: {
        actions: true,
        open: true,
        calendarRead: google,
        tasksRead: google,
        ...writeTools(session.capture, session.conversationId ? session.omit.text : options.omit.text),
        ...screenTools(session.capture, session.look),
      },
      clock: currentClock(),
      ...(outcomes.length ? { actionOutcomes: outcomes.slice(-LIMITS.actionOutcomes) } : {}),
    };
    // Sent once per conversation: with the first question, or with the first one after it's turned on.
    const screenshot =
      options.omit.screenshot || session.screenshotSent ? undefined : session.capture.screenshot;
    if (session.conversationId) {
      const images = screenshot ? [screenshot, ...(turn.images ?? [])].slice(0, LIMITS.imagesPerQuestion) : turn.images;
      await streamRequest(
        `/v1/conversations/${encodeURIComponent(session.conversationId)}/messages`,
        { ...turn, ...(images?.length ? { images } : {}) },
        onEvent,
        controller.signal,
      );
      if (!expired) {
        if (screenshot) session.screenshotSent = true;
        return;
      }
      session.conversationId = null;
      send({
        type: "notice",
        message: "The earlier conversation expired, so Kiki started a new one with the same context and answers.",
      });
    } else {
      session.omit = options.omit;
    }
    await settleFullText(session.capture);
    // A new conversation (or one restarted after expiring) carries the screenshot as context.
    const contextShot = options.omit.screenshot ? undefined : session.capture.screenshot;
    start = startRequest(session, turn, contextShot);
    await streamRequest("/v1/conversations", start, onEvent, controller.signal);
    if (contextShot) session.screenshotSent = true;
  } finally {
    session.abort = null;
    // Not answered: Claude still needs to hear about these.
    session.outcomes.unshift(...outcomes);
    send({ type: "end" });
  }
}

/**
 * The tools that write in the window the question came from: an edit at the cursor, changes in several
 * places, a form fill. Without the screen's text, Claude can't say what to change, except in a Google Doc,
 * which it reads from the screenshot.
 */
function writeTools(capture: Capture, omitText: boolean | undefined): Partial<ToolAccess> {
  const target = capture.editTarget;
  const changes = changesMode(target);
  return {
    ...(target ? { edit: target.mode } : {}),
    ...(changes && (changes === "docs" || !omitText) ? { changes } : {}),
    ...(capture.form && !omitText ? { fill: true } : {}),
  };
}

/**
 * Runs a tool Claude called for the app: a read, a check of changes, a fill or presses against the window now,
 * a search to open in the browser, or a scroll, look or click in the window.
 */
async function runAppTool(
  session: PopupSession,
  call: Extract<KikiEvent, { type: "tool_call" }>,
  send: (event: PopupEvent) => void,
): Promise<ToolResult> {
  if (call.name === "open_search") return openSearch(call.id, call.input);
  const list = <T>(key: string) => (Array.isArray(call.input[key]) ? (call.input[key] as T[]) : []);
  if (call.name === "scroll" || call.name === "look") {
    const result = await runScreenTool(session.capture, session.screen, call, session.look, session.abort?.signal);
    // Fields that scrolled into view can be filled: fill cards need their labels.
    if (result.screen?.fields && session.capture.form) send({ type: "fields", fields: formFields(session.capture.form) });
    return result;
  }
  if (call.name === "click") {
    const { capture } = session;
    const { result, done } = await clickControl(capture, session.screen, call, session.look, (control) =>
      send({ type: "activity", activity: { kind: "click", label: control.name } }),
    );
    // Fill cards go by the fields on the page it's on now.
    if (done && capture.form) send({ type: "fields", fields: formFields(capture.form) });
    return result;
  }
  if (call.name === "propose_press") {
    const problems = await pressProblems(session.capture.source, session.screen, list<PressTarget>("presses"));
    return problems ? { id: call.id, content: problems, isError: true } : { id: call.id, content: "All of them can be pressed." };
  }
  if (call.name === "propose_changes") {
    return { id: call.id, ...(await checkChanges(session.capture.editTarget, list<TextChange>("changes"))) };
  }
  if (call.name === "propose_fill") {
    const problems = fillProblems(session.capture.form, list<FieldValue>("fields"));
    return problems ? { id: call.id, content: problems, isError: true } : { id: call.id, content: "All values fit the form." };
  }
  return runReadTool(call.id, call.name, call.input);
}

/** The buttons each kind of card has. */
function fitsCard(kind: ProposedAction["kind"], mode: ActionMode): boolean {
  if (mode === "dismiss") return true;
  if (kind === "edit" || kind === "changes") return mode === "apply" || mode === "copy";
  if (kind === "fill" || kind === "press") return mode === "apply";
  return mode !== "apply" && mode !== "copy";
}

/** Runs a card's button in the window the question came from, or with Google. */
function runButton(session: PopupSession, action: ProposedAction, mode: ActionMode): Promise<ActionStatus> {
  const { capture } = session;
  if (mode === "dismiss" && (action.kind === "changes" || action.kind === "fill" || action.kind === "press")) {
    return Promise.resolve({ outcome: "dismissed", message: "Dismissed." });
  }
  switch (action.kind) {
    case "edit":
      return applyEdit(capture.editTarget, action.text, mode, capture.appName);
    case "changes":
      return applyChanges(capture.editTarget, action.changes, mode === "copy" ? "copy" : "apply", capture.appName);
    case "fill":
      return applyFill(capture.form, action.fields, capture.appName);
    case "press":
      return applyPresses(capture.source, session.screen, action.presses, capture.appName);
    default:
      return runAction(action, mode);
  }
}

/** Runs a button on one of the session's action cards and remembers what happened. */
async function runCard(session: PopupSession, id: string, edited: unknown, mode: ActionMode): Promise<ActionRunResult> {
  const saved = session.actions.get(id);
  if (!saved || !fitsCard(saved.action.kind, mode)) return { ok: false, message: "Kiki couldn't find that card." };
  if (saved.status && saved.status.outcome !== "failed") return { ok: true, saved };
  const action = mode === "dismiss" ? saved.action : applyEdits(saved.action, edited);
  if ("error" in action) return { ok: false, message: action.error };
  try {
    saved.status = await runButton(session, action, mode);
    saved.action = action;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A failure the person can fix (e.g. a missing recipient) stays open to try again.
    saved.status = { outcome: "failed", message };
    session.outcomes = session.outcomes.filter((outcome) => outcome.id !== id);
    session.outcomes.push(outcomeFor(action, saved.status));
    if (session.entry) saveEntry(session.entry);
    return { ok: false, message };
  }
  session.outcomes = session.outcomes.filter((outcome) => outcome.id !== id);
  session.outcomes.push(outcomeFor(saved.action, saved.status));
  if (session.entry) saveEntry(session.entry);
  // Where edits go now: after an edit, onto Kiki's text.
  const writes = saved.action.kind === "edit" || saved.action.kind === "changes";
  return writes ? { ok: true, saved, edit: editInfo(session.capture.editTarget) ?? null } : { ok: true, saved };
}

export function registerPopupIpc(openSettings: () => void): void {
  ipcMain.handle("popup:init", (event): PopupInit | null => {
    const session = sessionFor(event.sender);
    if (!session) return null;
    const { capture } = session;
    return {
      appName: capture.appName,
      windowTitle: capture.windowTitle,
      ...textSummary(capture),
      screenshotThumb: thumbnail(capture),
      screenshot: screenshotState(capture),
      configured: Boolean(getSettings().serverUrl && getAccessCode()),
      google: googleAccount().connected,
      ...(capture.editTarget ? { edit: editInfo(capture.editTarget) } : {}),
      ...(capture.form ? { fields: formFields(capture.form) } : {}),
    };
  });
  ipcMain.handle("popup:ask", async (event, options: AskOptions) => {
    const session = sessionFor(event.sender);
    if (session && typeof options?.question === "string" && options.question.trim()) {
      await ask(session, {
        question: options.question,
        omit: options.omit ?? {},
        images: Array.isArray(options.images) ? options.images : undefined,
        options: options.options,
      });
    }
  });
  ipcMain.handle("popup:screenshot", async (event): Promise<string | null> => {
    const session = sessionFor(event.sender);
    if (!session || getSettings().screenshot === "never") return null;
    const { capture } = session;
    capture.screenshot ??= await capture.takeScreenshot?.().catch(() => undefined);
    return thumbnail(capture) ?? null;
  });
  ipcMain.handle("popup:show", (event, cardHeight: unknown) => {
    const session = sessionFor(event.sender);
    if (!session || typeof cardHeight !== "number" || !Number.isFinite(cardHeight)) return null;
    return showPopup(session, Math.round(Math.min(Math.max(cardHeight, 40), 4_000)));
  });
  ipcMain.handle("popup:history", (event): HistoryItem[] => {
    const current = sessionFor(event.sender)?.entry?.id;
    return listHistory().map((entry) => ({
      id: entry.id,
      title: entry.turns[0]?.question.slice(0, 200) ?? "",
      appName: entry.context.appName,
      windowTitle: entry.context.windowTitle,
      updatedAt: entry.updatedAt,
      turns: entry.turns.length,
      current: entry.id === current,
    }));
  });
  ipcMain.handle("popup:openSession", (event, id: unknown): PastSession | null => {
    const session = sessionFor(event.sender);
    if (!session || session.abort || typeof id !== "string") return null;
    const stored = getEntry(id);
    if (!stored) return null;
    // The popup carries on with that session: its context, and its conversation while the server has it.
    const entry = structuredClone(stored);
    session.entry = entry;
    session.capture = { ...entry.context, notes: [] };
    session.omit = {};
    session.conversationId = entry.conversationId;
    // Its screenshot (if any) wasn't saved, and the one for this window doesn't belong to it.
    session.screenshotSent = true;
    session.actions = new Map(entry.turns.flatMap((turn) => turn.actions ?? []).map((saved) => [saved.action.id, saved]));
    session.outcomes = [];
    session.screen = newScreenState();
    return {
      id: entry.id,
      appName: entry.context.appName,
      windowTitle: entry.context.windowTitle,
      ...textSummary(session.capture),
      turns: entry.turns,
    };
  });
  ipcMain.handle("popup:clearHistory", () => clearHistory());
  ipcMain.handle("popup:runAction", async (event, id: unknown, edited: unknown, mode: unknown): Promise<ActionRunResult> => {
    const session = sessionFor(event.sender);
    const modes: ActionMode[] = ["add", "draft", "send", "open", "apply", "copy", "dismiss"];
    if (!session || typeof id !== "string" || !modes.includes(mode as ActionMode)) {
      return { ok: false, message: "Kiki couldn't run that." };
    }
    return runCard(session, id, edited, mode as ActionMode);
  });
  ipcMain.on("popup:cancel", (event) => sessionFor(event.sender)?.abort?.abort());
  ipcMain.on("popup:move", (event) => {
    if (sessionFor(event.sender)) void movePopup();
  });
  ipcMain.on("popup:hitRect", (event, value: unknown) => {
    const session = sessionFor(event.sender);
    const rect = validRect(value);
    if (session && rect) updateHitRect(session, rect);
  });
  ipcMain.on("popup:pointerOver", (event, inside: unknown) => {
    const session = sessionFor(event.sender);
    // Ignored mouse events still reach the page (forward), so it can say when the pointer comes back.
    if (isMac && session) session.window.setIgnoreMouseEvents(inside !== true, { forward: true });
  });
  ipcMain.on("popup:close", (event) => sessionFor(event.sender)?.window.close());
  ipcMain.on("popup:openLink", (_event, url: string) => openExternal(url));
  ipcMain.on("popup:openSettings", () => openSettings());
}
