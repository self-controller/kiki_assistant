import { setTimeout as sleep } from "node:timers/promises";
import {
  LIMITS,
  TARGET_TOOLS,
  type ActionOutcome,
  type CaptureContext,
  type FieldValue,
  type FollowUpRequest,
  type KikiEvent,
  type PressTarget,
  type ProposedAction,
  type QuestionOptions,
  type Screenshot,
  type Source,
  type StartConversationRequest,
  type TextChange,
  type ToolAccess,
  type ToolResult,
} from "@kiki/shared";
import { BrowserWindow, clipboard, ipcMain, nativeImage, screen, type Rectangle, type WebContents } from "electron";
import {
  INSETS,
  maxCardHeight,
  popupGeometry,
  type Point,
} from "../../resources/gnome-extension/kiki-popup@kiki.app/placement.js";
import { POPUP_WIDTH } from "../renderer/layout.ts";
import type {
  ActionMode,
  ActionResult,
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
  WindowContext,
  WindowRect,
} from "../shared-types.ts";
import { outcomeFor, runAction, runReadTool } from "./actions.ts";
import { kikiBrowser, type KikiTab } from "./browser.ts";
import { applyChanges, applyFill, checkChanges, fillProblems, formFields } from "./changes.ts";
import { captureContext, prepareCapture, type Capture } from "./capture/index.ts";
import { applyEdit, changesMode, editInfo, retargetUndo } from "./edit.ts";
import { anyModelReady, ask as askEngine, discardSpare, modelMenu, sendToolResults, warm as warmEngine } from "./engine.ts";
import { errorMessage } from "./errors.ts";
import { hideBanner, showBanner, WINDOWS_VERSION } from "./gnomeShell.ts";
import {
  clearHistory,
  earlierTurns,
  getEntry,
  listHistory,
  newEntry,
  saveEntry,
  setSaved,
  type HistoryEntry,
} from "./history.ts";
import { applyEdits, currentClock } from "./google/format.ts";
import { googleAccount } from "./google/oauth.ts";
import {
  activatePopup,
  enableExtension,
  expectPopup,
  extensionOff,
  movePopup,
  placePopup,
  setHitRect,
  waitForExtension,
} from "./linuxSetup.ts";
import { personalityPrompt } from "./personalities.ts";
import { isNewPage, needsContext, pageOf, type PageContext } from "./recapture.ts";
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
import {
  newTargets,
  runTargetTool,
  tabApplyFill,
  tabApplyPresses,
  tabFillProblems,
  tabPressProblems,
  targetLabel,
  waitsForPerson,
  type TargetContext,
  type Targets,
} from "./targets.ts";
import { UndoGone, undoRecord, UndoStack, type Applied } from "./undo.ts";
import { getSettings } from "./settings.ts";
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
  /** Where Kiki is looking: this window (the default), another window, or a page in Kiki's browser. */
  targets: Targets;
  /** The question being answered, for the address guard. */
  question: string;
  /** What the person lets scrolls and looks send for the question being answered. */
  look: ScreenAccess;
  /** A capture from the hotkey, pressed again after the first question; the next question switches to it. */
  incoming: Capture | null;
  /** The next follow-up carries the highlight (and maybe the window) of the capture it switched to. */
  update: boolean;
  /** The window's context as the conversation has it, once a question with it was answered. */
  known: PageContext | null;
  /** The window each card was proposed for, and the controls read there: its buttons act on that window. */
  cardTargets: Map<string, CardTarget>;
  /** What applied edit, changes and fill cards wrote, for their Undo buttons. */
  undo: UndoStack;
  /** Stops a card's button that's running (a changes card pasting several changes, an undo). */
  cardAbort: AbortController | null;
}

interface CardTarget {
  capture: Capture;
  screen: ScreenState;
  /** The card was proposed for a page in Kiki's browser. */
  tab?: KikiTab;
}

/** The card target for where Kiki is looking now. */
function cardTargetFor(session: PopupSession): CardTarget {
  const target = session.targets.current;
  if (target.kind === "browser") return { capture: session.capture, screen: target.tab.state, tab: target.tab };
  return { capture: target.capture, screen: target.screen };
}

const sessions = new Map<number, PopupSession>();
/** Captures the hotkey brought into a chat after its first question (see `takeCapture`). */
const broughtIn = new WeakSet<Capture>();
let capturing = false;
/** The next popup's window, loaded ahead of the hotkey (see `preparePopup`). */
let spare: BrowserWindow | null = null;
/** Popup pages that asked for their context before their capture was in, by webContents id. */
const waiting = new Map<number, () => void>();

/**
 * Loads the next popup's window and starts the next capture's helpers, so the hotkey only has to read the
 * screen. The window stays hidden (unmapped on Wayland, so it takes no focus) and its page waits in
 * `popup:init` until a capture comes for it.
 */
export function preparePopup(): void {
  prepareCapture();
  if (!spare || spare.isDestroyed()) spare = newPopupWindow();
}

/** The spare window, or a new one when there's none or its page crashed. */
function takeWindow(): BrowserWindow {
  const window = spare;
  spare = null;
  if (window && !window.isDestroyed() && !window.webContents.isCrashed()) return window;
  window?.destroy();
  return newPopupWindow();
}

function newPopupWindow(): BrowserWindow {
  const window = createPopupWindow();
  const id = window.webContents.id;
  window.on("closed", () => {
    if (spare === window) spare = null;
    // Closed before its capture came: its page gets no context.
    waiting.get(id)?.();
    waiting.delete(id);
  });
  return window;
}

/** The popup that's showing, if any. */
function openSession(): PopupSession | undefined {
  return [...sessions.values()].find((session) => session.shown && !session.window.isDestroyed());
}

/**
 * Captures what's on screen, then opens a popup with it. With one already open, its chat takes in the new
 * highlight instead (see `takeCapture`).
 */
export async function openPopup(openSettings: () => void): Promise<void> {
  if (capturing) return;
  // Nothing to answer with yet (the first run): Settings › Models sets up Claude Code, Codex, keys or a model.
  if (!anyModelReady()) {
    openSettings();
    return;
  }
  const open = openSession();
  // Pressed in Kiki itself: nothing new is highlighted, and Kiki's own window is no source.
  if (open?.window.isFocused()) return;
  capturing = true;
  const pointer = screen.getCursorScreenPoint();
  // Its page loads (if it hasn't already) while Kiki reads the screen.
  let window = open ? null : takeWindow();
  let capture: Capture;
  try {
    // Capture before any Kiki window takes focus, so the source app is still "active".
    const settings = getSettings();
    capture = await captureContext(settings.screenshot, settings.nearbyText);
  } catch (error) {
    console.error("[kiki] capture failed:", error);
    capture = { selection: "", notes: ["Kiki couldn't read the screen."] };
  } finally {
    capturing = false;
  }
  // What Kiki couldn't read; the popup doesn't show these.
  if (capture.notes.length > 0) console.info("[kiki] capture:", capture.notes.join(" "));

  if (open && !open.window.isDestroyed()) {
    takeCapture(open, capture);
    return;
  }
  // Closed while Kiki read the screen: a new popup after all.
  window ??= takeWindow();
  for (const session of sessions.values()) session.window.close();
  if (window.isDestroyed()) return;

  const id = window.webContents.id;
  const screenState = newScreenState();
  const session: PopupSession = {
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
    screen: screenState,
    targets: newTargets(capture, screenState),
    question: "",
    look: { text: false, window: false, screenshot: false },
    incoming: null,
    update: false,
    known: null,
    cardTargets: new Map(),
    undo: new UndoStack(),
    cardAbort: null,
  };
  sessions.set(id, session);
  window.on("closed", () => {
    sessions.get(id)?.abort?.abort();
    sessions.delete(id);
    // The process started for its next question has no one to ask it, unless another popup has taken over.
    if (sessions.size === 0) discardSpare();
  });
  waiting.get(id)?.();
  waiting.delete(id);
  watchFullText(session, capture);
  // The page shows the window once it has measured the chat box; this covers a page that never does.
  const fallback = () =>
    setTimeout(() => {
      if (sessions.get(id) === session && !session.shown) void showPopup(session, 120);
    }, 1_500);
  if (window.webContents.isLoading()) window.once("ready-to-show", fallback);
  else fallback();
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
    // The next popup's window loads once this one is out of the way.
    setTimeout(preparePopup, 1_000);
    return layout;
  });
  return session.shown;
}

/**
 * The hotkey, pressed again while the popup is open: the chat stays and takes in the new highlight. Before
 * the first question the popup simply switches to the new window. After it, the capture waits for the next
 * question (an answer on its way keeps scrolling and reading its own window), which carries the highlight,
 * and the window's context when the conversation doesn't have it.
 */
function takeCapture(session: PopupSession, capture: Capture): void {
  const withWindow = showsWindow(session, capture);
  const fresh = !session.conversationId && !session.abort;
  if (fresh) {
    switchCapture(session, capture);
  } else {
    session.incoming = capture;
    broughtIn.add(capture);
  }
  notify(session, {
    type: "recapture",
    fresh,
    withWindow,
    selection: capture.selection.slice(0, 600),
    ...windowContext(capture),
  });
  watchFullText(session, capture);
  void focusPopup(session);
  // The next press's helpers.
  setTimeout(preparePopup, 1_000);
}

/**
 * Whether the popup shows a new capture's window and text: another app, window or page than the conversation
 * has, or nothing highlighted (the window's context is what's new then).
 */
function showsWindow(session: PopupSession, capture: Capture): boolean {
  return isNewPage(session.known ?? pageOf(session.capture), pageOf(capture)) || !capture.selection.trim();
}

/** Moves the session onto `capture`: cards, scrolls and the camera act on its window from now on. */
function switchCapture(session: PopupSession, capture: Capture): void {
  session.capture = capture;
  session.screen = newScreenState();
  session.targets = newTargets(capture, session.screen);
  session.screenshotSent = false;
  session.incoming = null;
}

/** How many window actions are running under the banner, across sessions. */
let bannerDepth = 0;

/**
 * Runs `work` (clicks, keys, pastes, scrolls in the person's windows) under the "Kiki is using your computer"
 * banner, with the GNOME helper (v13); Esc and the banner's Stop stop everything.
 */
async function underBanner<T>(session: PopupSession, work: () => Promise<T>): Promise<T> {
  const show = (session.capture.helperVersion ?? 0) >= WINDOWS_VERSION;
  if (show && bannerDepth++ === 0) await showBanner("Kiki is using your computer");
  try {
    return await work();
  } finally {
    if (show && --bannerDepth === 0) void hideBanner();
  }
}

/** What the target tools get from the session. */
function targetContext(session: PopupSession, send: (event: PopupEvent) => void): TargetContext {
  const { computerUse } = getSettings();
  return {
    targets: session.targets,
    look: session.look,
    question: session.question,
    helperVersion: session.capture.helperVersion ?? 0,
    allow: computerUse,
    signal: session.abort?.signal,
    onTarget: (target) => send({ type: "target", ...targetLabel(target) }),
    banner: (work) => underBanner(session, work),
  };
}

/** Stops every answer and card that's running: Esc or Stop on the banner, or Stop in Kiki's browser. */
export function stopEverything(): void {
  for (const session of sessions.values()) {
    session.abort?.abort();
    session.cardAbort?.abort();
  }
}

/** Gives the open popup the keyboard again, so the question about the new highlight can be typed right away. */
async function focusPopup(session: PopupSession): Promise<void> {
  if (isWayland && (await activatePopup())) return;
  if (session.window.isDestroyed()) return;
  session.window.show();
  session.window.focus();
}

function notify(session: PopupSession, event: PopupEvent): void {
  if (!session.window.isDestroyed()) session.window.webContents.send("popup:event", event);
}

/**
 * Once the window's slower read is done, the popup shows its whole text (and a form further down the page),
 * unless it has moved on to another capture or a past session by then.
 */
function watchFullText(session: PopupSession, capture: Capture): void {
  if (!capture.fullText) return;
  void settleFullText(capture).then(() => {
    if (session.capture !== capture && session.incoming !== capture) return;
    // One the hotkey brought into the chat says what's highlighted too: the full read may have found it.
    const brought = broughtIn.has(capture);
    const selection = brought ? { selection: capture.selection.slice(0, 600) } : {};
    notify(session, { type: "context", ...textSummary(capture), ...selection });
    if (capture.form) {
      notify(session, { type: "fields", fields: formFields(capture.form), ...(brought ? { next: true } : {}) });
    }
  });
}

/** Whether a popup has said this launch that Kiki's GNOME extension is switched off. */
let helperNoteShown = false;

async function placeWindow(session: PopupSession, cardHeight: number): Promise<PopupLayout> {
  const { window } = session;
  let bounds: Rectangle | null = null;
  let size: { width: number; height: number };
  let anchorY: number;
  let shellMove = false;
  let helperOff = false;
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
      const [, off] = await Promise.all([expectPopup(size.width, size.height), helperNoteShown ? false : extensionOff()]);
      // Switched off (in the Extensions app, or by something rewriting GNOME's list): the popup says so, once.
      if (off) {
        helperOff = true;
        helperNoteShown = true;
      }
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
    ...(helperOff ? { helperOff } : {}),
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
/** The least time between two hit-rect calls to the extension (each one is a `gdbus` process). */
const HIT_RECT_MS = 50;

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
      // The box moves every frame while it grows: one call now and then is plenty, and the last rect goes last.
      if (state.latest) await sleep(HIT_RECT_MS);
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

/** The longest edge of the popup's picture of a screenshot: a chip, and a small image in the question. */
const THUMB_EDGE = 480;
const thumbnails = new WeakMap<Screenshot, string>();

/** A small picture of the capture's screenshot for the popup, made once; the full image goes to the model from here. */
function thumbnail(capture: Capture): string | undefined {
  const shot = capture.screenshot;
  if (!shot) return undefined;
  let thumb = thumbnails.get(shot);
  if (!thumb) {
    const image = nativeImage.createFromBuffer(Buffer.from(shot.data, "base64"));
    const { width, height } = image.getSize();
    const small = Math.max(width, height) > THUMB_EDGE ? image.resize(width >= height ? { width: THUMB_EDGE } : { height: THUMB_EDGE }) : image;
    thumb = `data:image/jpeg;base64,${small.toJPEG(70).toString("base64")}`;
    thumbnails.set(shot, thumb);
  }
  return thumb;
}

/** What the popup shows of a capture's window: its chips, and where cards can write in it. */
function windowContext(capture: Capture): WindowContext {
  return {
    appName: capture.appName,
    windowTitle: capture.windowTitle,
    ...textSummary(capture),
    screenshotThumb: thumbnail(capture),
    screenshot: screenshotState(capture),
    ...(capture.editTarget ? { edit: editInfo(capture.editTarget) } : {}),
    ...(capture.form ? { fields: formFields(capture.form) } : {}),
  };
}

/**
 * Swaps in the window's text once its slower read is done; the conversation starts with it. So does what that
 * read found on the way: the page's highlight (which beats the primary selection, or rules it out when the page
 * has none) and a form further down.
 */
async function settleFullText(capture: Capture): Promise<void> {
  const full = await capture.fullText?.catch(() => undefined);
  capture.fullText = undefined;
  if (!full) return;
  if (full.text) capture.text = full.text;
  if (full.selection !== undefined) capture.selection = full.selection;
  capture.form ??= full.form;
}

/** The context a capture's window sends, without what the person removed. */
function contextFor(capture: Capture, omit: ContextOmissions, screenshot: Screenshot | undefined): CaptureContext {
  return {
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
  };
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
    selection: omit.selection ? "" : capture.selection,
    context: contextFor(capture, omit, screenshot),
    ...(earlier.length > 0 ? { earlier } : {}),
    ...(personality ? { personality } : {}),
  };
}

/**
 * What a follow-up carries after the hotkey brought in a new highlight: the highlight, and the window's
 * context when it's another page or the highlight is outside the text the conversation has. The window's
 * screenshot goes with that context.
 */
function highlightUpdate(
  session: PopupSession,
  omit: ContextOmissions,
  screenshot: Screenshot | undefined,
): Pick<FollowUpRequest, "selection" | "context"> {
  const { capture } = session;
  const selection = omit.selection ? "" : capture.selection;
  const withContext = needsContext(session.known, { ...pageOf(capture), selection: capture.selection }, omit.text);
  return {
    ...(selection.trim() ? { selection } : {}),
    ...(withContext ? { context: contextFor(capture, omit, screenshot) } : {}),
  };
}

/**
 * Saves a finished turn to history, so it mirrors what the engine keeps. A session's first turn starts
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
  const send = (event: PopupEvent) => notify(session, event);
  // A highlight the hotkey brought in since the last question: this question is about its window.
  if (session.incoming) {
    switchCapture(session, session.incoming);
    session.update = true;
  }

  let expired = false;
  let pendingId: string | null = null;
  let start: StartConversationRequest | null = null;
  /** The tools this question got; the follow-up likely needs the same. */
  let tools: ToolAccess | undefined;
  let answer = "";
  let sources: Source[] | undefined;
  const actions: SavedAction[] = [];
  /** The window context this question carries, for the conversation to have once it's answered. */
  let carried: PageContext | null = null;
  /** The new highlight it carries. */
  let highlight: string | undefined;
  // Sent with this question; put back if it doesn't go through.
  const outcomes = session.outcomes.splice(0);
  const onEvent = (event: KikiEvent) => {
    if (event.type === "conversation") {
      pendingId = event.id;
      return;
    }
    if (event.type === "tool_call") {
      const conversationId = pendingId;
      if (!conversationId) return;
      void runAppTool(session, event, send)
        // A tool that threw still answers, or the turn would wait out the engine's timeout.
        .catch((error: unknown): ToolResult => ({ id: event.id, content: `Kiki couldn't run that: ${errorMessage(error)}`, isError: true }))
        .then((result) => sendToolResults(conversationId, [result]));
      return;
    }
    if (event.type === "action") {
      const applied = session.actions.get(event.action.id);
      if (applied) {
        // Applied right away ("Act without asking"): the popup has the card already, done; the turn keeps it.
        actions.push(applied);
        return;
      }
      // The card says what Kiki read on those controls, not what Claude called them.
      if (event.action.kind === "press") event.action.presses = describePresses(event.action.presses, cardTargetFor(session).screen);
      const saved: SavedAction = { action: event.action };
      actions.push(saved);
      session.actions.set(event.action.id, saved);
      session.cardTargets.set(event.action.id, cardTargetFor(session));
    }
    if (event.type === "error" && event.code === "expired") {
      expired = true;
      return;
    }
    if (event.type === "text") answer += event.delta;
    if (event.type === "notes") answer = answer.slice(0, Math.max(0, answer.length - event.chars));
    if (event.type === "sources") sources = event.items;
    // The popup hears first; saving the turn can wait.
    send(event);
    // Only keep a conversation the engine finished, so a failed first turn starts over.
    if (event.type === "done" && pendingId) {
      session.conversationId = pendingId;
      if (carried) session.known = carried;
      session.update = false;
      recordTurn(
        session,
        {
          question: options.question.trim(),
          answer,
          ...(sources ? { sources } : {}),
          ...(event.stopReason === "max_tokens" ? { cutOff: true } : {}),
          ...(options.images?.length ? { images: options.images.length } : {}),
          ...(options.files?.length ? { files: options.files.map((file) => file.name) } : {}),
          ...(actions.length ? { actions } : {}),
          ...(highlight ? { highlight } : {}),
        },
        start,
      );
      outcomes.length = 0;
      // The follow-up's process starts now, so that question doesn't wait for one.
      warmFor(session, options.options, tools);
    }
  };

  try {
    // A follow-up that carries a new highlight goes by what the person kept of its window.
    const updating = Boolean(session.conversationId) && session.update;
    // A new conversation (or window) starts with the window's text; the form the full read found decides the tools.
    if (!session.conversationId || updating) await settleFullText(session.capture);
    const omitted = session.conversationId && !updating ? session.omit : options.omit;
    session.question = options.question.trim();
    // Each answer starts where the question came from.
    session.targets.current = session.targets.source;
    // The camera is this question's call, whatever the conversation kept of the window.
    const allowed = questionTools(session.capture, { ...omitted, screenshot: options.omit.screenshot });
    session.look = allowed.look;
    tools = allowed.tools;
    const turn: FollowUpRequest = {
      question: options.question.trim(),
      ...(options.images?.length ? { images: options.images } : {}),
      ...(options.files?.length ? { files: options.files } : {}),
      ...(options.options ? { options: options.options } : {}),
      tools,
      clock: currentClock(),
      ...(outcomes.length ? { actionOutcomes: outcomes.slice(-LIMITS.actionOutcomes) } : {}),
    };
    // Sent once per conversation: with the first question, or with the first one after it's turned on.
    const screenshot =
      options.omit.screenshot || session.screenshotSent ? undefined : session.capture.screenshot;
    if (session.conversationId) {
      const update = updating ? highlightUpdate(session, options.omit, screenshot) : {};
      if (updating) session.omit = options.omit;
      highlight = update.selection;
      if (update.context) carried = pageOf(session.capture);
      // A new window's screenshot goes with its context.
      const shot = update.context ? undefined : screenshot;
      const images = shot ? [shot, ...(turn.images ?? [])].slice(0, LIMITS.imagesPerQuestion) : turn.images;
      await askEngine(session.conversationId, { ...turn, ...update, ...(images?.length ? { images } : {}) }, onEvent, controller.signal);
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
    carried = pageOf(session.capture);
    await askEngine(null, start, onEvent, controller.signal);
    if (contextShot) session.screenshotSent = true;
  } finally {
    session.abort = null;
    // Not answered: Claude still needs to hear about these.
    session.outcomes.unshift(...outcomes);
    // Pages opened for this answer close unless kept; the next question starts from the hotkey's window.
    if (browserUsed) kikiBrowser().endTurn();
    if (session.targets.current !== session.targets.source) {
      session.targets.current = session.targets.source;
      send({ type: "target", kind: "window", label: null });
    }
    send({ type: "end" });
  }
}

/** Whether Kiki's browser was ever opened, so `endTurn` doesn't create it. */
let browserUsed = false;

function isTargetToolName(name: string): boolean {
  return (TARGET_TOOLS as readonly string[]).includes(name);
}

/**
 * What a question about `capture` may look at (`look`) and the tools it gets, with what the person left out
 * of the context (`omit`) kept from them. The question's own code path, so the warm-up's guess is the same.
 */
function questionTools(capture: Capture, omit: ContextOmissions): { look: ScreenAccess; tools: ToolAccess } {
  const google = googleAccount().connected;
  const { computerUse } = getSettings();
  const helper = capture.helperVersion ?? 0;
  const browse = computerUse.browser;
  const windows = process.platform === "linux" && computerUse.windows && helper >= WINDOWS_VERSION;
  const coordinates = browse || (computerUse.coordinates && helper >= WINDOWS_VERSION);
  const look: ScreenAccess = {
    text: !omit.text,
    window: !omit.window,
    // The camera: on when it took a screenshot and the person didn't turn it off for the question.
    screenshot: Boolean(capture.screenshot) && !omit.screenshot,
    coordinates,
  };
  const screen = screenTools(capture, look);
  const tools: ToolAccess = {
    actions: true,
    open: true,
    calendarRead: google,
    tasksRead: google,
    ...writeTools(capture, omit.text),
    ...screen,
    // Kiki's browser and other windows are looked at with the same scroll, look and click tools.
    ...(browse || windows ? { screen: true, click: true } : {}),
    ...(screen.screen || browse || windows ? { act: true } : {}),
    ...(browse ? { browse: true } : {}),
    ...(windows ? { windows: true } : {}),
    ...(coordinates ? { coordinates: true } : {}),
    ...(computerUse.autoApprove ? { autoApprove: true } : {}),
  };
  return { look, tools };
}

/** Starts a Claude Code process for the question the popup is likely to ask next, so it doesn't wait for one (`Engine.warm`). */
function warmFor(session: PopupSession, options: QuestionOptions | undefined, tools: ToolAccess | undefined): void {
  const personality = personalityPrompt(getSettings());
  warmEngine({
    ...(session.conversationId ? { conversationId: session.conversationId } : {}),
    ...(options ? { options } : {}),
    ...(tools ? { tools } : {}),
    ...(personality ? { personality } : {}),
  });
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
  if (isTargetToolName(call.name)) {
    if (call.name === "open_url" || call.name === "browser") browserUsed = true;
    const before = session.targets.current;
    if (call.name === "click") {
      const control = (before.kind === "browser" ? before.tab.state : before.screen).controls.get(String(call.input["control"] ?? "").trim());
      if (control) send({ type: "activity", activity: { kind: "click", label: control.name } });
    }
    const result = await runTargetTool(targetContext(session, send), call);
    // Fields that scrolled into view (or a new page's) can be filled: fill cards need their labels.
    const target = session.targets.current;
    if (result.screen?.fields) {
      if (target.kind === "browser") send({ type: "fields", fields: result.screen.fields });
      else if (target.capture.form) send({ type: "fields", fields: formFields(target.capture.form) });
    }
    return result;
  }
  const target = session.targets.current;
  // "Act without asking": a card that fits is applied right away, and the model hears what happened, unless
  // it's one that still waits for the person (a password, a card number, a payment).
  const now = getSettings().computerUse.autoApprove && !waitsForPerson(target, call.input as unknown as ProposedAction);
  if (call.name === "propose_press") {
    const presses = list<PressTarget>("presses");
    const problems = target.kind === "browser" ? tabPressProblems(target.tab, presses) : await pressProblems(target.capture.source, target.screen, presses);
    if (problems) return { id: call.id, content: problems, isError: true };
    return now ? applyNow(session, call, send) : { id: call.id, content: "All of them can be pressed." };
  }
  if (call.name === "propose_changes") {
    const checked = await checkChanges(session.capture.editTarget, list<TextChange>("changes"));
    if (checked.isError || !now) return { id: call.id, ...checked };
    return applyNow(session, call, send);
  }
  if (call.name === "propose_fill") {
    const values = list<FieldValue>("fields");
    const problems = target.kind === "browser" ? tabFillProblems(target.tab, values) : fillProblems(target.capture.form, values);
    if (problems) return { id: call.id, content: problems, isError: true };
    return now ? applyNow(session, call, send) : { id: call.id, content: "All values fit the form." };
  }
  if (call.name === "propose_edit") return now ? applyNow(session, call, send) : { id: call.id, content: "The edit fits." };
  if (call.name === "list_calendar_events" || call.name === "list_tasks") return runReadTool(call.id, call.name, call.input);
  return { id: call.id, content: `The tool ${call.name} isn't available.`, isError: true };
}

/** The buttons each kind of card has. */
function fitsCard(kind: ProposedAction["kind"], mode: ActionMode): boolean {
  if (mode === "dismiss") return true;
  if (mode === "undo") return kind === "edit" || kind === "changes" || kind === "fill";
  if (kind === "edit" || kind === "changes") return mode === "apply" || mode === "copy";
  if (kind === "fill" || kind === "press") return mode === "apply";
  return mode !== "apply" && mode !== "copy";
}

/** Runs a card's button in the window it was proposed for, or with Google. `signal` stops it between steps. */
async function runButton(target: CardTarget, action: ProposedAction, mode: ActionMode, signal: AbortSignal): Promise<Applied> {
  const { capture } = target;
  if (mode === "dismiss" && (action.kind === "changes" || action.kind === "fill" || action.kind === "press")) {
    return { status: { outcome: "dismissed", message: "Dismissed." } };
  }
  switch (action.kind) {
    case "edit":
      return applyEdit(capture.editTarget, action.text, mode, capture.appName);
    case "changes":
      return applyChanges(capture.editTarget, action.changes, mode === "copy" ? "copy" : "apply", capture.appName, signal);
    case "fill":
      if (target.tab) return { status: await tabApplyFill(target.tab, action.fields) };
      return applyFill(capture.form, action.fields, capture.appName, signal);
    case "press":
      if (target.tab) return { status: await tabApplyPresses(target.tab, action.presses) };
      return { status: await applyPresses(capture.source, target.screen, action.presses, capture.appName) };
    default:
      return { status: await runAction(action, mode) };
  }
}

/** Cards whose buttons act in the person's windows: they run under the banner. */
function actsInWindow(target: CardTarget, action: ProposedAction, mode: ActionMode): boolean {
  if (target.tab || mode === "dismiss" || mode === "copy") return false;
  return action.kind === "edit" || action.kind === "changes" || action.kind === "fill" || action.kind === "press";
}

/**
 * Runs a card's button in its window (or with Google) and records what happened on the card: its status, and
 * whether Undo can put back what it wrote. Throws when the button failed, with a message for the card.
 */
async function applyButton(session: PopupSession, target: CardTarget, saved: SavedAction, action: ProposedAction, mode: ActionMode): Promise<void> {
  const controller = startCard(session);
  try {
    const applied = actsInWindow(target, action, mode)
      ? await underBanner(session, () => runButton(target, action, mode, controller.signal))
      : await runButton(target, action, mode, controller.signal);
    saved.status = applied.status;
    saved.action = action;
    // What the card wrote can be put back from its Undo button, while this session is open.
    if (applied.undo?.steps.length && (action.kind === "edit" || action.kind === "changes" || action.kind === "fill")) {
      session.undo.push({ id: action.id, kind: action.kind, capture: target.capture, appName: target.capture.appName, ...applied.undo });
      saved.undoable = true;
    }
  } finally {
    endCard(session, controller);
  }
}

/**
 * "Act without asking": applies a card the moment the model proposes it, where Kiki is looking, shows it in the
 * popup as done (with Undo where there is one), and answers the model with what happened and the screen
 * afterwards. Only edit, changes, fill and press cards come here; Google cards still wait for the person.
 */
async function applyNow(session: PopupSession, call: Extract<KikiEvent, { type: "tool_call" }>, send: (event: PopupEvent) => void): Promise<ToolResult> {
  // The engine sends the proposal it checked, with its id and kind.
  const action = { ...(call.input as unknown as ProposedAction) };
  const target = cardTargetFor(session);
  if (action.kind === "press") action.presses = describePresses(action.presses, target.screen);
  const saved: SavedAction = { action };
  session.actions.set(action.id, saved);
  session.cardTargets.set(action.id, target);
  try {
    await applyButton(session, target, saved, action, "apply");
  } catch (error) {
    saved.status = { outcome: "failed", message: errorMessage(error) };
  }
  const result = cardResult(session, saved, target, ["edit", "changes"]);
  send({ type: "card", saved, ...(result.ok && result.edit !== undefined ? { edit: result.edit } : {}) });
  const status = saved.status!;
  if (status.outcome === "failed") {
    return { id: call.id, content: `Kiki applied the ${action.kind} card right away, but it failed: ${status.message}`, isError: true, applied: true };
  }
  // What happened, then the screen as it is now.
  const look = await runTargetTool(targetContext(session, send), { id: call.id, name: "look", input: {} });
  const summary = outcomeFor(action, status).summary;
  return {
    id: call.id,
    content: `Applied right away, as the person set Kiki to act without asking: ${summary}${look.isError ? "" : ` ${look.content}`}`,
    ...(look.screen ? { screen: look.screen } : {}),
    applied: true,
  };
}

/** Starts a card's button: only one runs at a time, and Stop (`popup:cancel`) aborts it. */
function startCard(session: PopupSession): AbortController {
  const controller = new AbortController();
  session.cardAbort?.abort();
  session.cardAbort = controller;
  return controller;
}

function endCard(session: PopupSession, controller: AbortController): void {
  if (session.cardAbort === controller) session.cardAbort = null;
}

/** Remembers what became of a card: Claude hears it with the next question, and the session's history keeps it. */
function recordOutcome(session: PopupSession, action: ProposedAction, status: ActionStatus): void {
  session.outcomes = session.outcomes.filter((outcome) => outcome.id !== action.id);
  session.outcomes.push(outcomeFor(action, status));
  if (session.entry) saveEntry(session.entry);
}

/** A card's result, with where edits go now when a card of one of `kinds` wrote in the window new cards are for. */
function cardResult(session: PopupSession, saved: SavedAction, target: CardTarget, kinds: ProposedAction["kind"][]): ActionRunResult {
  const writes = kinds.includes(saved.action.kind) && target.capture === session.capture;
  return writes ? { ok: true, saved, edit: editInfo(target.capture.editTarget) ?? null } : { ok: true, saved };
}

/** Runs a button on one of the session's action cards and remembers what happened. */
async function runCard(session: PopupSession, id: string, edited: unknown, mode: ActionMode): Promise<ActionRunResult> {
  const saved = session.actions.get(id);
  if (!saved || !fitsCard(saved.action.kind, mode)) return { ok: false, message: "Kiki couldn't find that card." };
  if (mode === "undo") return undoCard(session, saved);
  if (saved.status && saved.status.outcome !== "failed") return { ok: true, saved };
  const action = mode === "dismiss" ? saved.action : applyEdits(saved.action, edited);
  if ("error" in action) return { ok: false, message: action.error };
  // Cards from before the hotkey brought in another window still act on theirs.
  const target = session.cardTargets.get(id) ?? { capture: session.capture, screen: session.screen };
  try {
    await applyButton(session, target, saved, action, mode);
  } catch (error) {
    const message = errorMessage(error);
    // A failure the person can fix (e.g. a missing recipient) stays open to try again.
    saved.status = { outcome: "failed", message };
    recordOutcome(session, action, saved.status);
    return { ok: false, message };
  }
  recordOutcome(session, saved.action, saved.status!);
  // Where edits go now: after an edit, onto Kiki's text.
  return cardResult(session, saved, target, ["edit", "changes"]);
}

/**
 * Puts back what an applied card wrote (its Undo button), and tells Claude with the next question. The card
 * then says so; one whose text is gone loses its Undo button instead.
 */
async function undoCard(session: PopupSession, saved: SavedAction): Promise<ActionRunResult> {
  const { id } = saved.action;
  const check = session.undo.peek(id, session.capture);
  if ("error" in check) return { ok: false, message: check.error };
  const target = session.cardTargets.get(id) ?? { capture: session.capture, screen: session.screen };
  const controller = startCard(session);
  let status: ActionStatus;
  try {
    status = await underBanner(session, () => undoRecord(check.record, controller.signal));
    // Stopped before anything was undone: the card stays as it was, Undo included.
    if (status.outcome !== "undone") return { ok: false, message: status.message };
    session.undo.remove(id);
    saved.undoable = false;
    saved.status = status;
    // The next edit card writes where the original is again.
    if (saved.action.kind === "edit" && target.capture.editTarget) retargetUndo(target.capture.editTarget, check.record.steps[0]);
  } catch (error) {
    const message = errorMessage(error);
    if (!(error instanceof UndoGone)) return { ok: false, message };
    // Nothing is left to undo: the button goes, and the card says why.
    session.undo.remove(id);
    saved.undoable = false;
    if (saved.status) saved.status = { ...saved.status, message: `${saved.status.message} ${message}` };
    if (session.entry) saveEntry(session.entry);
    return { ok: true, saved };
  } finally {
    endCard(session, controller);
  }
  recordOutcome(session, saved.action, status);
  return cardResult(session, saved, target, ["edit"]);
}

export function registerPopupIpc(openSettings: () => void): void {
  // Stop in Kiki's browser window stops the answer that's driving it.
  kikiBrowser().onStop = stopEverything;
  ipcMain.handle("popup:init", async (event): Promise<PopupInit | null> => {
    const { id } = event.sender;
    // A popup loaded ahead of the hotkey waits here for its capture.
    if (!sessions.has(id)) await new Promise<void>((resolve) => waiting.set(id, resolve));
    const session = sessionFor(event.sender);
    if (!session) return null;
    return {
      ...windowContext(session.capture),
      configured: anyModelReady(),
      google: googleAccount().connected,
      ...modelMenu(),
    };
  });
  ipcMain.handle("popup:ask", async (event, options: AskOptions) => {
    const session = sessionFor(event.sender);
    if (session && typeof options?.question === "string" && options.question.trim()) {
      await ask(session, {
        question: options.question,
        omit: options.omit ?? {},
        images: Array.isArray(options.images) ? options.images : undefined,
        files: Array.isArray(options.files) ? options.files : undefined,
        options: options.options,
      });
    }
  });
  // The composer is up: a Claude Code process for the question it's likely to ask starts now.
  ipcMain.on("popup:warm", async (event, options: unknown) => {
    const session = sessionFor(event.sender);
    if (!session || session.conversationId || session.abort) return;
    // The form the slower read finds decides the tools, as it will for the question.
    await settleFullText(session.capture);
    if (session.conversationId || session.abort) return;
    warmFor(session, options as QuestionOptions | undefined, questionTools(session.capture, {}).tools);
  });
  ipcMain.handle("popup:screenshot", async (event): Promise<string | null> => {
    const session = sessionFor(event.sender);
    if (!session || getSettings().screenshot === "never") return null;
    // Of the window the next question is about.
    const capture = session.incoming ?? session.capture;
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
      saved: Boolean(entry.saved),
    }));
  });
  ipcMain.handle("popup:openSession", (event, id: unknown): PastSession | null => {
    const session = sessionFor(event.sender);
    if (!session || session.abort || typeof id !== "string") return null;
    const stored = getEntry(id);
    if (!stored) return null;
    // The popup carries on with that session: its context, and its conversation while the engine has it.
    const entry = structuredClone(stored);
    session.entry = entry;
    session.capture = { ...entry.context, notes: [] };
    session.omit = {};
    session.conversationId = entry.conversationId;
    // Its screenshot (if any) wasn't saved, and the one for this window doesn't belong to it.
    session.screenshotSent = true;
    session.actions = new Map(entry.turns.flatMap((turn) => turn.actions ?? []).map((saved) => [saved.action.id, saved]));
    // What those cards wrote can't be undone from here: the session that wrote it is gone.
    for (const saved of session.actions.values()) delete saved.undoable;
    session.cardTargets = new Map();
    session.undo = new UndoStack();
    session.outcomes = [];
    session.screen = newScreenState();
    session.targets = newTargets(session.capture, session.screen);
    session.incoming = null;
    session.update = false;
    session.known = pageOf(entry.context);
    return {
      id: entry.id,
      appName: entry.context.appName,
      windowTitle: entry.context.windowTitle,
      ...textSummary(session.capture),
      turns: entry.turns,
    };
  });
  ipcMain.handle("popup:clearHistory", () => clearHistory());
  ipcMain.handle("popup:saveSession", (event, id: unknown, saved: unknown): boolean => {
    if (typeof id !== "string" || typeof saved !== "boolean" || !setSaved(id, saved)) return false;
    const entry = sessionFor(event.sender)?.entry;
    if (entry?.id !== id) return true;
    if (saved) entry.saved = true;
    else delete entry.saved;
    return true;
  });
  ipcMain.handle("popup:runAction", async (event, id: unknown, edited: unknown, mode: unknown): Promise<ActionRunResult> => {
    const session = sessionFor(event.sender);
    const modes: ActionMode[] = ["add", "draft", "send", "open", "apply", "copy", "dismiss", "undo"];
    if (!session || typeof id !== "string" || !modes.includes(mode as ActionMode)) {
      return { ok: false, message: "Kiki couldn't run that." };
    }
    return runCard(session, id, edited, mode as ActionMode);
  });
  // The popup has the keyboard when it's clicked, so GNOME takes the write.
  ipcMain.handle("popup:copy", (event, text: unknown) => {
    if (sessionFor(event.sender) && typeof text === "string" && text.length <= 1_000_000) clipboard.writeText(text);
  });
  // Stop: the answer on its way, and a card's button that's still running.
  ipcMain.on("popup:cancel", (event) => {
    const session = sessionFor(event.sender);
    session?.abort?.abort();
    session?.cardAbort?.abort();
  });
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
  ipcMain.handle("popup:enableExtension", async (event): Promise<ActionResult> => {
    if (!sessionFor(event.sender)) return { ok: false, message: "This popup has closed." };
    try {
      await enableExtension();
      // A shell that loaded the extension at login turns it on right away; otherwise it waits for one.
      return (await waitForExtension())
        ? { ok: true, message: "Turned on. Kiki opens at the pointer from the next time you ask." }
        : { ok: true, message: "Turned on. Log out and back in to finish." };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  });
}
