import { LIMITS, type FollowUpRequest, type KikiEvent, type Screenshot, type StartConversationRequest } from "@kiki/shared";
import { BrowserWindow, ipcMain, screen, type Rectangle, type WebContents } from "electron";
import {
  INSETS,
  maxCardHeight,
  popupGeometry,
  type Point,
} from "../../resources/gnome-extension/kiki-popup@kiki.app/placement.js";
import { POPUP_WIDTH } from "../renderer/layout.ts";
import type { AskOptions, ContextOmissions, PopupEvent, PopupInit, PopupLayout } from "../shared-types.ts";
import { streamRequest } from "./api.ts";
import { captureContext, type Capture } from "./capture/index.ts";
import { expectPopup, placePopup } from "./linuxSetup.ts";
import { getAccessCode, getSettings } from "./settings.ts";
import { createPopupWindow, isWayland, openExternal } from "./windows.ts";

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
  });
  window.on("closed", () => {
    sessions.get(id)?.abort?.abort();
    sessions.delete(id);
  });
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
  if (isWayland) {
    // Apps can't place windows on Wayland: Kiki's GNOME extension opens it at the pointer.
    const placed = await placePopup(cardHeight);
    if (placed) {
      size = placed;
      anchorY = placed.anchorY;
    } else {
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
  return { height: size.height, anchorY, maxCard: size.height - INSETS.top - INSETS.bottom };
}

function sessionFor(sender: WebContents): PopupSession | undefined {
  return sessions.get(sender.id);
}

function thumbnail(capture: Capture): string | undefined {
  if (!capture.screenshot) return undefined;
  return `data:${capture.screenshot.mediaType};base64,${capture.screenshot.data}`;
}

/** Swaps in the whole page text once its slower read is done; the conversation starts with it. */
async function settleFullText(capture: Capture): Promise<void> {
  const full = await capture.fullText?.catch(() => undefined);
  capture.fullText = undefined;
  if (full && full.length > (capture.text?.length ?? 0)) capture.text = full;
}

function startRequest(
  session: PopupSession,
  turn: FollowUpRequest,
  screenshot: Screenshot | undefined,
): StartConversationRequest {
  const { capture, omit } = session;
  return {
    ...turn,
    selection: capture.selection,
    context: {
      appName: omit.window ? undefined : capture.appName,
      windowTitle: omit.window ? undefined : capture.windowTitle,
      text: omit.text ? undefined : capture.text,
      screenshot,
    },
  };
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
  const onEvent = (event: KikiEvent) => {
    if (event.type === "conversation") {
      pendingId = event.id;
      return;
    }
    if (event.type === "error" && event.code === "expired") {
      expired = true;
      return;
    }
    // Only keep a conversation the server finished, so a failed first turn starts over.
    if (event.type === "done" && pendingId) session.conversationId = pendingId;
    send(event);
  };

  try {
    const turn: FollowUpRequest = {
      question: options.question.trim(),
      ...(options.images?.length ? { images: options.images } : {}),
      ...(options.options ? { options: options.options } : {}),
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
      send({ type: "notice", message: "The earlier conversation expired, so Kiki started a new one with the same context." });
    } else {
      session.omit = options.omit;
    }
    await settleFullText(session.capture);
    // A new conversation (or one restarted after expiring) carries the screenshot as context.
    const contextShot = options.omit.screenshot ? undefined : session.capture.screenshot;
    await streamRequest("/v1/conversations", startRequest(session, turn, contextShot), onEvent, controller.signal);
    if (contextShot) session.screenshotSent = true;
  } finally {
    session.abort = null;
    send({ type: "end" });
  }
}

export function registerPopupIpc(openSettings: () => void): void {
  ipcMain.handle("popup:init", (event): PopupInit | null => {
    const session = sessionFor(event.sender);
    if (!session) return null;
    const { capture } = session;
    return {
      appName: capture.appName,
      windowTitle: capture.windowTitle,
      textChars: capture.text?.length ?? 0,
      textPreview: capture.text?.slice(0, 600),
      screenshotThumb: thumbnail(capture),
      screenshot: screenshotState(capture),
      configured: Boolean(getSettings().serverUrl && getAccessCode()),
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
  ipcMain.on("popup:cancel", (event) => sessionFor(event.sender)?.abort?.abort());
  ipcMain.on("popup:close", (event) => sessionFor(event.sender)?.window.close());
  ipcMain.on("popup:openLink", (_event, url: string) => openExternal(url));
  ipcMain.on("popup:openSettings", () => openSettings());
}
