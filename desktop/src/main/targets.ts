// What Kiki is looking at while it answers: the window the question came from (the default), another window on
// the desktop (use_window, open_app), or a page in Kiki's own browser (open_url). The screen tools (scroll, look,
// click, act) and the press and fill cards act on the current target; this module runs them against the right
// backend: the AT-SPI helper and the GNOME extension for windows, Chrome's DevTools protocol for Kiki's browser.
import {
  LIMITS,
  type ActAction,
  type FieldValue,
  type PressTarget,
  type ProposedAction,
  type ScreenRead,
  type ScrollRequest,
  type ToolResult,
} from "@kiki/shared";
import type { ActionStatus } from "../shared-types.ts";
import { kikiBrowser, type KikiTab, type Readiness, type TabRead } from "./browser.ts";
import type { Capture } from "./capture/common.ts";
import { windowCapture } from "./capture/linux.ts";
import { fillField } from "./changes.ts";
import { launchApp, listApps, listWindows, selectSource, WINDOWS_VERSION, type ShellWindow } from "./gnomeShell.ts";
import { measure, type ScreenshotSize } from "./images.ts";
import {
  clickControl,
  clickInWindow,
  clickRefusal,
  dedupeScreen,
  diffScreen,
  keyInWindow,
  newScreenState,
  pointerInWindow,
  readScreen,
  runScreenTool,
  screenResult,
  scrollScreen,
  scrollTo,
  type ScreenAccess,
  type ScreenState,
} from "./screen.ts";
import { checkUrl } from "./urlGuard.ts";
import { plural } from "./google/format.ts";

/** Where Kiki is looking: a window (the hotkey's, or another one), or a page in Kiki's browser. */
export type Target =
  | {
      kind: "window";
      capture: Capture;
      screen: ScreenState;
      /** The window the question came from. */
      source: boolean;
      window?: ShellWindow;
      /** The last screenshot's size, for clicks at coordinates in it. */
      shot?: ScreenshotSize;
    }
  | {
      kind: "browser";
      tab: KikiTab;
      shot?: ScreenshotSize;
      /** The last text read, to tell what a scroll brought in. */
      last?: string;
    };

/** The targets of one popup session. */
export interface Targets {
  current: Target;
  /** The window the question came from. */
  source: Extract<Target, { kind: "window" }>;
  /** Windows by the ids the model saw ("w2"), by the extension's window id. */
  windows: Map<string, ShellWindow>;
}

/** What the session hands the target tools. */
export interface TargetContext {
  targets: Targets;
  look: ScreenAccess;
  /** The person's question, for the address guard. */
  question: string;
  /** Kiki's GNOME extension's version, for the window tools. */
  helperVersion: number;
  /** Settings: Kiki's browser, other windows, coordinates, and acting without asking. */
  allow: { browser: boolean; windows: boolean; coordinates: boolean; autoApprove: boolean };
  signal?: AbortSignal;
  /** Tells the popup where Kiki is looking now. */
  onTarget: (target: Target) => void;
  /** Runs a window action under the "Kiki is using your computer" banner. */
  banner: <T>(work: () => Promise<T>) => Promise<T>;
}

export function newTargets(capture: Capture, screen: ScreenState): Targets {
  const source: Extract<Target, { kind: "window" }> = { kind: "window", capture, screen, source: true };
  return { current: source, source, windows: new Map() };
}

/** How the popup describes a target: "Kiki's browser: GitHub", "Window: Files — Downloads". */
export function targetLabel(target: Target): { kind: "browser" | "window"; label: string | null } {
  if (target.kind === "browser") return { kind: "browser", label: target.tab.title || target.tab.url || "Kiki's browser" };
  if (target.source) return { kind: "window", label: null };
  return { kind: "window", label: [target.capture.appName, target.capture.windowTitle].filter(Boolean).join(" — ") || "another window" };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const HELPER_NOTE = "Kiki's GNOME helper needs updating for that (Settings → Update GNOME helper, then log out and back in): tell the person.";
const APP_WAIT_MS = 10_000;
/** A scroll that moved nothing may have reached the end of a feed that loads more: it waits, then reads again. */
const LOAD_MORE_MS = 1_000;
/** How often a `wait` step checks for its text. */
const WAIT_POLL_MS = 250;

/** Text that looks like a card number, an ID number, an IBAN or a key: it goes on a fill card, never typed by act. */
export function sensitiveText(text: string): string | null {
  const digits = text.replace(/[\s-]/g, "");
  if (/^\d{13,19}$/.test(digits) && luhn(digits)) return "a card number";
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) return "an ID number";
  if (/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/.test(text)) return "an account number";
  if (/\b(sk|rk|pk)[-_][A-Za-z0-9_-]{16,}\b|\bAIza[0-9A-Za-z_-]{30,}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(text)) return "an API key";
  if (/^[A-Fa-f0-9]{32,}$/.test(text.trim())) return "a key or token";
  return null;
}

/**
 * Why a card waits for the person even when Kiki acts without asking, or null when it can be applied right away:
 * a fill with a password field or a card, ID or account number, a press that pays, or an edit or change that
 * writes one of those numbers. `target` is where the card is for.
 */
export function waitsForPerson(target: Target, action: ProposedAction): string | null {
  if (action.kind === "fill") {
    for (const item of action.fields ?? []) {
      const password =
        target.kind === "browser"
          ? target.tab.fields.get(item.field)?.password
          : target.capture.form?.fields.find((field) => field.id === item.field)?.password;
      if (password) return "it fills a password field";
      const sensitive = typeof item.value === "string" ? sensitiveText(item.value) : null;
      if (sensitive) return `it types ${sensitive}`;
    }
  }
  if (action.kind === "press") {
    const screen = target.kind === "browser" ? target.tab.state : target.screen;
    for (const press of action.presses ?? []) {
      const control = screen.controls.get(press.control);
      if (control && clickRefusal(control, { auto: true })) return "it pays for something";
    }
  }
  const written = action.kind === "edit" ? [action.text] : action.kind === "changes" ? (action.changes ?? []).map((change) => change.replace) : [];
  for (const text of written) {
    const sensitive = typeof text === "string" ? sensitiveText(text) : null;
    if (sensitive) return `it writes ${sensitive}`;
  }
  return null;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** What a wait found, as the first words of a read: where the page went, and whether it was done. */
export function readyNote(ready: Readiness | undefined): string[] {
  if (!ready) return [];
  const notes: string[] = [];
  if (ready.navigated === "page") notes.push(`The page changed to ${ready.url}.`);
  else if (ready.navigated === "in-page") notes.push(`The address changed to ${ready.url} (the same page, updated in place).`);
  if (ready.loading) {
    notes.push(`The page is still loading after ${Math.round(ready.waitedMs / 1000)} s, so what's below may be incomplete: act on it, or look again in a moment.`);
  }
  return notes;
}

/** What a read of a browser tab goes with: how the page was waited for, and what it said before the action. */
interface ReadExtras {
  ready?: Readiness;
  /** The text of the last read of this page: only what changed since is sent, when the page stayed. */
  previous?: string;
  /** The action was meant to change the page: say so when nothing did. */
  expectChange?: boolean;
}

/** The screen read for a browser tab, as the model gets it. */
function tabResult(id: string, target: Extract<Target, { kind: "browser" }>, read: TabRead, note: string, access: ScreenAccess, extras: ReadExtras = {}): ToolResult {
  const screen: ScreenRead = { target: { kind: "browser", title: read.title.slice(0, LIMITS.windowTitleChars) } };
  if (access.window || true) {
    if (read.title) screen.windowTitle = read.title.slice(0, LIMITS.windowTitleChars);
    if (read.url && read.url.length <= LIMITS.urlChars) screen.url = read.url;
  }
  const { ready, previous } = extras;
  const stayed = ready?.navigated === "none";
  let text = read.text;
  const lines = [note, ...readyNote(ready), ...read.notes];
  if (extras.expectChange && stayed && previous !== undefined && previous === read.text && read.notes.length === 0) {
    lines.push("Nothing visible changed after that.");
  } else if (stayed && previous !== undefined) {
    // The same page, changed in part: what changed since the last read.
    const diffed = diffScreen(previous, text);
    if (diffed.diffed) text = diffed.text;
  }
  if (text.trim()) screen.text = text.length > LIMITS.screenTextChars ? `${text.slice(0, LIMITS.screenTextChars - 1)}…` : text;
  if (read.fields.length) screen.fields = read.fields.slice(0, LIMITS.formFields);
  if (ready?.loading) screen.loading = true;
  if (read.shot) {
    screen.screenshot = read.shot.screenshot;
    screen.screenshotSize = read.shot.size;
    target.shot = read.shot.size;
  }
  if (!screen.text) lines.push("The page has no readable text" + (screen.screenshot ? "; only the screenshot shows it." : ": ask for a screenshot with look{screenshot: true}."));
  return { id, content: lines.join(" "), screen };
}

/** What a window target's read says about where it is. */
function withTarget(result: ToolResult, target: Target): ToolResult {
  if (!result.screen) return result;
  const screen = { ...result.screen };
  if (target.kind === "window" && !target.source) {
    screen.target = { kind: "window", title: [target.capture.appName, target.capture.windowTitle].filter(Boolean).join(" — ").slice(0, LIMITS.windowTitleChars) };
  }
  if (screen.screenshot) {
    const sized = measure(screen.screenshot);
    if (sized) {
      screen.screenshotSize = sized.size;
      target.shot = sized.size;
    }
  }
  return { ...result, screen };
}

/**
 * Reads a browser tab after an action, as a `look`: once when the wait found the page quiet, else until two
 * reads agree. `extras.previous` turns the read into what changed, when the page stayed.
 */
async function readTab(
  id: string,
  target: Extract<Target, { kind: "browser" }>,
  note: string,
  access: ScreenAccess,
  screenshot: boolean,
  signal?: AbortSignal,
  extras: ReadExtras = {},
): Promise<ToolResult> {
  const read = await target.tab.read({ screenshot, quiet: extras.ready?.quiet }, signal);
  target.last = read.text;
  return tabResult(id, target, read, note, access, extras);
}

/** Runs one of the target tools for the current target. */
export async function runTargetTool(ctx: TargetContext, call: { id: string; name: string; input: Record<string, unknown> }): Promise<ToolResult> {
  const fail = (content: string): ToolResult => ({ id: call.id, content, isError: true });
  if (ctx.signal?.aborted) return fail("Cancelled.");
  switch (call.name) {
    case "open_url":
      return openUrl(ctx, call.id, call.input);
    case "browser":
      return browserTool(ctx, call.id, call.input);
    case "list_windows":
      return listWindowsTool(ctx, call.id);
    case "use_window":
      return useWindow(ctx, call.id, String(call.input["window"] ?? ""));
    case "open_app":
      return openApp(ctx, call.id, String(call.input["name"] ?? ""));
    case "act":
      return act(ctx, call.id, Array.isArray(call.input["actions"]) ? (call.input["actions"] as ActAction[]) : []);
    case "scroll":
    case "look":
    case "click":
      return screenTool(ctx, call);
    default:
      return fail(`The tool ${call.name} isn't available.`);
  }
}

/** scroll, look and click on the current target. */
async function screenTool(ctx: TargetContext, call: { id: string; name: string; input: Record<string, unknown> }): Promise<ToolResult> {
  const target = ctx.targets.current;
  const fail = (content: string): ToolResult => ({ id: call.id, content, isError: true });
  if (target.kind === "window") {
    const run = async () => {
      if (call.name === "click") {
        const { result } = await clickControl(target.capture, target.screen, call, ctx.look, undefined, { auto: ctx.allow.autoApprove });
        return result;
      }
      return runScreenTool(target.capture, target.screen, call, ctx.look, ctx.signal);
    };
    const result = await (call.name === "look" ? run() : ctx.banner(run));
    return withTarget(result, target);
  }
  const { tab } = target;
  const wantShot = ctx.look.screenshot || call.input["screenshot"] === true;
  if (call.name === "look") return readTab(call.id, target, "This is what's on the page now.", ctx.look, wantShot, ctx.signal);
  if (call.name === "click") {
    const id = String(call.input["control"] ?? "").trim();
    const control = tab.state.controls.get(id);
    if (!control) return fail(`${id || "That"} isn't one of the controls in <visible_text>: look first, and use the ids there.`);
    const refusal = clickRefusal(control, { auto: ctx.allow.autoApprove });
    if (refusal) return fail(refusal);
    const previous = target.last;
    const error = await tab.act(() => tab.click(id));
    const ready = await tab.waitReady({}, ctx.signal);
    // A click that didn't happen still shows the page, so the model needn't look again before trying another.
    const note = error ? `${error} This is what's on the page now.` : `Clicked “${control.name}”. This is what's on the page now.`;
    const result = await readTab(call.id, target, note, ctx.look, wantShot, ctx.signal, { ready, previous, expectChange: !error });
    return error ? { ...result, isError: true } : result;
  }
  const request = scrollRequest(call.input);
  if (!request) return fail("Give a direction, or `to` with text from the page.");
  const before = target.last;
  let moved = await tab.act(() => tab.scroll(request));
  if (!moved && "to" in request) return fail(`Kiki can't find “${request.to}” on the page: copy a few words exactly from <visible_text>, or scroll by screens.`);
  let ready = await tab.waitReady({ budgetMs: LOAD_MORE_MS }, ctx.signal);
  let read = await tab.read({ screenshot: wantShot, quiet: ready.quiet }, ctx.signal);
  if ("direction" in request && request.direction === "down" && (!moved || (before !== undefined && before === read.text)) && !ctx.signal?.aborted) {
    // The end of what's loaded, or a feed fetching more: give it a moment, then try once more.
    await sleep(LOAD_MORE_MS);
    moved = (await tab.act(() => tab.scroll(request))) || moved;
    ready = await tab.waitReady({ budgetMs: LOAD_MORE_MS }, ctx.signal);
    read = await tab.read({ screenshot: wantShot, quiet: ready.quiet }, ctx.signal);
  }
  let text = read.text;
  let note = "to" in request ? `Scrolled to “${request.to}”.` : `Scrolled ${request.direction} a screen.`;
  const atEnd = "direction" in request && (!moved || (before !== undefined && before === read.text));
  if ("direction" in request) {
    if (atEnd) note = `Nothing moved: this is as far as the page scrolls ${request.direction}.`;
    else if (before !== undefined) text = dedupeScreen(before, text, request.direction).text;
  }
  target.last = read.text;
  const result = tabResult(call.id, target, { ...read, text }, note, ctx.look, { ready });
  if (atEnd && result.screen) result.screen.atEnd = true;
  return result;
}

function scrollRequest(input: Record<string, unknown>): ScrollRequest | null {
  if (typeof input["to"] === "string" && input["to"].trim()) return { to: input["to"].trim().slice(0, LIMITS.scrollToChars) };
  const direction = input["direction"];
  return direction === "down" || direction === "up" ? { direction } : null;
}

/** open_url: a page in Kiki's browser becomes the target. */
async function openUrl(ctx: TargetContext, id: string, input: Record<string, unknown>): Promise<ToolResult> {
  const fail = (content: string): ToolResult => ({ id, content, isError: true });
  if (!ctx.allow.browser) return fail("Kiki's browser is turned off in Settings (Computer control).");
  const url = String(input["url"] ?? "");
  const refusal = checkUrl(url, ctx.targets.source.capture, ctx.question);
  if (refusal) return fail(refusal);
  const browser = kikiBrowser();
  let tab: KikiTab;
  let ready: Readiness;
  try {
    ({ tab, ready } = await browser.open(url, { newTab: input["new_tab"] === true }, ctx.signal));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (input["show"] === true) await browser.show();
  const target: Target = { kind: "browser", tab };
  ctx.targets.current = target;
  ctx.onTarget(target);
  const shown = browser.visible ? " The browser is showing to the person." : "";
  // Where it landed is in the note already; the wait's own word on it would repeat it.
  return readTab(id, target, `Opened ${tab.url || url} in Kiki's browser.${shown}`, ctx.look, ctx.look.screenshot, ctx.signal, { ready: { ...ready, navigated: "none" } });
}

/** browser: show, hide, keep, close, back, forward, reload. */
async function browserTool(ctx: TargetContext, id: string, input: Record<string, unknown>): Promise<ToolResult> {
  const fail = (content: string): ToolResult => ({ id, content, isError: true });
  if (!ctx.allow.browser) return fail("Kiki's browser is turned off in Settings (Computer control).");
  const browser = kikiBrowser();
  const target = ctx.targets.current.kind === "browser" ? ctx.targets.current : browser.current ? ({ kind: "browser", tab: browser.current } as const) : null;
  if (!target) return fail("No page is open in Kiki's browser: open_url first.");
  const { tab } = target;
  const notes: string[] = [];
  if (input["close"] === true) {
    browser.closeTab(tab);
    ctx.targets.current = ctx.targets.source;
    ctx.onTarget(ctx.targets.source);
    return { id, content: `Closed the page. You're back on ${ctx.targets.source.capture.appName ?? "the window the question came from"}.` };
  }
  if (input["keep"] === true) {
    tab.keep = true;
    notes.push("The page stays open after the answer.");
  }
  if (input["show"] === true) {
    await browser.show();
    notes.push("The browser is showing to the person now; the page's ids below are fresh.");
  }
  if (input["hide"] === true) {
    browser.hide();
    notes.push("The browser is hidden again.");
  }
  if (input["back"] === true) tab.back();
  if (input["forward"] === true) tab.forward();
  if (input["reload"] === true) tab.reload();
  const moved = input["back"] === true || input["forward"] === true || input["reload"] === true;
  const ready = moved ? await tab.waitReady({ expectNavigation: true }, ctx.signal) : undefined;
  ctx.targets.current = target;
  ctx.onTarget(target);
  browser.refreshToolbar();
  return readTab(id, target, [...notes, "This is what's on the page now."].join(" "), ctx.look, ctx.look.screenshot, ctx.signal, { ready });
}

/** The id the model uses for a window ("w2"), the same for the same window within the session. */
function windowId(targets: Targets, window: ShellWindow): string {
  for (const [id, known] of targets.windows) if (known.id === window.id) return id;
  const id = `w${targets.windows.size + 1}`;
  targets.windows.set(id, window);
  return id;
}

/** list_windows: one line per window. */
async function listWindowsTool(ctx: TargetContext, id: string): Promise<ToolResult> {
  const fail = (content: string): ToolResult => ({ id, content, isError: true });
  if (!ctx.allow.windows) return fail("Working in other windows is turned off in Settings (Computer control).");
  if (ctx.helperVersion < WINDOWS_VERSION) return fail(HELPER_NOTE);
  const windows = await listWindows();
  if (windows === null) return fail(HELPER_NOTE);
  const listed = windows.filter((window) => !window.kiki).slice(0, LIMITS.windowsListed);
  // The hotkey's window first, with its id.
  listed.sort((a, b) => Number(b.source) - Number(a.source));
  if (listed.length === 0) return { id, content: "No other windows are open." };
  const lines = listed.map((window) => {
    const wid = windowId(ctx.targets, window);
    const name = [window.name, window.title].filter(Boolean).join(" — ") || window.wmClass || "(untitled)";
    const marks = [
      window.source ? "the window your question came from" : "",
      window.focused ? "focused" : "",
      window.minimized ? "minimized" : "",
      window.onWorkspace ? "" : "on another workspace",
    ].filter(Boolean);
    return `${wid} ${name}${marks.length ? ` (${marks.join(", ")})` : ""}`;
  });
  return { id, content: `${lines.join("\n")}\n\nuse_window with an id switches to it; "source" goes back to the window the question came from.` };
}

/** use_window: another window (or the hotkey's again) becomes the target, read like a look. */
async function useWindow(ctx: TargetContext, id: string, which: string): Promise<ToolResult> {
  const fail = (content: string): ToolResult => ({ id, content, isError: true });
  if (!ctx.allow.windows) return fail("Working in other windows is turned off in Settings (Computer control).");
  if (ctx.helperVersion < WINDOWS_VERSION) return fail(HELPER_NOTE);
  if (which === "source") {
    const windows = (await listWindows()) ?? [];
    const sourceWindow = windows.find((window) => window.source) ?? ctx.targets.source.window;
    if (sourceWindow) await selectSource(sourceWindow.id);
    ctx.targets.current = ctx.targets.source;
    ctx.onTarget(ctx.targets.source);
    const result = await runScreenTool(ctx.targets.source.capture, ctx.targets.source.screen, { id, name: "look", input: {} }, ctx.look, ctx.signal);
    return withTarget({ ...result, content: `Back on the window the question came from. ${result.content}` }, ctx.targets.source);
  }
  const window = ctx.targets.windows.get(which);
  if (!window) return fail(`${which || "That"} isn't a window id from list_windows: call list_windows first.`);
  return switchTo(ctx, id, window);
}

async function switchTo(ctx: TargetContext, id: string, window: ShellWindow): Promise<ToolResult> {
  const fail = (content: string): ToolResult => ({ id, content, isError: true });
  const fresh = (await listWindows())?.find((candidate) => candidate.id === window.id);
  if (!fresh) return fail(`${window.name || window.title} isn't open anymore: list_windows again.`);
  if (fresh.source) return useWindow(ctx, id, "source");
  if (!(await selectSource(fresh.id))) return fail(HELPER_NOTE);
  const capture = await windowCapture(fresh, ctx.helperVersion, ctx.look.screenshot);
  if (!capture) return fail(`${fresh.name || fresh.title} shares no text with Kiki, and the camera is off: turn the camera on to work there through screenshots.`);
  const target: Target = { kind: "window", capture: { ...capture, fullText: undefined }, screen: newScreenState(), source: false, window: fresh };
  ctx.targets.current = target;
  ctx.onTarget(target);
  const result = await runScreenTool(target.capture, target.screen, { id, name: "look", input: {} }, ctx.look, ctx.signal);
  const where = [fresh.name, fresh.title].filter(Boolean).join(" — ");
  const notes = capture.notes.length ? ` ${capture.notes.join(" ")}` : "";
  return withTarget({ ...result, content: `Switched to ${where}.${notes} ${result.content}` }, target);
}

/** open_app: starts an installed app by name and switches to its window. */
async function openApp(ctx: TargetContext, id: string, name: string): Promise<ToolResult> {
  const fail = (content: string): ToolResult => ({ id, content, isError: true });
  if (!ctx.allow.windows) return fail("Working in other windows is turned off in Settings (Computer control).");
  if (ctx.helperVersion < WINDOWS_VERSION) return fail(HELPER_NOTE);
  const apps = await listApps();
  if (apps === null) return fail(HELPER_NOTE);
  const wanted = name.trim().toLowerCase();
  const app =
    apps.find((candidate) => candidate.name.toLowerCase() === wanted) ??
    apps.find((candidate) => candidate.name.toLowerCase().startsWith(wanted)) ??
    apps.find((candidate) => candidate.name.toLowerCase().includes(wanted)) ??
    apps.find((candidate) => candidate.id.toLowerCase().includes(wanted.replace(/\s+/g, "")));
  if (!app) {
    const near = apps.filter((candidate) => wanted.split(/\s+/).some((word) => word.length > 2 && candidate.name.toLowerCase().includes(word))).slice(0, 5);
    return fail(`No installed app is called “${name}”.${near.length ? ` Close: ${near.map((candidate) => candidate.name).join(", ")}.` : ""}`);
  }
  const before = new Set(((await listWindows()) ?? []).map((window) => window.id));
  if (!(await launchApp(app.id))) return fail(`Kiki couldn't start ${app.name}.`);
  const started = Date.now();
  while (Date.now() - started < APP_WAIT_MS) {
    if (ctx.signal?.aborted) return fail("Cancelled.");
    await sleep(500);
    const windows = (await listWindows()) ?? [];
    const found =
      windows.find((window) => !before.has(window.id) && (window.app === app.id || window.name === app.name)) ??
      windows.find((window) => window.app === app.id && window.focused);
    if (found) return switchTo(ctx, id, found);
  }
  return fail(`${app.name} started, but no window of it showed up within 10 seconds. list_windows may find it later.`);
}

/** act: a few steps, then one read. */
async function act(ctx: TargetContext, id: string, actions: ActAction[]): Promise<ToolResult> {
  const fail = (content: string): ToolResult => ({ id, content, isError: true });
  if (actions.length === 0) return fail("Give at least one step.");
  const target = ctx.targets.current;
  const run = async (): Promise<ToolResult> => {
    let done = 0;
    let stopped: string | null = null;
    /** How the page was waited for after the last step, when that step waited. */
    let ready: Readiness | undefined;
    const previous = target.kind === "browser" ? target.last : undefined;
    const epochAtStart = target.kind === "browser" ? target.tab.epoch : 0;
    for (const [index, action] of actions.entries()) {
      if (ctx.signal?.aborted) {
        stopped = "Cancelled.";
        break;
      }
      const outcome = await step(ctx, target, action);
      ready = outcome.ready;
      if (outcome.error) {
        const left = actions.length - index - 1;
        const changed = target.kind === "browser" && target.tab.epoch !== epochAtStart ? " (the page changed after an earlier step)" : "";
        const rest = left > 0 ? ` ${left === 1 ? "The step after it wasn't" : `The ${left} steps after it weren't`} done.` : "";
        stopped = `Stopped at step ${index + 1} (${describe(action)})${changed}: ${outcome.error}${rest}`;
        break;
      }
      done++;
    }
    const didSteps = done === 0 ? "No step was done." : `Did ${plural(done, "step")}${done < actions.length ? ` of ${actions.length}` : ""}.`;
    const note = stopped ? `${didSteps} ${stopped}` : `${didSteps} This is what's on screen now.`;
    if (target.kind === "browser") {
      // A step that didn't wait (typing) leaves the wait to here.
      ready ??= await target.tab.waitReady({}, ctx.signal);
      const result = await readTab(id, target, note, ctx.look, ctx.look.screenshot, ctx.signal, { ready, previous, expectChange: !stopped });
      return stopped && done === 0 ? { ...result, isError: true } : result;
    }
    await sleep(400);
    const source = target.capture.source;
    if (!source) return fail(note);
    const read = await readScreen(source, ctx.look);
    const screenshot = ctx.look.screenshot && source.screenshot ? await source.screenshot().catch(() => undefined) : undefined;
    const result = withTarget({ id, ...screenResult(target.capture, source, target.screen, read, screenshot, ctx.look, note) }, target);
    return stopped && done === 0 ? { ...result, isError: true } : result;
  };
  return target.kind === "window" ? ctx.banner(run) : target.tab.act(run);
}

/** What a step is, for the model's error. */
function describe(action: ActAction): string {
  if ("click" in action) return `click ${action.click}`;
  if ("type" in action) return `type into ${action.type.field}`;
  if ("key" in action) return `key ${action.key}`;
  if ("scroll" in action) return "to" in action.scroll ? `scroll to “${action.scroll.to}”` : `scroll ${action.scroll.direction}`;
  if ("click_at" in action) return `click at ${action.click_at.x},${action.click_at.y}`;
  if ("wait" in action) return `wait for “${action.wait.text}”`;
  return "drag";
}

/** What one step did: an error for the model, and how the page was waited for afterwards (when it was). */
interface StepOutcome {
  error?: string;
  ready?: Readiness;
}

/** Runs one step on the target. */
async function step(ctx: TargetContext, target: Target, action: ActAction): Promise<StepOutcome> {
  const fail = (error: string): StepOutcome => ({ error });
  if ("type" in action) {
    const sensitive = sensitiveText(action.type.text);
    if (sensitive) return fail(`that looks like ${sensitive}: Kiki doesn't type those on its own. Put it on a propose_fill card for the person to approve.`);
  }
  if (("click_at" in action || "drag" in action) && !ctx.allow.coordinates) {
    return fail("clicking at coordinates is turned off in Settings (Computer control). Use the ids in <visible_text> instead.");
  }
  if (("click_at" in action || "drag" in action) && !target.shot) {
    return fail("there's no screenshot to take coordinates from: look with the camera on (or look{screenshot: true} in Kiki's browser) first, then use pixel coordinates in that screenshot.");
  }
  if ("wait" in action) return waitForText(ctx, target, action.wait.text);
  if (target.kind === "browser") {
    const { tab } = target;
    if (tab.takenOver) return fail("the person took over the browser; wait for their next message.");
    if ("click" in action) {
      const control = tab.state.controls.get(action.click);
      if (!control) return fail(`${action.click} isn't one of the controls on the page: use the ids in the page below.`);
      const refusal = clickRefusal(control, { auto: ctx.allow.autoApprove });
      if (refusal) return fail(refusal);
      const error = await tab.click(action.click);
      if (error) return fail(error);
      return { ready: await tab.waitReady({}, ctx.signal) };
    }
    if ("type" in action) {
      const error = await tab.setField(action.type.field, action.type.text);
      return error ? fail(error) : {};
    }
    if ("key" in action) {
      await tab.key(action.key);
      return { ready: await tab.waitReady({}, ctx.signal) };
    }
    if ("scroll" in action) {
      const moved = await tab.scroll(action.scroll);
      if (!moved && "to" in action.scroll) return fail("Kiki can't find that text on the page: copy a few words exactly from <visible_text>.");
      return { ready: await tab.waitReady({ budgetMs: LOAD_MORE_MS }, ctx.signal) };
    }
    if ("click_at" in action) {
      await tab.clickAt(action.click_at, target.shot!, action.click_at.button ?? "left", action.click_at.count ?? 1);
      return { ready: await tab.waitReady({}, ctx.signal) };
    }
    await tab.drag(action.drag.from, action.drag.to, target.shot!);
    return {};
  }
  const { capture, screen } = target;
  const source = capture.source;
  if (!source) return fail("Kiki can't reach this window.");
  if ("click" in action) {
    const error = await clickInWindow(capture, screen, action.click, { auto: ctx.allow.autoApprove });
    return error ? fail(error) : {};
  }
  if ("type" in action) {
    const field = capture.form?.fields.find((candidate) => candidate.id === action.type.field);
    if (field?.password) return fail(`${action.type.field} (${field.label}) is a password field: Kiki doesn't type passwords. The person types them, or approves a propose_fill card.`);
    const error = await fillField(capture.form, action.type.field, action.type.text);
    return error ? fail(error) : {};
  }
  if ("key" in action) {
    const error = await keyInWindow(source, action.key);
    return error ? fail(error) : {};
  }
  if ("scroll" in action) {
    const result = "to" in action.scroll ? await scrollTo(source, action.scroll.to, ctx.look) : await scrollScreen(source, action.scroll.direction, ctx.look);
    return result.ok ? {} : fail(result.message);
  }
  const error = await pointerInWindow(source, action, target.shot!);
  return error ? fail(error) : {};
}

/** Waits for `text` to be on the page (or in the window), up to LIMITS.waitSeconds. */
async function waitForText(ctx: TargetContext, target: Target, text: string): Promise<StepOutcome> {
  const until = Date.now() + LIMITS.waitSeconds * 1000;
  while (!ctx.signal?.aborted) {
    const found =
      target.kind === "browser"
        ? await target.tab.hasText(text)
        : target.capture.source
          ? squashText((await readScreen(target.capture.source, ctx.look))?.text ?? "").includes(squashText(text))
          : false;
    if (found) return target.kind === "browser" ? { ready: await target.tab.waitReady({ budgetMs: WAIT_POLL_MS }, ctx.signal) } : {};
    if (Date.now() >= until) return { error: `“${text}” didn't appear within ${LIMITS.waitSeconds} seconds.` };
    await sleep(WAIT_POLL_MS);
  }
  return { error: "Cancelled." };
}

function squashText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Checks a press card's controls on a browser target. An error for the model, or null. */
export function tabPressProblems(tab: KikiTab, presses: PressTarget[]): string | null {
  const unknown = presses.filter((press) => !tab.state.controls.has(press.control));
  return unknown.length ? `${unknown.map((press) => press.control).join(", ")} isn't one of the controls in <visible_text>: look first, and use the ids there.` : null;
}

/** Checks a fill card's values on a browser target. */
export function tabFillProblems(tab: KikiTab, values: FieldValue[]): string | null {
  const lines = values.flatMap((item) => {
    const field = tab.fields.get(item.field);
    if (!field) return [`${item.field} isn't one of the fields in <form_fields>.`];
    const toggle = field.kind === "checkbox" || field.kind === "radio";
    if (toggle && typeof item.value !== "boolean") return [`${item.field} is a ${field.kind}: use true or false.`];
    if (!toggle && typeof item.value !== "string") return [`${item.field} is a text field: give it text.`];
    return [];
  });
  return lines.length ? `${lines.join("\n")}\nPropose the fill again with these fixed or left out.` : null;
}

/** Runs a press card's button on a browser target. */
export async function tabApplyPresses(tab: KikiTab, presses: PressTarget[]): Promise<ActionStatus> {
  const failed: string[] = [];
  let done = 0;
  for (const press of presses) {
    const error = await tab.act(() => tab.click(press.control));
    if (error) failed.push(`${press.label ?? press.control} (${error})`);
    else {
      done++;
      await tab.settle();
    }
  }
  if (done === 0) throw new Error(`Kiki couldn't press ${failed.join("; ")}.`);
  return { outcome: "pressed", message: `Pressed ${done === presses.length ? plural(presses.length, "control") : `${done} of ${plural(presses.length, "control")}`} in Kiki's browser.${failed.length ? ` Not pressed: ${failed.join("; ")}.` : ""}` };
}

/** Runs a fill card's button on a browser target. The card is the person's approval, so password fields are allowed. */
export async function tabApplyFill(tab: KikiTab, values: FieldValue[]): Promise<ActionStatus> {
  const failed: string[] = [];
  let done = 0;
  for (const item of values) {
    const field = tab.fields.get(item.field);
    const error = field ? await tab.act(() => tab.setField(item.field, item.value, { approved: true })) : "isn't on the page anymore";
    if (error) failed.push(`${field?.label ?? item.field} (${error})`);
    else done++;
  }
  if (done === 0) throw new Error(`Kiki couldn't fill these: ${failed.join("; ")}.`);
  return { outcome: "applied", message: `Filled ${done === values.length ? plural(values.length, "field") : `${done} of ${plural(values.length, "field")}`} in Kiki's browser.${failed.length ? ` Not filled: ${failed.join("; ")}.` : ""}` };
}
