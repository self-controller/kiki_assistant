// Kiki's own browser: pages Kiki opens for the person in hidden tabs, read as text with ids on their links,
// buttons and fields (like the window the question came from), and driven over Chrome's DevTools protocol:
// clicks, typing, keys, scrolls, and screenshots. After every action the page is waited for (a navigation it
// started, its load and network, then for it to stop changing) before it's read, with caps on every wait. The
// browser shows only when the person should see the page or do something there themselves. Tabs opened for an
// answer close when it's done unless kept. It uses its own profile ("persist:kiki-browser"), separate from the
// person's browser, so sites they log into stay logged in.
import { join } from "node:path";
import { existsSync } from "node:fs";
import { LIMITS, type ActKey, type FormField, type MouseButton, type ScreenPoint, type ScrollRequest } from "@kiki/shared";
import { app, BrowserWindow, ipcMain, session, WebContentsView, type NativeImage, type Session, type WebContents } from "electron";
import type { BrowserState } from "../shared-types.ts";
import { fractionOf, sizedScreenshot, type ScreenshotSize, type SizedScreenshot } from "./images.ts";
import { controlIdFor, newScreenState, screenText, type ControlTarget, type ScreenState } from "./screen.ts";
import { loadPage, preloadPath } from "./windows.ts";

const PARTITION = "persist:kiki-browser";
/** The toolbar page above the tab, in the visible window. */
export const TOOLBAR_HEIGHT = 44;
const WINDOW_SIZE = { width: 1100, height: 820 };
const LOAD_TIMEOUT_MS = 20_000;
/** After an action: how long a navigation, or a change to the page, gets to start before it's read in place. */
const NAV_DETECT_MS = 800;
/** A page is quiet once nothing in it has changed for this long, and nothing it asked for is on its way. */
const QUIET_MS = 300;
/** How long a page gets to go quiet before it's read anyway (then two reads must agree). */
const QUIET_MAX_MS = 1_500;
/** How long a new page gets to fire its load event before it's read as still loading. */
const LOAD_MAX_MS = 8_000;
/** After a new page's load event: how long what it asks for next (data, scripts) gets to arrive and settle. */
const AFTER_LOAD_MAX_MS = 2_500;
/** How often the page is asked whether it's still changing. */
const POLL_MS = 100;
/** A request on its way longer than this (long polling, a stream) doesn't keep the page from being quiet. */
const STALE_REQUEST_MS = 5_000;
/** An element's box is measured again this much later, and clicked once two measurements agree. */
const STABLE_MS = 50;
const STABLE_MAX_MS = 500;
/** When the page wouldn't go quiet, reads this far apart must agree. */
const READ_AGREE_MS = 300;
/** Requests whose answer changes what the page says; images, fonts, media and sockets don't count. */
const TRACKED_REQUESTS = new Set(["Document", "Script", "Stylesheet", "XHR", "Fetch"]);
/** How often the offscreen page paints on its own; `capturePage` gets a fresh frame regardless. */
const OFFSCREEN_FPS = 2;
const MAX_TABS = 6;
/** A DevTools call that takes longer than this has hung (a hidden page that never answers). */
const CDP_TIMEOUT_MS = 10_000;
/** The most page text one read keeps (before the screen-text limit). */
const MAX_RAW_CHARS = 60_000;
/** A screen scroll, as a share of the viewport. */
const SCREEN_SHARE = 0.85;
/** Kiki's own input events, which aren't the person taking over, within this much of being sent. */
const INJECT_GRACE_MS = 150;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A node of Chrome's accessibility tree (Accessibility.getFullAXTree). */
interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  description?: { value?: unknown };
  properties?: Array<{ name: string; value: { value?: unknown } }>;
  childIds?: string[];
  backendDOMNodeId?: number;
  parentId?: string;
}

/** A control the tree had: where to click it, what it says (with its state), and its accessible name alone. */
interface SeenControl {
  path: number[];
  role: string;
  name: string;
  axName: string;
}

/** A dialog the tree had open: a modal, or a cookie or consent notice, with the controls in it (by index). */
export interface SeenDialog {
  name: string;
  consent: boolean;
  controls: number[];
}

/** A field the tree had. */
export interface SeenField {
  backendId: number;
  role: string;
  label: string;
  kind: FormField["kind"];
  value?: string;
  checked?: boolean;
  password: boolean;
  /** A drop-down: typing picks the option that says that. */
  select: boolean;
}

/** A field with its id, as the tab keeps it, and the document it was read in. */
export interface BrowserField extends SeenField {
  id: string;
  epoch: number;
}

/** A dialog, as the next read notes it: what it says, and the ids of its controls. */
interface OpenDialog {
  name: string;
  consent: boolean;
  controls: string[];
}

/** Names of regions that are cookie or consent notices. */
const CONSENT_RE = /\b(cookies?|consent|privacy (choices|preferences|settings)|gdpr)\b/i;
/** Buttons that only a cookie or consent notice has. */
const CONSENT_BUTTON_RE =
  /^(accept( all)?( cookies)?|allow( all)?( cookies)?|i (agree|accept)|agree( and (close|continue))?|got it|ok(ay)?|reject( all)?( cookies)?|decline( all)?|only (necessary|essential)|(necessary|essential)( cookies)? only|manage (cookies|preferences|settings|choices)|cookie settings|customi[sz]e)$/i;
/** Lines the dialog detector reads as the dialog's own text start (not a control's marker). */
const MARKER_START = /^[\ue001\ue004]/;

/** Roles whose element Kiki clicks (it gets a ⟦b…⟧ marker). */
const CONTROL_ROLES = new Set([
  "link",
  "button",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "disclosuretriangle",
  "treeitem",
  "option",
  "menulistoption",
  "popupbutton",
  "listboxoption",
  "togglebutton",
]);
/** Roles that are fields (⟦f…⟧, listed in <form_fields>). */
const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "spinbutton", "slider", "textfield"]);
/** Roles that start a new line. */
const BLOCK_ROLES = new Set([
  "paragraph",
  "heading",
  "listitem",
  "list",
  "article",
  "section",
  "region",
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "form",
  "table",
  "grid",
  "row",
  "figure",
  "figcaption",
  "blockquote",
  "dialog",
  "alertdialog",
  "alert",
  "status",
  "log",
  "document",
  "rootwebarea",
  "webarea",
  "linebreak",
  "descriptionlist",
  "descriptionlistterm",
  "descriptionlistdetail",
  "group",
  "search",
  "menu",
  "menubar",
  "toolbar",
  "tablist",
  "tree",
  "listbox",
  "code",
  "pre",
  "details",
  "summary",
  "term",
  "definition",
  "footer",
  "header",
  "iframe",
  "iframepresentational",
]);
const CELL_ROLES = new Set(["cell", "gridcell", "columnheader", "rowheader"]);
const SKIP_ROLES = new Set(["inlinetextbox", "listmarker", "scrollbar", "splitter", "none", "presentation"]);
const TEXT_ROLES = new Set(["statictext", "text"]);

function squash(text: string): string {
  return text.replace(/[-⟦⟧]/g, "").replace(/\s+/g, " ").trim();
}

function prop(node: AXNode, name: string): unknown {
  return node.properties?.find((property) => property.name === name)?.value.value;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

/**
 * The tree as Kiki's screen text, with markers where controls and fields are (the same private-use characters
 * the Linux helper uses, so `screenText` turns them into ⟦b3 Name⟧), plus the controls, fields and open
 * dialogs seen. A dialog is a modal, or a block that is a cookie or consent notice (by its name, or by the
 * buttons only those have), with the controls in it.
 */
export function axToScreen(
  nodes: AXNode[],
  passwordNodes: Set<number>,
  visible?: Set<number>,
): { raw: string; controls: SeenControl[]; fields: SeenField[]; dialogs: SeenDialog[] } {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  // Only what's on screen, when the layout says where things are (containers aren't filtered: their children are).
  const onScreen = (node: AXNode) => !visible || node.backendDOMNodeId === undefined || visible.has(node.backendDOMNodeId);
  const root = nodes.find((node) => !node.parentId) ?? nodes[0];
  const controls: SeenControl[] = [];
  const fields: SeenField[] = [];
  const dialogs: SeenDialog[] = [];
  /** The blocks being walked, outermost first, to find the dialogs among them. */
  const frames: Array<{ name: string; modal: boolean; consent: boolean; controls: number[]; firstText: string }> = [];
  const lines: string[] = [];
  let line = "";
  let chars = 0;
  const flush = () => {
    const trimmed = line.replace(/\s+\|\s*$/, "").trim();
    if (trimmed) lines.push(trimmed);
    line = "";
  };
  const add = (text: string) => {
    if (!text) return;
    line += (line && !line.endsWith(" ") ? " " : "") + text;
    chars += text.length;
    if (text.length >= 3 && !MARKER_START.test(text)) for (const frame of frames) if (!frame.firstText) frame.firstText = text.slice(0, 80);
  };
  const walk = (node: AXNode): void => {
    if (chars > MAX_RAW_CHARS) return;
    const role = str(node.role?.value).toLowerCase();
    if (prop(node, "hidden") === true) return;
    const children = (node.childIds ?? []).map((id) => byId.get(id)).filter((child): child is AXNode => Boolean(child));
    if (node.ignored || SKIP_ROLES.has(role)) {
      if (!SKIP_ROLES.has(role) || role === "none" || role === "presentation") for (const child of children) walk(child);
      return;
    }
    const name = squash(str(node.name?.value));
    const value = squash(str(node.value?.value));
    const disabled = prop(node, "disabled") === true;
    const leafish = FIELD_ROLES.has(role) || CONTROL_ROLES.has(role) || TEXT_ROLES.has(role) || role === "image" || role === "img";
    if (leafish && !onScreen(node)) return;
    if (FIELD_ROLES.has(role)) {
      const backendId = node.backendDOMNodeId ?? -1;
      const toggle = role === "checkbox" || role === "switch" || role === "radio" || role === "menuitemcheckbox";
      const editable = prop(node, "editable") !== undefined;
      const select = role === "combobox" && !editable;
      const label = (name || squash(str(node.description?.value)) || role).slice(0, LIMITS.fieldLabelChars);
      const checked = prop(node, "checked");
      const field: SeenField = {
        backendId,
        role,
        label,
        kind: toggle ? (role === "radio" ? "radio" : "checkbox") : prop(node, "multiline") === true ? "textarea" : "text",
        password: passwordNodes.has(backendId),
        select,
        ...(toggle ? { checked: checked === "true" || checked === true } : { value: passwordNodes.has(backendId) ? "" : value.slice(0, LIMITS.fieldValueChars) }),
      };
      if (!disabled && backendId >= 0) {
        fields.push(field);
        add(`${fields.length - 1}${label}`);
      } else {
        add(label);
      }
      return;
    }
    const pressed = prop(node, "pressed");
    const isControl = CONTROL_ROLES.has(role) || (role === "generic" && prop(node, "focusable") === true && Boolean(name) && children.every((child) => TEXT_ROLES.has(str(child.role?.value).toLowerCase()) || child.ignored));
    if (isControl) {
      const marks = [
        prop(node, "selected") === true ? "selected" : "",
        prop(node, "expanded") === true ? "expanded" : prop(node, "expanded") === false ? "collapsed" : "",
        pressed === "true" || pressed === true ? "pressed" : "",
        prop(node, "checked") === "true" ? "checked" : "",
      ].filter(Boolean);
      const base = (name || value || squash(str(node.description?.value)) || role).slice(0, LIMITS.controlLabelChars);
      const label = marks.length ? `${base} (${marks.join(", ")})` : base;
      if (disabled || node.backendDOMNodeId === undefined) {
        add(label);
      } else {
        controls.push({ path: [node.backendDOMNodeId], role, name: label, axName: name });
        const index = controls.length - 1;
        for (const frame of frames) frame.controls.push(index);
        // A consent notice's own buttons mark the block they're in.
        if (CONSENT_BUTTON_RE.test(name)) {
          const frame = frames.at(-1);
          if (frame) frame.consent = true;
        }
        add(`${index}${label}`);
      }
      return;
    }
    if (TEXT_ROLES.has(role)) {
      add(name || value);
      return;
    }
    if (role === "image" || role === "img") {
      if (name) add(`(image: ${name.slice(0, 80)})`);
      return;
    }
    if (role === "linebreak") {
      flush();
      return;
    }
    const modal = role === "dialog" || role === "alertdialog" || prop(node, "modal") === true;
    const block = BLOCK_ROLES.has(role) || modal || (role === "generic" && children.length > 1);
    const cell = CELL_ROLES.has(role);
    if (block) flush();
    // The page itself isn't a notice, whatever its title says.
    const page = role === "rootwebarea" || role === "webarea" || role === "document" || role === "main";
    const frame = block ? { name, modal, consent: !page && CONSENT_RE.test(name), controls: [], firstText: "" } : null;
    if (frame) frames.push(frame);
    if (children.length === 0 && name && !TEXT_ROLES.has(role)) {
      // A named element with no text children (an icon button's label, an input's label text).
      if (onScreen(node)) add(name);
    } else {
      for (const child of children) walk(child);
    }
    if (frame) {
      frames.pop();
      // A modal with controls, or a notice with a few; a block around it that's one too reports it instead.
      const notice = frame.consent && !page && frame.controls.length <= MAX_NOTICE_CONTROLS;
      if ((frame.modal || notice) && frame.controls.length > 0 && !frames.some((outer) => outer.modal || outer.consent)) {
        dialogs.push({
          name: frame.name || frame.firstText || (frame.consent ? "cookie notice" : "dialog"),
          consent: frame.consent,
          controls: frame.controls.slice(0, MAX_DIALOG_CONTROLS),
        });
      }
    }
    if (cell) add("|");
    if (block) flush();
  };
  if (root) walk(root);
  flush();
  // A dialog inside another reported one is the same dialog.
  const kept = dialogs.filter((dialog, index) => !dialogs.some((other, j) => j !== index && dialog.controls.every((c) => other.controls.includes(c)) && (other.controls.length > dialog.controls.length || j < index)));
  return { raw: lines.join("\n"), controls, fields, dialogs: kept };
}

/** A consent notice has a few controls; a block with more is the page. */
const MAX_NOTICE_CONTROLS = 12;
/** How many of a dialog's controls the note names. */
const MAX_DIALOG_CONTROLS = 6;

/** Chrome's key names and codes for an act key. */
const KEY_DEFS: Record<ActKey, { key: string; code: string; vk: number; text?: string; modifiers?: number }> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  "ctrl+a": { key: "a", code: "KeyA", vk: 65, modifiers: 2 },
  "ctrl+z": { key: "z", code: "KeyZ", vk: 90, modifiers: 2 },
  "ctrl+f": { key: "f", code: "KeyF", vk: 70, modifiers: 2 },
};

const BUTTON_MASKS: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

/**
 * Runs in every page before its scripts: alert, confirm and prompt don't open windows (see `disableDialogs`),
 * so this records them for Kiki's notes. confirm answers no and prompt answers nothing: nobody approved them.
 */
const DIALOG_SHIM = `(() => {
  const record = (type, message) => { (window.__kikiDialogs ||= []).push({ type, message: String(message ?? "") }); };
  window.alert = (message) => { record("alert", message); };
  window.confirm = (message) => { record("confirm", message); return false; };
  window.prompt = (message) => { record("prompt", message); return null; };
})();`;

/**
 * Runs in every page before its scripts: notes when the page last changed (nodes or text added, removed or
 * edited; not styles, so animations don't count), so `waitReady` can tell a page that's still changing from
 * one that's done. The page can't replace it.
 */
const SENTINEL = `(() => {
  if (window.__kiki) return;
  const state = { last: performance.now(), count: 0 };
  Object.defineProperty(window, "__kiki", { value: state, writable: false, configurable: false });
  new MutationObserver((records) => { state.last = performance.now(); state.count += records.length; })
    .observe(document, { subtree: true, childList: true, characterData: true });
})();`;
const SENTINEL_READ = "window.__kiki ? { last: window.__kiki.last, count: window.__kiki.count, now: performance.now() } : null";

/**
 * Whether something else takes a click at (x, y) meant for this element; runs in the page on the element.
 * Null when the click reaches the element (or a label or link around it, which passes it on); otherwise what's
 * in the way: its text, whether it's a control, and the dialog it's in.
 */
const COVER_CHECK = `function (x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el || el === this || this.contains(el)) return null;
  if (el.contains(this) && el.closest("label, a, button, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option]")) return null;
  const control = el.closest("a, button, input, summary, [role=button], [role=link], [role=menuitem], [role=tab], [role=option]");
  const text = (node) => (node.getAttribute("aria-label") || node.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  const dialog = el.closest("dialog, [role=dialog], [role=alertdialog], [aria-modal=true]");
  return { text: text(control || el), control: Boolean(control), dialog: dialog ? text(dialog) : null };
}`;

/** What `COVER_CHECK` found in the way of a click. */
interface Cover {
  text: string;
  control: boolean;
  dialog: string | null;
}

/** Scrolls what's under the middle of the viewport by `share` of its height; runs in the page. True when it moved. */
const SCROLL_BY_SCRIPT = `(function (share) {
  const scrollable = (el) => el && el !== document.body && el !== document.documentElement
    && /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1;
  let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  while (el && !scrollable(el)) el = el.parentElement;
  const target = el || document.scrollingElement || document.documentElement;
  const before = target.scrollTop;
  target.scrollBy({ top: Math.round(share * (el ? el.clientHeight : innerHeight)), left: 0, behavior: "instant" });
  return target.scrollTop !== before;
})`;

/** Finds `words` in the page's text and scrolls them into view; runs in the page. */
const SCROLL_TO_SCRIPT = `(function (wanted) {
  wanted = wanted.replace(/\\s+/g, " ").trim().toLowerCase();
  if (!wanted) return false;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue || !node.nodeValue.replace(/\\s+/g, " ").toLowerCase().includes(wanted)) continue;
    const el = node.parentElement;
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    el.scrollIntoView({ block: "center" });
    return true;
  }
  return false;
})`;

/** Whether `words` are in the page's text now; runs in the page. */
const HAS_TEXT_SCRIPT = `(function (wanted) {
  wanted = wanted.replace(/\\s+/g, " ").trim().toLowerCase();
  return Boolean(wanted) && (document.body?.innerText ?? "").replace(/\\s+/g, " ").toLowerCase().includes(wanted);
})`;

/** Where an action took the page: to a new page, the same page updated in place (a route change), or nowhere. */
export type Navigated = "none" | "page" | "in-page";

/** What `waitReady` found: where the action took the page, and whether the page was done when the wait ended. */
export interface Readiness {
  navigated: Navigated;
  url: string;
  /** The page hadn't finished loading when the wait gave up on it: what's read may be incomplete. */
  loading: boolean;
  /** Nothing in the page changed for a moment before the wait ended (otherwise two reads must agree). */
  quiet: boolean;
  waitedMs: number;
}

/** What Chrome has said about a page's current document: its lifecycle, and the requests still on their way. */
interface PageLife {
  mainFrame?: string;
  loaderId?: string;
  /** When the current document's lifecycle began (its "init"); 0 before any. */
  initAt: number;
  /** When each lifecycle event came for it (DOMContentLoaded, load…). */
  events: Map<string, number>;
  /** Requests for documents, scripts, styles and data (fetch, XHR) not finished yet, by when they started. */
  pending: Map<string, number>;
}

/** Thrown when the element a click or fill is for isn't in the document anymore. */
class ElementGone extends Error {
  constructor() {
    super("the element isn't on the page anymore");
  }
}

/** Whether a DevTools error says the node is gone (as opposed to having no box). */
function isGone(error: unknown): boolean {
  return /node with given id|could not find node|does not belong|no node found|detached/i.test(String(error instanceof Error ? error.message : error));
}

/** What a read of the page gives Kiki. */
export interface TabRead {
  title: string;
  url: string;
  /** With ⟦b3 Name⟧ and ⟦f2 Label⟧ markers. */
  text: string;
  fields: FormField[];
  shot?: SizedScreenshot;
  /** What happened on the way: dialogs dismissed, downloads started, the person taking over. */
  notes: string[];
}

/**
 * One tab in Kiki's browser. Hidden, it's an offscreen page: a never-shown window Electron paints to bitmaps,
 * so screenshots work (a hidden ordinary window stops painting after its first frame, and a view outside any
 * window has no size). Shown, a second, visible view of the same page sits in the browser window, and reads and
 * actions go to that one, so the person sees them; hiding brings its address back to the offscreen page.
 */
export class KikiTab {
  readonly id: string;
  /** Control ids, as for a window (b1, b2…). */
  readonly state: ScreenState = newScreenState();
  /** Fields by id, every one seen in this tab's current document. */
  readonly fields = new Map<string, BrowserField>();
  readonly #fieldIds = new Map<string, string>();
  #nextField = 1;
  /** The document's number in this tab: controls and fields read in an earlier document are stale. */
  epoch = 0;
  /** Survives the answer (the model called browser{keep}). */
  keep = false;
  /** The person clicked or typed in the page while Kiki worked in it. */
  takenOver = false;
  /** Notes for the next read. */
  notes: string[] = [];
  readonly #offscreen: BrowserWindow;
  #shown: WebContentsView | null = null;
  readonly #attached = new WeakSet<WebContents>();
  /** Pages whose history starts with the empty document `#prime` loaded, until their first page replaces it. */
  readonly #primed = new WeakSet<WebContents>();
  /** The page's lifecycle and requests, per attached page (the offscreen one, and the shown view). */
  readonly #life = new WeakMap<WebContents, PageLife>();
  /** The offscreen page's last painted frame, in case a capture ever comes back empty. */
  #lastFrame: NativeImage | null = null;
  /** When a navigation to another document last started (did-start-navigation, main frame). */
  #navStartedAt = 0;
  /** Where the page went since the last wait, if anywhere. */
  #navigation: { kind: Navigated; url: string } | null = null;
  /** When the last wait ended: what happened after it belongs to the next action. */
  #mark = 0;
  /** Dialogs noted already, so a read notes each one once per document. */
  #notedDialogs = new Set<string>();
  #injectedAt = 0;
  #acting = 0;
  /** Closed: its pages are gone, and what they still say on the way out is ignored. */
  #destroyed = false;
  readonly #browser: KikiBrowser;
  readonly #session: Session;

  constructor(browser: KikiBrowser, ses: Session, id: string) {
    this.#browser = browser;
    this.#session = ses;
    this.id = id;
    this.#offscreen = new BrowserWindow({
      width: WINDOW_SIZE.width,
      height: WINDOW_SIZE.height - TOOLBAR_HEIGHT,
      show: false,
      webPreferences: { ...this.#webPreferences(), offscreen: true },
    });
    const wc = this.#offscreen.webContents;
    // How often the offscreen page paints when nothing asks for a frame; screenshots ask for one.
    wc.setFrameRate(OFFSCREEN_FPS);
    wc.on("paint", (_event, _dirty, image) => {
      if (!image.isEmpty()) this.#lastFrame = image;
    });
    this.#wire(wc, true);
  }

  #webPreferences(): Electron.WebPreferences {
    return {
      session: this.#session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      // No native alert/confirm/prompt windows: a dialog parented to a hidden window kills the Wayland
      // connection (an exported surface without a role). Pages' dialogs are recorded by DIALOG_SHIM instead.
      disableDialogs: true,
    };
  }

  /** The visible view of this page, for the browser window. */
  #createShown(): WebContentsView {
    const view = new WebContentsView({ webPreferences: this.#webPreferences() });
    this.#wire(view.webContents, false);
    return view;
  }

  /** What every page of this tab does: no other windows, web pages only, and what Kiki watches. */
  #wire(wc: WebContents, offscreen: boolean): void {
    wc.setAudioMuted(true);
    // A page's "leave this page?" prompt would need a dialog too: leaving is fine.
    wc.on("will-prevent-unload", (event) => event.preventDefault());
    // Web pages only, plus local files while a local file is open (the harness).
    const allowed = (url: string) => /^https?:/i.test(url) || (/^file:/i.test(url) && /^file:/i.test(wc.getURL()));
    // Popups open in this tab, once the opener's call has returned; nothing opens another window.
    wc.setWindowOpenHandler(({ url }) => {
      if (allowed(url)) {
        this.notes.push("A link tried to open a new window; Kiki opened it in this tab instead.");
        setTimeout(() => void wc.loadURL(url).catch(() => {}), 0);
      }
      return { action: "deny" };
    });
    wc.on("will-navigate", (event, url) => {
      if (!allowed(url)) event.preventDefault();
    });
    // Only the page Kiki reads and acts on counts (the other one reloads when the browser shows or hides), and
    // nothing a page says while it's being closed.
    const active = () => !this.#destroyed && !wc.isDestroyed() && wc === this.webContents;
    wc.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument && active()) this.#navStartedAt = Date.now();
    });
    // Where the page went, for the next wait: a new document (its ids are new), or the same one updated in place.
    wc.on("did-navigate", (_event, url) => {
      if (!active()) return;
      this.epoch++;
      this.#navigation = { kind: "page", url };
      this.#leaveDocument();
    });
    wc.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame && active() && this.#navigation?.kind !== "page") this.#navigation = { kind: "in-page", url };
    });
    wc.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      // -3 is ERR_ABORTED: a download, or a navigation the page replaced with another.
      if (isMainFrame && code !== -3 && active()) this.notes.push(`The page failed to load (${description || `error ${code}`}).`);
    });
    wc.on("render-process-gone", (_event, details) => {
      if (active()) this.notes.push(`The page crashed (${details.reason}): browser{reload} loads it again.`);
    });
    const toolbar = () => {
      if (!this.#destroyed) this.#browser.refreshToolbar();
    };
    wc.on("page-title-updated", toolbar);
    wc.on("did-navigate", toolbar);
    wc.on("did-navigate-in-page", toolbar);
    // The person took over: a click or key of theirs while Kiki works in a shown page stops Kiki's actions.
    wc.on("input-event", (_event, input) => {
      if (offscreen || this.#acting === 0 || this.#destroyed) return;
      if (Date.now() - this.#injectedAt < INJECT_GRACE_MS) return;
      if (input.type === "mouseDown" || input.type === "keyDown") {
        this.takenOver = true;
        this.#browser.refreshToolbar();
      }
    });
  }

  /** A new document: the fields read in the old one are gone (their ids aren't reused), and its dialogs with them. */
  #leaveDocument(): void {
    this.fields.clear();
    this.#fieldIds.clear();
    this.#notedDialogs.clear();
  }

  /** The page Kiki reads and acts on: the visible one while the browser shows, else the offscreen one. */
  get webContents(): WebContents {
    return this.#shown?.webContents ?? this.#offscreen.webContents;
  }

  /** The visible view, while the browser shows. */
  get shownView(): WebContentsView | null {
    return this.#shown;
  }

  /** Puts a visible view of this page into the browser window. */
  async show(window: BrowserWindow): Promise<void> {
    if (this.#shown) return;
    const view = this.#createShown();
    this.#shown = view;
    window.contentView.addChildView(view);
    const url = this.#offscreen.webContents.getURL();
    if (url) {
      await this.#prime(view.webContents);
      await view.webContents.loadURL(url).catch(() => {});
      this.#forgetPrime(view.webContents);
    }
    this.takenOver = false;
  }

  /** Takes the visible view away; the offscreen page goes where it was. */
  hide(window: BrowserWindow | null): void {
    const shown = this.#shown;
    if (!shown) return;
    this.#shown = null;
    const url = shown.webContents.getURL();
    if (url && url !== this.#offscreen.webContents.getURL()) void this.#offscreen.webContents.loadURL(url).catch(() => {});
    if (window && !window.isDestroyed()) window.contentView.removeChildView(shown);
    shown.webContents.close();
    this.takenOver = false;
  }

  get url(): string {
    return this.webContents.getURL();
  }

  get title(): string {
    return this.webContents.getTitle();
  }

  /**
   * Gets a page ready for its first document: attached, so the document gets the shim and the sentinel. A page
   * that has never loaded anything has no renderer yet, and the protocol never answers there, so an empty
   * document goes first.
   */
  async #prime(wc: WebContents): Promise<void> {
    if (this.#attached.has(wc)) return;
    if (!wc.getURL()) {
      await wc.loadURL("about:blank").catch(() => {});
      this.#primed.add(wc);
    }
    await this.#attach(wc).catch(() => {});
  }

  /** Once a primed page's first page is in, going back doesn't lead to the empty document. */
  #forgetPrime(wc: WebContents): void {
    if (!this.#primed.delete(wc) || wc.isDestroyed()) return;
    try {
      wc.navigationHistory.clear();
    } catch {
      // Nothing to forget.
    }
  }

  /**
   * Attaches the DevTools protocol to `wc` once, with what every page of this tab gets: the page's lifecycle
   * and requests, dialogs recorded instead of shown, file choosers intercepted, and the sentinel.
   */
  async #attach(wc: WebContents): Promise<void> {
    if (this.#attached.has(wc)) return;
    wc.debugger.attach("1.3");
    this.#attached.add(wc);
    const life: PageLife = { initAt: 0, events: new Map(), pending: new Map() };
    this.#life.set(wc, life);
    wc.debugger.on("detach", () => this.#attached.delete(wc));
    wc.debugger.on("message", (_event, event, params) => this.#onEvent(life, event, params as Record<string, unknown>));
    await wc.debugger.sendCommand("Page.enable");
    const quiet = (method: string, params?: Record<string, unknown>) => wc.debugger.sendCommand(method, params).catch(() => undefined);
    const tree = (await quiet("Page.getFrameTree")) as { frameTree?: { frame?: { id?: string } } } | undefined;
    life.mainFrame = tree?.frameTree?.frame?.id;
    await Promise.all([
      quiet("Page.setLifecycleEventsEnabled", { enabled: true }),
      quiet("Network.enable"),
      quiet("Emulation.setFocusEmulationEnabled", { enabled: true }),
      quiet("Page.setInterceptFileChooserDialog", { enabled: true }),
      quiet("Page.addScriptToEvaluateOnNewDocument", { source: DIALOG_SHIM }),
      quiet("Page.addScriptToEvaluateOnNewDocument", { source: SENTINEL }),
      // The page that's already loaded, if any, gets them too.
      quiet("Runtime.evaluate", { expression: `${DIALOG_SHIM}\n${SENTINEL}` }),
    ]);
  }

  /** The DevTools protocol, attached on first use (to each view). */
  async #cdp<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    const wc = this.webContents;
    await this.#attach(wc);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`the page didn't answer in time (${method})`)), CDP_TIMEOUT_MS);
    });
    try {
      return (await Promise.race([wc.debugger.sendCommand(method, params), timeout])) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The dialogs the page tried to show since the last read (see DIALOG_SHIM), as notes. */
  async #takeDialogs(): Promise<void> {
    const result = await this.#cdp<{ result: { value?: unknown } }>("Runtime.evaluate", {
      expression: "(() => { const d = window.__kikiDialogs; window.__kikiDialogs = []; return Array.isArray(d) ? d : []; })()",
      returnByValue: true,
    }).catch((): { result: { value?: unknown } } => ({ result: {} }));
    const dialogs = Array.isArray(result.result.value) ? (result.result.value as Array<{ type?: string; message?: string }>) : [];
    for (const dialog of dialogs.slice(0, 5)) {
      const type = String(dialog.type ?? "dialog");
      const message = String(dialog.message ?? "").slice(0, 200);
      const what = type === "alert" ? "dismissed" : "declined";
      this.notes.push(`The page showed a ${type} dialog${message ? ` (“${message}”)` : ""}; Kiki ${what} it.`);
    }
  }

  #onEvent(life: PageLife, event: string, params: Record<string, unknown>): void {
    if (event === "Page.lifecycleEvent") {
      const { frameId, loaderId, name } = params as { frameId?: string; loaderId?: string; name?: string };
      if (life.mainFrame && frameId !== life.mainFrame) return;
      if (name === "init") {
        // A new document: its events start over, and the old document's requests don't matter anymore.
        life.loaderId = loaderId;
        life.initAt = Date.now();
        life.events = new Map();
        life.pending.clear();
      } else if (name && (!life.loaderId || loaderId === life.loaderId)) {
        life.events.set(name, Date.now());
      }
    } else if (event === "Network.requestWillBeSent") {
      const { requestId, type, frameId } = params as { requestId?: string; type?: string; frameId?: string };
      const ours = !life.mainFrame || !frameId || frameId === life.mainFrame;
      if (requestId && ours && TRACKED_REQUESTS.has(type ?? "")) life.pending.set(requestId, Date.now());
    } else if (event === "Network.loadingFinished" || event === "Network.loadingFailed" || event === "Network.requestServedFromCache") {
      life.pending.delete(String(params["requestId"]));
    } else if (event === "Page.javascriptDialogOpening") {
      const type = String(params["type"] ?? "dialog");
      const message = String(params["message"] ?? "").slice(0, 200);
      // Alerts and leave-page prompts are waved through; confirms and prompts are declined: nobody approved them.
      const accept = type === "alert" || type === "beforeunload";
      void this.#cdp("Page.handleJavaScriptDialog", { accept, ...(type === "prompt" ? { promptText: "" } : {}) }).catch(() => {});
      this.notes.push(`The page showed a ${type} dialog${message ? ` (“${message}”)` : ""}; Kiki ${accept ? "dismissed" : "declined"} it.`);
    } else if (event === "Page.fileChooserOpened") {
      this.notes.push("The page asked for a file to upload; Kiki doesn't upload files, so nothing was chosen.");
    }
  }

  /** Marks Kiki's own input, so it isn't read as the person taking over. */
  #injecting(): void {
    this.#injectedAt = Date.now();
  }

  /** Runs `work` as one of Kiki's actions in this tab: a takeover by the person stops it. */
  async act<T>(work: () => Promise<T>): Promise<T> {
    this.#acting++;
    try {
      return await work();
    } finally {
      this.#acting--;
    }
  }

  /**
   * Loads `url` and waits for the page (see `waitReady`). `loadURL` settles on the page's load event, which a
   * page waiting on a request that never answers never fires: past LOAD_MAX_MS, a page that has its content
   * (DOMContentLoaded) is read anyway, as still loading. Throws with a message for the model when it can't.
   */
  async load(url: string, signal?: AbortSignal): Promise<Readiness> {
    const wc = this.webContents;
    // Attached before the first page, so it gets the dialog shim and the sentinel too.
    await this.#prime(wc);
    const started = Date.now();
    this.#mark = started - 1;
    this.#navigation = null;
    const outcome: { done: boolean; error?: unknown } = { done: false };
    void wc.loadURL(url).then(
      () => (outcome.done = true),
      (error: unknown) => Object.assign(outcome, { done: true, error }),
    );
    while (!outcome.done && !signal?.aborted) {
      const life = this.#life.get(wc);
      const content = Boolean(life && life.initAt >= started && life.events.has("DOMContentLoaded"));
      if (content && Date.now() - started >= LOAD_MAX_MS) break;
      if (Date.now() - started >= LOAD_TIMEOUT_MS) throw new Error(`Kiki couldn't open ${url}: the page took too long to load`);
      await sleep(POLL_MS);
    }
    if (outcome.error !== undefined) {
      const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      // A download or a redirect the page handled itself; the page may still be fine.
      if (!/ERR_ABORTED/.test(message)) throw new Error(`Kiki couldn't open ${url}: ${message.replace(/^Error invoking remote method.*?: /, "")}`);
    }
    this.#forgetPrime(wc);
    if (signal?.aborted) return { navigated: "page", url: this.url, loading: false, quiet: false, waitedMs: 0 };
    return this.waitReady({ expectNavigation: true, since: started }, signal);
  }

  /** After an action: waits for the page (see `waitReady`). True when the action led to another page. */
  async settle(signal?: AbortSignal): Promise<boolean> {
    return (await this.waitReady({}, signal)).navigated === "page";
  }

  /**
   * How long ago the page last changed and how many requests it's waiting on, "gone" while another document
   * is taking over, or null when the page can't say (no sentinel: a page that was loaded before Kiki attached).
   */
  async #stillness(): Promise<{ quietFor: number; pending: number } | "gone" | null> {
    const life = this.#life.get(this.webContents);
    try {
      const { result } = await this.#cdp<{ result: { value?: { last?: number; now?: number } | null } }>("Runtime.evaluate", {
        expression: SENTINEL_READ,
        returnByValue: true,
      });
      const value = result.value;
      if (!value || typeof value.last !== "number" || typeof value.now !== "number") return null;
      const now = Date.now();
      const pending = [...(life?.pending.values() ?? [])].filter((at) => now - at < STALE_REQUEST_MS).length;
      return { quietFor: value.now - value.last, pending };
    } catch (error) {
      return /context|destroyed|cannot find/i.test(String(error instanceof Error ? error.message : error)) ? "gone" : null;
    }
  }

  /**
   * Waits for the page to be ready to read after an action (or a load). An action may start a navigation:
   * that gets a moment to begin (`budgetMs`, less when the page goes quiet first). A new page is waited for
   * until its load event, then until nothing it asked for is still on its way and nothing in it changes for a
   * moment; every wait is capped, and `loading` says when the page wasn't done by then. A page that didn't
   * go anywhere is read as soon as it's quiet. `expectNavigation`: a load, so the detection is skipped.
   * `since`: when the action began, when that was before the wait (a load), for the caps.
   */
  async waitReady(options: { expectNavigation?: boolean; budgetMs?: number; since?: number } = {}, signal?: AbortSignal): Promise<Readiness> {
    const started = options.since ?? Date.now();
    const wc = this.webContents;
    const mark = this.#mark;
    const life = () => this.#life.get(this.webContents);
    const newDocument = () => (life()?.initAt ?? 0) > mark;
    /** A navigation to another document has started (or finished) since the last wait. */
    const navigating = () => this.#navStartedAt > mark || this.#navigation?.kind === "page" || wc.isLoading() || newDocument();
    const stop = () => signal?.aborted === true;
    let quiet = false;
    let loading = false;

    // A change in place, or the start of a navigation.
    if (!options.expectNavigation) {
      const until = started + (options.budgetMs ?? NAV_DETECT_MS);
      while (!stop() && !navigating()) {
        const still = await this.#stillness();
        if (still === "gone") break;
        if (still && still.quietFor >= QUIET_MS && still.pending === 0 && Date.now() - started >= QUIET_MS) {
          quiet = true;
          break;
        }
        if (Date.now() >= until) break;
        await sleep(POLL_MS);
      }
    }

    if (!quiet && (options.expectNavigation || navigating())) {
      // The new page's load event (or the end of loading, for a page without lifecycle events).
      const loadUntil = started + LOAD_MAX_MS;
      while (!stop()) {
        const current = life();
        const loaded = newDocument() && Boolean(current?.events.has("load"));
        if (loaded || (!wc.isLoading() && (newDocument() || !current))) break;
        // Nothing arrived: the navigation didn't happen (aborted, a download), so the page is as it was.
        if (!wc.isLoading() && !newDocument() && Date.now() - started >= NAV_DETECT_MS) break;
        if (Date.now() >= loadUntil) {
          loading = true;
          break;
        }
        await sleep(POLL_MS);
      }
    }

    // Then for the page to stop changing: nothing it asked for still on its way, and nothing in it changing.
    // A new page gets longer, for what it asks for right after loading.
    if (!quiet && !stop()) {
      const until = Math.max(Date.now() + QUIET_MS * 2, navigating() ? Date.now() + AFTER_LOAD_MAX_MS : started + QUIET_MAX_MS);
      while (!stop()) {
        const still = await this.#stillness();
        if (still === null) break;
        if (still !== "gone" && still.quietFor >= QUIET_MS && still.pending === 0) {
          quiet = true;
          break;
        }
        if (Date.now() >= until) break;
        await sleep(POLL_MS);
      }
    }

    if (wc.isLoading() && !stop()) loading = true;
    const navigated = this.#navigation?.kind ?? (newDocument() ? "page" : "none");
    this.#navigation = null;
    this.#mark = Date.now();
    return { navigated, url: this.url, loading, quiet, waitedMs: Date.now() - started };
  }

  /**
   * The page as Kiki reads it now. `quiet`: the page had stopped changing (see `waitReady`), so one read is
   * enough; otherwise reads repeat until two agree.
   */
  async read(options: { screenshot?: boolean; quiet?: boolean } = {}, signal?: AbortSignal): Promise<TabRead> {
    let read = await this.#readOnce();
    if (!options.quiet) {
      for (let attempt = 0; attempt < 2 && !signal?.aborted; attempt++) {
        await sleep(READ_AGREE_MS);
        const again = await this.#readOnce();
        if (again.text === read.text) break;
        read = again;
      }
    }
    const shot = options.screenshot ? await this.screenshot().catch(() => undefined) : undefined;
    const notes = this.notes.splice(0);
    if (this.takenOver) notes.push("The person took over the browser (they clicked or typed in it), so Kiki stopped acting there.");
    return { ...read, ...(shot ? { shot } : {}), notes };
  }

  async #readOnce(): Promise<Omit<TabRead, "notes">> {
    await this.#takeDialogs();
    const [{ nodes }, snapshot, metrics] = await Promise.all([
      this.#cdp<{ nodes: AXNode[] }>("Accessibility.getFullAXTree"),
      this.#cdp<DomSnapshot>("DOMSnapshot.captureSnapshot", { computedStyles: [], includeDOMRects: true }).catch(() => undefined),
      this.#metrics(),
    ]);
    const { raw, controls, fields, dialogs } = axToScreen(nodes, passwordNodes(snapshot), visibleNodes(snapshot, metrics));
    const stamped = controls.map((control) => ({ ...control, epoch: this.epoch }));
    const seen = fields.map((field) => this.#fieldId(field));
    const text = screenText(raw, stamped, this.state).replace(/(\d+)([^]*)/g, (_match, index: string, label: string) => {
      const field = seen[Number(index)];
      return field ? `⟦${field.id} ${label}⟧` : label;
    });
    const open = dialogs.map((dialog) => ({ ...dialog, controls: dialog.controls.map((index) => controlIdFor(this.state, stamped[index]!)).filter((id): id is string => Boolean(id)) }));
    // A cookie notice's own buttons may be clicked to get it out of the way.
    for (const dialog of open) {
      if (!dialog.consent) continue;
      for (const id of dialog.controls) {
        const control = this.state.controls.get(id);
        if (control && CONSENT_BUTTON_RE.test(control.axName ?? "")) control.consent = true;
      }
    }
    this.#noteDialogs(open);
    return {
      title: this.title,
      url: this.url,
      text,
      fields: seen.map(({ id, label, kind, value, checked, password }) => ({
        id,
        label: password ? `${label} (password)` : label,
        kind,
        ...(kind === "checkbox" || kind === "radio" ? { checked: Boolean(checked) } : { value: value ?? "" }),
      })),
    };
  }

  /** Notes the dialogs open on the page that haven't been noted in this document yet, with their controls. */
  #noteDialogs(dialogs: OpenDialog[]): void {
    for (const dialog of dialogs) {
      const key = `${dialog.name}|${dialog.controls.join(",")}`;
      if (this.#notedDialogs.has(key)) continue;
      this.#notedDialogs.add(key);
      const controls = dialog.controls.map((id) => `⟦${id} ${this.state.controls.get(id)?.name ?? ""}⟧`).join(" ");
      this.notes.push(`A ${dialog.consent ? "cookie notice" : "dialog"} is open (“${dialog.name.slice(0, 80)}”) with ${controls}.`);
    }
  }

  /** The field's id in this tab: the same one while the element stays, in the document it was read in. */
  #fieldId(field: SeenField): BrowserField {
    const key = `${field.backendId}|${field.role}|${field.label}`;
    let id = this.#fieldIds.get(key);
    if (!id) {
      id = `f${this.#nextField++}`;
      this.#fieldIds.set(key, id);
    }
    const stored: BrowserField = { ...field, id, epoch: this.epoch };
    this.fields.set(id, stored);
    return stored;
  }

  /**
   * A screenshot of the page's viewport, with its size, or undefined when none could be taken. `capturePage`
   * works on both the shown view and the offscreen window (the offscreen window keeps painting because it
   * renders offscreen, unlike a hidden ordinary window); a paint frame stands in if a capture ever hangs.
   */
  async screenshot(): Promise<SizedScreenshot | undefined> {
    const wc = this.webContents;
    const capture = wc.capturePage(undefined, { stayHidden: true, stayAwake: false });
    const late = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), CDP_TIMEOUT_MS));
    let image = await Promise.race([capture, late]).catch(() => undefined);
    if ((!image || image.isEmpty()) && !this.#shown) image = this.#lastFrame ?? undefined;
    return !image || image.isEmpty() ? undefined : sizedScreenshot(image);
  }

  /** The viewport in CSS pixels and how far the document is scrolled, from the page itself. */
  async #metrics(): Promise<{ width: number; height: number; scrollX: number; scrollY: number }> {
    const result = await this.#cdp<{ result: { value?: unknown } }>("Runtime.evaluate", {
      expression: "({ width: innerWidth, height: innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) })",
      returnByValue: true,
    }).catch((): { result: { value?: unknown } } => ({ result: {} }));
    const value = (result.result.value ?? {}) as Partial<Record<"width" | "height" | "scrollX" | "scrollY", number>>;
    const [width = 1, height = 1] = this.#shown ? [this.#shown.getBounds().width, this.#shown.getBounds().height] : this.#offscreen.getContentSize();
    return {
      width: value.width && value.width > 0 ? value.width : Math.max(1, width),
      height: value.height && value.height > 0 ? value.height : Math.max(1, height),
      scrollX: value.scrollX ?? 0,
      scrollY: value.scrollY ?? 0,
    };
  }

  /** The viewport in CSS pixels. */
  async #viewport(): Promise<{ width: number; height: number }> {
    const { width, height } = await this.#metrics();
    return { width, height };
  }

  async #mouse(point: ScreenPoint, button: MouseButton = "left", count = 1): Promise<void> {
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    this.#injecting();
    await this.#cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    for (let click = 1; click <= count; click++) {
      this.#injecting();
      await this.#cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: BUTTON_MASKS[button], clickCount: click });
      await sleep(30);
      this.#injecting();
      await this.#cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: click });
      if (click < count) await sleep(60);
    }
  }

  /** The element's first box (x1 y1 x2 y2 x3 y3 x4 y4), or null when it has none. Throws ElementGone. */
  async #quad(backendNodeId: number): Promise<number[] | null> {
    try {
      const { quads } = await this.#cdp<{ quads: number[][] }>("DOM.getContentQuads", { backendNodeId });
      return quads.find((candidate) => candidate.length >= 8) ?? null;
    } catch (error) {
      if (isGone(error)) throw new ElementGone();
      return null;
    }
  }

  /** The element's box once it has stopped moving (a menu sliding open), or null when it has none. */
  async #stableQuad(backendNodeId: number): Promise<number[] | null> {
    let quad = await this.#quad(backendNodeId);
    const until = Date.now() + STABLE_MAX_MS;
    while (quad && Date.now() < until) {
      await sleep(STABLE_MS);
      const again = await this.#quad(backendNodeId);
      if (again && again.every((coordinate, index) => Math.abs(coordinate - quad![index]!) <= 1)) return again;
      quad = again;
    }
    return quad;
  }

  /**
   * The element's JavaScript object, for calling into the page on it. Throws ElementGone when it isn't in the
   * document anymore, including one the page took out but still holds on to (a redrawn list): clicking that
   * would do nothing.
   */
  async #objectOf(backendNodeId: number): Promise<string> {
    const { object } = await this.#cdp<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId }).catch((error: unknown) => {
      if (isGone(error)) throw new ElementGone();
      return { object: {} as { objectId?: string } };
    });
    if (!object.objectId) throw new ElementGone();
    const connected = await this.#cdp<{ result: { value?: unknown } }>("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: "function () { return this.isConnected; }",
      returnByValue: true,
    }).catch(() => ({ result: { value: true } }));
    if (connected.result.value === false) throw new ElementGone();
    return object.objectId;
  }

  /** What takes a click at `point` instead of the element, or null when the element gets it. */
  async #covering(objectId: string, point: ScreenPoint): Promise<Cover | null> {
    const result = await this.#cdp<{ result: { value?: unknown } }>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: COVER_CHECK,
      arguments: [{ value: point.x }, { value: point.y }],
      returnByValue: true,
    }).catch(() => ({ result: {} as { value?: unknown } }));
    const value = result.result.value;
    return value && typeof value === "object" ? (value as Cover) : null;
  }

  /** What a read says about something in the way of a click. */
  #coverNote(cover: Cover, label: string): string {
    const known = [...this.state.controls.values()].find((control) => control.name === cover.text || control.axName === cover.text);
    const what = known ? `⟦${known.id} ${known.name}⟧` : `“${cover.text}”`;
    const where = cover.dialog ? ` in a dialog (“${cover.dialog.slice(0, 60)}”)` : "";
    return `${what}${where} was in the way of “${label}”, so Kiki clicked “${label}” through the page instead.`;
  }

  /**
   * Clicks the element with `backendNodeId`: at a point in its box once it's in view and still, where nothing
   * covers it (the centre, else a point either side); otherwise through its own click(), with a note on what
   * was in the way. Throws ElementGone when the element isn't in the document anymore.
   */
  async #clickNode(backendNodeId: number, label: string, button: MouseButton = "left", count = 1): Promise<void> {
    const objectId = await this.#objectOf(backendNodeId);
    await this.#cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch((error: unknown) => {
      if (isGone(error)) throw new ElementGone();
    });
    const quad = await this.#stableQuad(backendNodeId);
    if (quad) {
      const viewport = await this.#viewport();
      const [x1, y1, x2, y2, x3, y3, x4, y4] = quad as [number, number, number, number, number, number, number, number];
      const centre = { x: (x1 + x2 + x3 + x4) / 4, y: (y1 + y2 + y3 + y4) / 4 };
      const halfWidth = Math.max(Math.abs(x2 - x1), Math.abs(x3 - x4)) / 2;
      const points = [centre, { x: centre.x - halfWidth / 2, y: centre.y }, { x: centre.x + halfWidth / 2, y: centre.y }];
      let first: Cover | null = null;
      for (const point of points) {
        if (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height) continue;
        const cover = await this.#covering(objectId, point);
        if (!cover) {
          await this.#mouse(point, button, count);
          return;
        }
        first ??= cover;
      }
      if (first) this.notes.push(this.#coverNote(first, label));
    }
    this.#injecting();
    // As the person's click (user activation), so the page treats it as one: a link it follows stays in history.
    await this.#cdp("Runtime.callFunctionOn", { objectId, functionDeclaration: "function () { this.click(); }", userGesture: true });
  }

  /**
   * The element that says what `control` said (its role and accessible name) on the page now, or null when
   * there's none or several. The control's path moves to it.
   */
  async #findAgain(control: ControlTarget): Promise<number | null> {
    const name = control.axName ?? control.name;
    if (!name) return null;
    const same = (node: AXNode) => !node.ignored && node.backendDOMNodeId !== undefined && str(node.role?.value).toLowerCase() === (control.role ?? "") && squash(str(node.name?.value)) === name;
    let found: AXNode[];
    try {
      const { nodes } = await this.#cdp<{ nodes: AXNode[] }>("Accessibility.queryAXTree", { accessibleName: name });
      found = nodes.filter(same);
    } catch {
      const { nodes } = await this.#cdp<{ nodes: AXNode[] }>("Accessibility.getFullAXTree");
      found = nodes.filter(same);
    }
    let node = found.length === 1 ? found[0] : undefined;
    if (found.length > 1) {
      // Several say the same: the one on screen, when only one is.
      const viewport = await this.#viewport();
      const onScreen: AXNode[] = [];
      for (const candidate of found) {
        const quad = await this.#quad(candidate.backendDOMNodeId!).catch(() => null);
        if (quad && quad[0]! >= 0 && quad[1]! >= 0 && quad[0]! <= viewport.width && quad[1]! <= viewport.height) onScreen.push(candidate);
      }
      node = onScreen.length === 1 ? onScreen[0] : undefined;
    }
    if (!node?.backendDOMNodeId) return null;
    control.path = [node.backendDOMNodeId];
    control.epoch = this.epoch;
    return node.backendDOMNodeId;
  }

  /**
   * Clicks a control by its id (from a read). A control the page has redrawn, or one read on an earlier
   * document of the same page, is found again by what it says. Returns an error for the model, or null.
   */
  async click(controlId: string): Promise<string | null> {
    const control = this.state.controls.get(controlId);
    if (!control) return `${controlId || "That"} isn't one of the controls on the page: use the ids in the latest <visible_text>.`;
    let backendNodeId = control.path[0];
    if (backendNodeId === undefined) return `${controlId} can't be clicked.`;
    const label = control.name;
    try {
      if (control.epoch !== undefined && control.epoch !== this.epoch) {
        // Read on an earlier document: the same control on this one, if it's here.
        const found = await this.#findAgain(control);
        if (found === null) return `${controlId} (${label}) was on the page before this one, and this page has no “${label}”: use the ids in the latest <visible_text>.`;
        backendNodeId = found;
      }
      try {
        await this.#clickNode(backendNodeId, label);
      } catch (error) {
        if (!(error instanceof ElementGone)) throw error;
        // The page redrew it: the element that says the same now.
        const found = await this.#findAgain(control);
        if (found === null) throw error;
        await this.#clickNode(found, label);
        this.notes.push(`${controlId} had been redrawn; Kiki found “${label}” again and clicked that.`);
      }
      return null;
    } catch (error) {
      return `Kiki couldn't click ${controlId} (${label}): ${error instanceof Error ? error.message : String(error)}.`;
    }
  }

  /**
   * Puts `value` in a field by its id: text replaces what's there, true/false checks or unchecks, and a
   * drop-down picks the option that says so. Password fields are refused. Returns an error, or null.
   */
  async setField(fieldId: string, value: string | boolean, options: { approved?: boolean } = {}): Promise<string | null> {
    const field = this.fields.get(fieldId);
    if (!field) return `${fieldId || "That"} isn't one of the fields on the page now: use the ids in the latest <form_fields>.`;
    if (field.password && !options.approved) {
      return `${fieldId} (${field.label}) is a password field: Kiki doesn't type passwords on its own. Ask the person to type it (browser{show}), or put it on a propose_fill card.`;
    }
    try {
      if (field.kind === "checkbox" || field.kind === "radio") {
        if (typeof value !== "boolean") return `${fieldId} is a ${field.kind}: use true or false.`;
        const read = await this.#fieldChecked(field.backendId);
        if (read !== value) await this.#clickNode(field.backendId, field.label);
        return null;
      }
      if (typeof value !== "string") return `${fieldId} is a text field: give it text.`;
      if (field.select) {
        const picked = await this.#pickOption(field.backendId, value);
        return picked ? null : `${fieldId} has no option that says “${value}”.`;
      }
      const objectId = await this.#objectOf(field.backendId);
      await this.#cdp("DOM.focus", { backendNodeId: field.backendId });
      await this.#cdp("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration:
          "function () { if (typeof this.select === 'function') { this.select(); return; } const range = document.createRange(); range.selectNodeContents(this); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }",
      });
      this.#injecting();
      if (value === "") await this.key("delete");
      else await this.#cdp("Input.insertText", { text: value });
      return null;
    } catch (error) {
      if (error instanceof ElementGone) return `${fieldId} (${field.label}) isn't on the page anymore (the page redrew it): use the ids in the latest <form_fields>.`;
      return `Kiki couldn't fill ${fieldId} (${field.label}): ${error instanceof Error ? error.message : String(error)}.`;
    }
  }

  async #fieldChecked(backendNodeId: number): Promise<boolean> {
    const objectId = await this.#objectOf(backendNodeId);
    const result = await this.#cdp<{ result: { value?: unknown } }>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function () { return Boolean(this.checked ?? this.getAttribute('aria-checked') === 'true'); }",
      returnByValue: true,
    });
    return result.result.value === true;
  }

  async #pickOption(backendNodeId: number, text: string): Promise<boolean> {
    const objectId = await this.#objectOf(backendNodeId);
    const result = await this.#cdp<{ result: { value?: unknown } }>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function (wanted) {
        const options = [...(this.options ?? [])];
        const norm = (s) => String(s).replace(/\\s+/g, ' ').trim().toLowerCase();
        const option = options.find((o) => norm(o.textContent) === norm(wanted) || norm(o.value) === norm(wanted))
          ?? options.find((o) => norm(o.textContent).includes(norm(wanted)));
        if (!option) return false;
        this.value = option.value;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }`,
      arguments: [{ value: text }],
      returnByValue: true,
      userGesture: true,
    });
    return result.result.value === true;
  }

  /** Presses one key (or shortcut) in the page. */
  async key(key: ActKey): Promise<void> {
    const def = KEY_DEFS[key];
    const common = { key: def.key, code: def.code, windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk, modifiers: def.modifiers ?? 0 };
    this.#injecting();
    await this.#cdp("Input.dispatchKeyEvent", { type: def.text ? "keyDown" : "rawKeyDown", ...common, ...(def.text ? { text: def.text, unmodifiedText: def.text } : {}) });
    this.#injecting();
    await this.#cdp("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  }

  /**
   * Scrolls a screen (false when nothing moved: the end), or to text on the page (false when it isn't there).
   * The page scrolls itself (a wheel event to a hidden page is never acknowledged).
   */
  async scroll(request: ScrollRequest): Promise<boolean> {
    const expression =
      "to" in request
        ? `${SCROLL_TO_SCRIPT}(${JSON.stringify(request.to)})`
        : `${SCROLL_BY_SCRIPT}(${request.direction === "down" ? SCREEN_SHARE : -SCREEN_SHARE})`;
    const result = await this.#cdp<{ result: { value?: unknown } }>("Runtime.evaluate", { expression, returnByValue: true });
    return result.result.value === true;
  }

  /** Whether the page's text has `words` in it now (without scrolling to them). */
  async hasText(words: string): Promise<boolean> {
    const result = await this.#cdp<{ result: { value?: unknown } }>("Runtime.evaluate", {
      expression: `${HAS_TEXT_SCRIPT}(${JSON.stringify(words)})`,
      returnByValue: true,
    }).catch(() => ({ result: {} as { value?: unknown } }));
    return result.result.value === true;
  }

  /** A click at a point in the last screenshot (`size` is that screenshot's). */
  async clickAt(point: ScreenPoint, size: ScreenshotSize, button: MouseButton = "left", count = 1): Promise<void> {
    const css = await this.#cssPoint(point, size);
    await this.#mouse(css, button, count);
  }

  /** A drag between two points in the last screenshot. */
  async drag(from: ScreenPoint, to: ScreenPoint, size: ScreenshotSize): Promise<void> {
    const start = await this.#cssPoint(from, size);
    const end = await this.#cssPoint(to, size);
    this.#injecting();
    await this.#cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x, y: start.y, button: "none", buttons: 0 });
    await this.#cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: start.x, y: start.y, button: "left", buttons: 1, clickCount: 1 });
    const steps = 12;
    for (let step = 1; step <= steps; step++) {
      this.#injecting();
      await this.#cdp("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(start.x + ((end.x - start.x) * step) / steps),
        y: Math.round(start.y + ((end.y - start.y) * step) / steps),
        button: "left",
        buttons: 1,
      });
      await sleep(15);
    }
    this.#injecting();
    await this.#cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, button: "left", buttons: 0, clickCount: 1 });
  }

  async #cssPoint(point: ScreenPoint, size: ScreenshotSize): Promise<ScreenPoint> {
    const fraction = fractionOf(point, size);
    const viewport = await this.#viewport();
    return { x: Math.round(fraction.x * (viewport.width - 1)), y: Math.round(fraction.y * (viewport.height - 1)) };
  }

  back(): void {
    const history = this.webContents.navigationHistory;
    if (history.canGoBack()) history.goBack();
  }

  forward(): void {
    const history = this.webContents.navigationHistory;
    if (history.canGoForward()) history.goForward();
  }

  reload(): void {
    this.webContents.reload();
  }

  destroy(window: BrowserWindow | null): void {
    this.hide(window);
    this.#destroyed = true;
    try {
      if (this.#attached.has(this.#offscreen.webContents)) this.#offscreen.webContents.debugger.detach();
    } catch {
      // Already gone.
    }
    this.#offscreen.destroy();
  }
}

/** DOMSnapshot.captureSnapshot's shape, as far as Kiki reads it. */
interface DomSnapshot {
  documents: Array<{
    scrollOffsetX?: number;
    scrollOffsetY?: number;
    nodes: {
      backendNodeId?: number[];
      nodeName?: number[];
      attributes?: number[][];
    };
    layout?: {
      nodeIndex: number[];
      /** Document coordinates: x, y, width, height. */
      bounds: number[][];
    };
  }>;
  strings: string[];
}

/** How far outside the viewport (as a share of its height) still counts as on screen. */
const VIEWPORT_MARGIN = 0.1;

/**
 * The backend node ids laid out within the viewport (plus a margin), or undefined when the snapshot has no
 * layout: then everything counts as on screen. Bounds are document coordinates; the scroll comes from the page.
 */
export function visibleNodes(
  snapshot: DomSnapshot | undefined,
  viewport: { width: number; height: number; scrollX?: number; scrollY?: number },
): Set<number> | undefined {
  const document = snapshot?.documents[0];
  if (!document?.layout) return undefined;
  const top = viewport.scrollY ?? document.scrollOffsetY ?? 0;
  const left = viewport.scrollX ?? document.scrollOffsetX ?? 0;
  const margin = viewport.height * VIEWPORT_MARGIN;
  const ids = document.nodes.backendNodeId ?? [];
  const visible = new Set<number>();
  document.layout.nodeIndex.forEach((nodeIndex, index) => {
    const bounds = document.layout!.bounds[index];
    if (!bounds || bounds.length < 4) return;
    const [x, y, width, height] = bounds as [number, number, number, number];
    const inside = y + height >= top - margin && y <= top + viewport.height + margin && x + width >= left && x <= left + viewport.width;
    const id = ids[nodeIndex];
    if (inside && id !== undefined) visible.add(id);
  });
  return visible;
}

/** The backend node ids of password inputs. */
export function passwordNodes(snapshot: DomSnapshot | undefined): Set<number> {
  const found = new Set<number>();
  if (!snapshot) return found;
  const { strings } = snapshot;
  for (const document of snapshot.documents) {
    const { backendNodeId = [], nodeName = [], attributes = [] } = document.nodes;
    for (let index = 0; index < backendNodeId.length; index++) {
      if (strings[nodeName[index] ?? -1]?.toUpperCase() !== "INPUT") continue;
      const pairs = attributes[index] ?? [];
      for (let pair = 0; pair + 1 < pairs.length; pair += 2) {
        if (strings[pairs[pair]!]?.toLowerCase() === "type" && strings[pairs[pair + 1]!]?.toLowerCase() === "password") {
          found.add(backendNodeId[index]!);
        }
      }
    }
  }
  return found;
}

/** Kiki's browser: its window (shown only on request) and tabs. One per Kiki. */
export class KikiBrowser {
  #window: BrowserWindow | null = null;
  readonly tabs: KikiTab[] = [];
  current: KikiTab | null = null;
  visible = false;
  #nextId = 1;
  #session: Session | null = null;
  /** Runs when the person presses Stop in the browser's toolbar. */
  onStop: (() => void) | null = null;

  #ses(): Session {
    if (this.#session) return this.#session;
    const ses = session.fromPartition(PARTITION);
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    // Sites see a browser, not an Electron app.
    ses.setUserAgent(app.userAgentFallback.replace(/\s?(kiki[\w-]*|Electron)\/\S+/gi, ""));
    ses.on("will-download", (_event, item) => {
      const downloads = app.getPath("downloads");
      let name = item.getFilename() || "download";
      let path = join(downloads, name);
      for (let n = 2; existsSync(path); n++) {
        const dot = name.lastIndexOf(".");
        const next = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
        path = join(downloads, next);
        if (!existsSync(path)) name = next;
      }
      item.setSavePath(path);
      this.current?.notes.push(`A download started: “${name}” is going to the Downloads folder.`);
    });
    this.#session = ses;
    return ses;
  }

  /** The window (hidden until `show`), with the toolbar page loaded. */
  #ensureWindow(): BrowserWindow {
    if (this.#window && !this.#window.isDestroyed()) return this.#window;
    const window = new BrowserWindow({
      ...WINDOW_SIZE,
      title: "Kiki's browser",
      show: false,
      autoHideMenuBar: true,
      ...(process.platform === "linux" ? { icon: join(app.getAppPath(), "resources", "icon.png") } : {}),
      webPreferences: { preload: preloadPath(), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    loadPage(window, "browser");
    // Closing the window hides it; the pages stay until the answer is done (or they're kept).
    window.on("close", (event) => {
      if (this.tabs.length > 0) {
        event.preventDefault();
        this.hide();
      }
    });
    window.on("closed", () => (this.#window = null));
    window.on("resize", () => this.#layout());
    window.webContents.on("did-finish-load", () => this.refreshToolbar());
    this.#window = window;
    return window;
  }

  /**
   * Opens `url` in the current tab (or a new one), and waits for it: the tab, and how ready the page was.
   * Throws with a message for the model.
   */
  async open(url: string, options: { newTab?: boolean } = {}, signal?: AbortSignal): Promise<{ tab: KikiTab; ready: Readiness }> {
    let tab = this.current;
    if (!tab || options.newTab) {
      if (this.tabs.length >= MAX_TABS) throw new Error(`Kiki keeps at most ${MAX_TABS} pages open: close one first (browser{close}).`);
      tab = new KikiTab(this, this.#ses(), `t${this.#nextId++}`);
      this.tabs.push(tab);
    }
    await this.select(tab);
    const ready = await tab.load(url, signal);
    this.refreshToolbar();
    return { tab, ready };
  }

  /** Makes `tab` the current one; while the browser shows, it's the one in the window. */
  async select(tab: KikiTab): Promise<void> {
    this.current = tab;
    if (this.visible) {
      const window = this.#ensureWindow();
      for (const other of this.tabs) if (other !== tab) other.hide(window);
      await tab.show(window);
      this.#layout();
    }
    this.refreshToolbar();
  }

  #layout(): void {
    const window = this.#window;
    if (!window || window.isDestroyed()) return;
    const [width, height] = window.getContentSize();
    for (const tab of this.tabs) {
      tab.shownView?.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: Math.max(1, width ?? 1), height: Math.max(1, (height ?? 1) - TOOLBAR_HEIGHT) });
    }
  }

  /** Puts the browser window in front of the person, with the current page in it. */
  async show(): Promise<void> {
    const window = this.#ensureWindow();
    this.visible = true;
    if (this.current) await this.current.show(window);
    this.#layout();
    if (!window.isVisible()) window.show();
    window.focus();
    this.refreshToolbar();
  }

  hide(): void {
    this.visible = false;
    const window = this.#window && !this.#window.isDestroyed() ? this.#window : null;
    if (window?.isVisible()) window.hide();
    for (const tab of this.tabs) tab.hide(window);
  }

  closeTab(tab: KikiTab): void {
    const index = this.tabs.indexOf(tab);
    if (index >= 0) this.tabs.splice(index, 1);
    tab.destroy(this.#window && !this.#window.isDestroyed() ? this.#window : null);
    if (this.current === tab) {
      this.current = this.tabs.at(-1) ?? null;
      if (this.current) void this.select(this.current);
    }
    if (this.tabs.length === 0) {
      this.visible = false;
      this.#window?.destroy();
      this.#window = null;
    }
    this.refreshToolbar();
  }

  /**
   * The answer is done: pages opened for it close, unless kept, or the browser is showing (the person may be
   * looking at them). Kept pages stay for the next question.
   */
  endTurn(): void {
    if (this.visible) return;
    for (const tab of [...this.tabs]) if (!tab.keep) this.closeTab(tab);
  }

  /** The toolbar page's state. */
  refreshToolbar(): void {
    const window = this.#window;
    if (!window || window.isDestroyed() || window.webContents.isLoading()) return;
    const tab = this.current;
    const state: BrowserState = {
      url: tab?.url ?? "",
      title: tab?.title ?? "",
      kept: Boolean(tab?.keep),
      takenOver: Boolean(tab?.takenOver),
      tabs: this.tabs.length,
    };
    window.webContents.send("browser:state", state);
  }

  /** The toolbar's buttons. */
  registerIpc(): void {
    ipcMain.on("browser:stop", () => this.onStop?.());
    ipcMain.on("browser:keep", () => {
      if (this.current) this.current.keep = !this.current.keep;
      this.refreshToolbar();
    });
    ipcMain.on("browser:hide", () => this.hide());
  }
}

let browser: KikiBrowser | null = null;

/** Kiki's browser, made on first use. */
export function kikiBrowser(): KikiBrowser {
  if (!browser) {
    browser = new KikiBrowser();
    browser.registerIpc();
  }
  return browser;
}
