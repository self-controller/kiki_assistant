// Kiki's scroll, look and click tools: they scroll the window the question came from and read what's on screen
// then, for Claude to go through a feed or a long page, and click links there to get around it. Buttons that
// change something are pressed with a press card instead. Kiki's GNOME extension scrolls any app with a virtual
// touchpad (v8); before that, web pages scroll over AT-SPI. The text comes from AT-SPI, and a screenshot of the
// window when the camera is on.
import {
  LIMITS,
  type FormField,
  type PressTarget,
  type ScreenRead,
  type Screenshot,
  type ScrollRequest,
  type ToolResult,
} from "@kiki/shared";
import type { ActionStatus } from "../shared-types.ts";
import type { Capture, FieldTarget, FormTarget, SourceWindow } from "./capture/common.ts";
import { runHelper, SELECT_PASTE_TOOLKITS, type HelperField } from "./capture/linux.ts";
import { scrollSource, type ScrollOutcome } from "./gnomeShell.ts";
import { plural } from "./google/format.ts";

/**
 * One screen, as a share of the window's height (with the app's own toolbars). Firefox, Zen and GTK apps move
 * 0.7 to 0.8 of what Kiki's touchpad asks (WHEEL_GAIN), so about three quarters of a screen of new text shows,
 * after a little of the last. Other apps may move more, so they get less, rather than skip anything.
 */
const SCREEN_PERCENT = 85;
const OTHER_SCREEN_PERCENT = 65;
/** The share of a scroll's pixels Firefox and Zen move (verified 0.8; GTK 3 moves 0.7 to 0.9). */
const WHEEL_GAIN = 0.8;
/** Where a page scrolls text it brings back into view, below the window's top (and a sticky header). */
const SCROLL_TO_Y = 200;
/** Time for the window to draw what scrolled in (and a feed to put it in place) before Kiki reads it. */
const SETTLE_MS = 400;
/** A scroll that moved nothing may have reached the end of a feed that loads more: it waits, then tries again. */
const LOAD_MORE_MS = 1_000;
/** The helper's click waits up to about 8 s for a page to load, then reads it. */
const CLICK_TIMEOUT_MS = 14_000;
/** How much of the text before a control a press card shows. */
const NEAR_CHARS = 100;

/** A button or link a screen read found, as Kiki keeps it to press later. */
export interface ControlTarget {
  id: string;
  path: number[];
  role?: string;
  name: string;
  /** The text just before it on screen, for the card. */
  near: string;
}

/** What Kiki read on screen during a popup session: the controls it gave ids to, and the last read. */
export interface ScreenState {
  controls: Map<string, ControlTarget>;
  /** Control ids by where the control is and what it says, so one seen again keeps its id. */
  ids: Map<string, string>;
  /** What the last read saw, to tell when a scroll moved nothing. */
  last?: string;
}

export function newScreenState(): ScreenState {
  return { controls: new Map(), ids: new Map() };
}

/** What the person lets Kiki send about the window for this question: its text, its title, screenshots. */
export interface ScreenAccess {
  text: boolean;
  window: boolean;
  screenshot: boolean;
}

interface HelperControl {
  path: number[];
  role?: string | null;
  name: string;
}

interface HelperScreen {
  ok: boolean;
  reason?: string;
  error?: string;
  windowTitle?: string | null;
  /** The page's address, in a browser. */
  url?: string;
  text?: string;
  controls?: HelperControl[];
  fields?: HelperField[];
  moved?: boolean;
  /** --scroll "not_moved": where the text is in the window, for the wheel to scroll it there. */
  y?: number;
  /** --click: the click opened a page (the address changed). */
  navigated?: boolean;
}

/**
 * Which screen tools the app can offer for a question: scroll and look when Kiki can reach the window and may
 * send something about it, clicks, presses and fills (fields can scroll into view) where AT-SPI reads its text.
 */
export function screenTools(
  capture: Capture,
  access: ScreenAccess,
): { screen?: true; press?: true; click?: true; fill?: true } {
  const source = capture.source;
  if (!source) return {};
  const readable = Boolean(source.pid) && access.text;
  const seen = readable || (access.screenshot && Boolean(source.screenshot));
  if (!seen) return {};
  if (!readable) return { screen: true };
  const fillable = !SELECT_PASTE_TOOLKITS.has(source.toolkit ?? "") || source.keys;
  return { screen: true, press: true, click: true, ...(fillable ? { fill: true } : {}) };
}

/** Controls a click may press right away (AT-SPI role names): links, tabs, menu items and plain buttons. */
const CLICK_ROLES = new Set(["link", "page tab", "menu item", "push button", "button"]);

/**
 * What a control that changes something says. Claude is told to put those on a press card; this keeps a click
 * from pressing one anyway, e.g. because a page asked it to.
 */
const CHANGES_SOMETHING =
  /\b(send|submit|post|publish|reply|comment|delete|remove|discard|archive|buy|order|pay|checkout|check out|purchase|subscribe|unsubscribe|follow|unfollow|like|unlike|react|share|repost|retweet|star|unstar|fork|save|block|report|mute|sign (in|out|up)|log ?(in|out)|confirm|accept|decline|approve|merge|install|download|upload|vote|upvote|downvote)\b/i;

/**
 * Why a click can't press this control right away, for Claude: a toggle (a like, a follow) or one that says it
 * changes something goes on a press card, so the person approves it. Null when a click can press it.
 */
export function clickRefusal(control: ControlTarget): string | null {
  const changes = !CLICK_ROLES.has(control.role ?? "") || CHANGES_SOMETHING.test(control.name);
  return changes
    ? `${control.id} (${control.name}) may change something, so the person has to approve it: put it on a propose_press card instead.`
    : null;
}

/** The key a control keeps its id by: where it is and what it says. */
function controlKey(control: HelperControl): string {
  return `${control.path.join(".")}|${control.role ?? ""}|${control.name}`;
}

/** The control's id, giving it the next one ("b4") when it's new; `near` is updated either way. */
function controlId(state: ScreenState, control: HelperControl, near: string): string {
  const key = controlKey(control);
  let id = state.ids.get(key);
  if (!id) {
    id = `b${state.controls.size + 1}`;
    state.ids.set(key, id);
  }
  state.controls.set(id, { id, path: control.path, ...(control.role ? { role: control.role } : {}), name: control.name, near });
  return id;
}

const MARKER = /(\d+)([^]*)/g;

/**
 * The helper's screen text as Claude reads it: each control's marker becomes "⟦b3 Like⟧", with an id that
 * stays the same while the control does. Brackets in the page's own text go, so it can't fake a control.
 */
export function screenText(text: string, controls: HelperControl[], state: ScreenState): string {
  const clean = text.replace(/[⟦⟧]/g, "");
  return clean.replace(MARKER, (_match, index: string, label: string, offset: number) => {
    const control = controls[Number(index)];
    if (!control) return label;
    const before = clean.slice(Math.max(0, offset - NEAR_CHARS * 3), offset).replace(MARKER, "$2");
    return `⟦${controlId(state, control, nearText(before))} ${label}⟧`;
  });
}

/** The last words before a control, on one line: what a press card shows to say which one it is. */
function nearText(before: string): string {
  const flat = before.replace(/\s+/g, " ").trim();
  if (flat.length <= NEAR_CHARS) return flat;
  const cut = flat.slice(-NEAR_CHARS);
  return `…${cut.slice(cut.indexOf(" ") + 1)}`;
}

/** The key a field keeps its id by. */
function fieldKey(field: { path: number[]; role?: string | null; label: string }): string {
  return `${field.path.join(".")}|${field.role ?? ""}|${field.label}`;
}

/**
 * Adds the labelled fields a screen read found on screen to the form fills go to (making one when there was
 * none), and returns them as Claude sees them. A field seen before keeps its id and gets its value as it is
 * now; new ones get the next ids. Text fields in a browser need the GNOME extension's focus (v7) to fill.
 */
export function mergeFields(capture: Capture, source: SourceWindow, found: HelperField[] | undefined): FormField[] {
  const onScreen = (found ?? []).filter((field) => field.onScreen && field.label.trim());
  const selectPaste = SELECT_PASTE_TOOLKITS.has(source.toolkit ?? "");
  if (!onScreen.length || !source.pid || (selectPaste && !source.keys)) return [];
  const form: FormTarget = capture.form ?? { pid: source.pid, fields: [], selectPaste };
  if (form.pid !== source.pid) return [];
  capture.form = form;
  const byKey = new Map(form.fields.map((field) => [fieldKey(field), field]));
  let next = lastFieldId(form) + 1;
  const seen: FieldTarget[] = [];
  for (const field of onScreen) {
    const toggle = field.kind === "checkbox" || field.kind === "radio";
    const now = toggle
      ? { checked: Boolean(field.checked) }
      : { value: field.value ?? "", ...(field.length !== undefined ? { length: field.length } : {}) };
    let target = byKey.get(fieldKey(field));
    if (target) {
      Object.assign(target, now);
    } else {
      if (next > 999) continue;
      target = {
        id: `f${next++}`,
        label: field.label,
        kind: field.kind,
        path: field.path,
        ...(field.role ? { role: field.role } : {}),
        ...now,
      };
      form.fields.push(target);
      byKey.set(fieldKey(field), target);
    }
    seen.push(target);
  }
  return seen.slice(0, LIMITS.formFields).map(({ path: _path, role: _role, length: _length, ...field }) => field);
}

function lastFieldId(form: FormTarget): number {
  return Math.max(form.lastId ?? 0, ...form.fields.map((field) => Number(field.id.slice(1)) || 0));
}

/**
 * Leaves the form behind when a click opened another page: its fields' paths could lead to other things there.
 * Fields on screen on the new page join it with new ids.
 */
function leaveForm(capture: Capture): void {
  if (capture.form) capture.form = { ...capture.form, fields: [], lastId: lastFieldId(capture.form) };
}

const OUTCOME_ERRORS: Record<Exclude<ScrollOutcome, "scrolled">, string> = {
  gone: "The window the question came from is closed, so Kiki can't scroll it.",
  hidden: "The window is minimized or on another workspace: ask the person to bring it back, then try again.",
  busy: "GNOME's overview or one of its dialogs is open; ask the person to close it, then try again.",
  covered: "Other windows cover the one the question came from: ask the person to move them, then try again.",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Step = { ok: true; read?: HelperScreen; moved?: boolean } | { ok: false; message: string };

/** Asks the helper to read the window's screen, or undefined when Kiki can't (or may not) read its text. */
async function readScreen(source: SourceWindow, access: ScreenAccess): Promise<HelperScreen | undefined> {
  if (!source.pid || !access.text) return undefined;
  const read = await runHelper<HelperScreen>(["--screen", JSON.stringify({ pid: source.pid, window: source.window })], 6_000).catch(
    (error: unknown): HelperScreen => ({ ok: false, error: String(error) }),
  );
  if (!read.ok) console.warn("[kiki] screen read:", read.reason ?? read.error);
  return read.ok ? read : undefined;
}

/** Scrolls a screen: with the GNOME extension's wheel, or over AT-SPI in a page. */
async function scrollScreen(source: SourceWindow, direction: "down" | "up", access: ScreenAccess): Promise<Step> {
  const sign = direction === "down" ? 1 : -1;
  if (source.wheel) {
    const known = source.toolkit === "gecko" || source.toolkit?.startsWith("gtk");
    const outcome = await scrollSource(sign * (known ? SCREEN_PERCENT : OTHER_SCREEN_PERCENT), 0);
    if (outcome && outcome !== "scrolled") return { ok: false, message: OUTCOME_ERRORS[outcome] };
    if (outcome === "scrolled") {
      await sleep(SETTLE_MS);
      return { ok: true, read: await readScreen(source, access) };
    }
  }
  if (source.page && source.pid) {
    const read = await runHelper<HelperScreen>(
      ["--scroll", JSON.stringify({ pid: source.pid, window: source.window, direction })],
      10_000,
    ).catch((error: unknown): HelperScreen => ({ ok: false, error: String(error) }));
    if (!read.ok) return { ok: false, message: "Kiki couldn't scroll the page." };
    return { ok: true, read: access.text ? read : undefined, moved: read.moved };
  }
  return {
    ok: false,
    message:
      "Kiki can only scroll web pages until its GNOME helper is updated (Settings → Update GNOME helper, then log out and back in). Tell the person.",
  };
}

/**
 * Brings text Claude saw back into view: over AT-SPI, or with the wheel when the app doesn't scroll that way
 * (twice at most, as the wheel's distance is only about right).
 */
async function scrollTo(source: SourceWindow, to: string, access: ScreenAccess): Promise<Step> {
  if (!source.pid) {
    return { ok: false, message: "Kiki can't find text in this window, only scroll it: scroll up or down by screens instead." };
  }
  for (let attempt = 0; ; attempt++) {
    const read = await runHelper<HelperScreen>(["--scroll", JSON.stringify({ pid: source.pid, window: source.window, to })], 10_000).catch(
      (error: unknown): HelperScreen => ({ ok: false, error: String(error) }),
    );
    if (read.ok) return { ok: true, read: access.text ? read : undefined, moved: true };
    if (read.reason === "not_found") {
      return {
        ok: false,
        message: `Kiki can't find “${to}” in the window's text: copy a few words exactly from a <visible_text>, or scroll by screens.`,
      };
    }
    if (read.reason !== "not_moved" || read.y === undefined || !source.wheel || attempt === 2) break;
    const outcome = await scrollSource(0, (read.y - SCROLL_TO_Y) / WHEEL_GAIN);
    if (outcome && outcome !== "scrolled") return { ok: false, message: OUTCOME_ERRORS[outcome] };
    if (!outcome) break;
    await sleep(SETTLE_MS);
  }
  return { ok: false, message: "Kiki couldn't scroll that window to it; scroll by screens instead." };
}

/** What a read saw, to compare with the next one. */
function signature(read: HelperScreen | undefined, screenshot: string | undefined): string | undefined {
  if (read?.text) return read.text;
  return screenshot;
}

/**
 * Runs a scroll or look in the window the question came from, and returns what's on screen afterwards for
 * Claude: the window's title and text (with ids on its controls), its form fields, and a screenshot when the
 * camera is on.
 */
export async function runScreenTool(
  capture: Capture,
  state: ScreenState,
  call: { id: string; name: string; input: Record<string, unknown> },
  access: ScreenAccess,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const fail = (content: string): ToolResult => ({ id: call.id, content, isError: true });
  const source = capture.source;
  if (!source) return fail("Kiki can't reach the window this question came from.");
  if (signal?.aborted) return fail("Cancelled.");
  const request = call.name === "scroll" ? scrollRequest(call.input) : null;
  if (call.name === "scroll" && !request) return fail("Give a direction, or `to` with text from the window.");

  let step: Step = { ok: true };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!request) step = { ok: true, read: await readScreen(source, access) };
    else if ("to" in request) step = await scrollTo(source, request.to, access);
    else step = await scrollScreen(source, request.direction, access);
    if (!step.ok) return fail(step.message);
    if (!request || "to" in request) break;
    const now = signature(step.read, undefined);
    // Nothing new: at the end of what scrolls, or a feed still loading more. Give it a moment, once.
    if (now === undefined || now !== state.last || step.moved) break;
    if (attempt === 0 && !signal?.aborted) await sleep(LOAD_MORE_MS);
  }
  const screenshot = access.screenshot && source.screenshot ? await source.screenshot().catch(() => undefined) : undefined;
  const read = step.ok ? step.read : undefined;
  const now = signature(read, screenshot?.data);
  const atEnd = Boolean(request && "direction" in request && now !== undefined && now === state.last);
  state.last = now;
  const note = request ? scrollNote(request, atEnd) : "This is what's on screen now.";
  return { id: call.id, ...screenResult(capture, source, state, read, screenshot, access, note, atEnd) };
}

/**
 * What Claude reads after a scroll, look or click: `note` (with a word on what it can't see), and the window's
 * title, page address, text (with ids on its controls) and form fields, with a screenshot when the camera is on.
 */
function screenResult(
  capture: Capture,
  source: SourceWindow,
  state: ScreenState,
  read: HelperScreen | undefined,
  screenshot: Screenshot | undefined,
  access: ScreenAccess,
  note: string,
  atEnd = false,
): { content: string; screen: ScreenRead } {
  const screen: ScreenRead = {};
  if (read) {
    if (access.window && read.windowTitle) screen.windowTitle = read.windowTitle.slice(0, LIMITS.windowTitleChars);
    if (access.window && read.url && read.url.length <= LIMITS.urlChars) screen.url = read.url;
    const text = screenText(read.text ?? "", read.controls ?? [], state);
    if (text.trim()) screen.text = text.length > LIMITS.screenTextChars ? `${text.slice(0, LIMITS.screenTextChars - 1)}…` : text;
    const fields = mergeFields(capture, source, read.fields);
    if (fields.length) screen.fields = fields;
  }
  if (screenshot) screen.screenshot = screenshot;
  if (atEnd) screen.atEnd = true;
  if (!screen.text && !screen.screenshot) {
    note += access.text && source.pid
      ? " No text is on screen there."
      : access.text
        ? " Kiki can't read this window's text. If the person turns on the camera, you'll see screenshots of it."
        : " The person didn't share the window's text, and the camera is off, so you can't see it.";
  } else if (!screen.text && screen.screenshot) {
    note += " Only the screenshot shows it.";
  }
  return { content: note, screen };
}

/** What a click did, for the popup: the control it pressed, and whether that opened another page. */
export interface ClickDone {
  control: ControlTarget;
  navigated: boolean;
}

/**
 * Runs a click in the window the question came from: presses a link, tab or harmless button Kiki read there,
 * waits for the page it opens (or the change in place), and returns what's on screen then, like a look.
 * `onClick` hears which control it's about to press, for the feed; `done` says what happened, once it did.
 */
export async function clickControl(
  capture: Capture,
  state: ScreenState,
  call: { id: string; input: Record<string, unknown> },
  access: ScreenAccess,
  onClick?: (control: ControlTarget) => void,
): Promise<{ result: ToolResult; done?: ClickDone }> {
  const fail = (content: string) => ({ result: { id: call.id, content, isError: true } });
  const source = capture.source;
  if (!source?.pid) return fail("Kiki can't click anything in this window.");
  const id = typeof call.input["control"] === "string" ? call.input["control"].trim() : "";
  const control = state.controls.get(id);
  if (!control) return fail(`${id || "That"} isn't one of the controls in <visible_text>: look or scroll first, and use the ids there.`);
  const refusal = clickRefusal(control);
  if (refusal) return fail(refusal);
  onClick?.(control);
  const read = await runHelper<HelperScreen>(
    ["--click", JSON.stringify({ pid: source.pid, window: source.window, path: control.path, role: control.role, name: control.name })],
    CLICK_TIMEOUT_MS,
  ).catch((error: unknown): HelperScreen => ({ ok: false, error: String(error) }));
  if (!read.ok) {
    if (read.error) console.warn("[kiki] click:", read.error);
    return fail(`Kiki couldn't click ${control.id} (${control.name}): it ${PRESS_REASONS[read.reason ?? ""] ?? "didn't work"}.`);
  }
  const navigated = Boolean(read.navigated);
  if (navigated) leaveForm(capture);
  const screenshot = access.screenshot && source.screenshot ? await source.screenshot().catch(() => undefined) : undefined;
  const seen = access.text ? read : undefined;
  state.last = signature(seen, screenshot?.data);
  const note = `Clicked “${control.name}”.${navigated ? " It opened another page." : ""} This is what's on screen now.`;
  return {
    result: { id: call.id, ...screenResult(capture, source, state, seen, screenshot, access, note) },
    done: { control, navigated },
  };
}

/** What a scroll did, as the first line of its result. */
function scrollNote(request: ScrollRequest, atEnd: boolean): string {
  if ("to" in request) return `Scrolled to “${request.to}”.`;
  if (atEnd) return `Nothing moved: this is as far as the window scrolls ${request.direction}.`;
  return `Scrolled ${request.direction} a screen.`;
}

/** A scroll's input as the server checked it, or null. */
function scrollRequest(input: Record<string, unknown>): ScrollRequest | null {
  if (typeof input["to"] === "string" && input["to"].trim()) return { to: input["to"].trim().slice(0, LIMITS.scrollToChars) };
  const direction = input["direction"];
  return direction === "down" || direction === "up" ? { direction } : null;
}

/** Fills in a press card's labels from what Kiki read, so the card shows what will be pressed, not Claude's words. */
export function describePresses(presses: PressTarget[], state: ScreenState): PressTarget[] {
  return presses.map((press) => {
    const control = state.controls.get(press.control);
    return control ? { control: press.control, label: control.name, ...(control.near ? { near: control.near } : {}) } : press;
  });
}

const PRESS_REASONS: Record<string, string> = {
  gone: "isn't in the window anymore",
  moved: "moved (the page changed): look again and use its new id",
  no_action: "can't be pressed",
};

/** Checks a press card's controls are still there to press. An error for Claude, or null when they all are. */
export async function pressProblems(source: SourceWindow | undefined, state: ScreenState, presses: PressTarget[]): Promise<string | null> {
  if (!source?.pid) return "Kiki can't press anything in this window.";
  const unknown = presses.filter((press) => !state.controls.has(press.control));
  if (unknown.length) {
    return `${unknown.map((press) => press.control).join(", ")} isn't one of the controls in <visible_text>: look or scroll first, and use the ids there.`;
  }
  const controls = presses.map((press) => state.controls.get(press.control)!);
  const checked = await runHelper<{ ok: boolean; results?: string[] }>(
    ["--check-presses", JSON.stringify({ pid: source.pid, controls: controls.map(({ path, role, name }) => ({ path, role, name })) })],
    5_000,
  ).catch(() => ({ ok: false, results: undefined }));
  if (!checked.ok || !checked.results) return "Kiki couldn't check the window's controls.";
  const lines = controls.flatMap((control, index) => {
    const result = checked.results![index];
    return result === "ok" ? [] : [`${control.id} (${control.name}) ${PRESS_REASONS[result ?? ""] ?? "can't be pressed"}.`];
  });
  return lines.length ? lines.join("\n") : null;
}

/** Runs a press card's button: presses each control in turn. Throws with a message for the card when none went. */
export async function applyPresses(
  source: SourceWindow | undefined,
  state: ScreenState,
  presses: PressTarget[],
  appName: string | undefined,
): Promise<ActionStatus> {
  if (!source?.pid) throw new Error("Kiki can't press anything in this window.");
  const failed: string[] = [];
  let done = 0;
  for (const press of presses) {
    const control = state.controls.get(press.control);
    const result = control
      ? await runHelper<{ ok: boolean; reason?: string }>(
          ["--press", JSON.stringify({ pid: source.pid, path: control.path, role: control.role, name: control.name })],
          5_000,
        ).catch(() => ({ ok: false, reason: "failed" }))
      : { ok: false, reason: "gone" };
    if (result.ok) done++;
    else failed.push(`${control?.name ?? press.control} (${PRESS_REASONS[result.reason ?? ""] ?? "didn't work"})`);
  }
  if (done === 0) throw new Error(`Kiki couldn't press ${failed.join("; ")}.`);
  const where = appName ? ` in ${appName}` : "";
  const what = presses.length === 1 ? `“${presses[0]!.label ?? state.controls.get(presses[0]!.control)?.name ?? "it"}”` : plural(presses.length, "control");
  const count = done === presses.length ? what : `${done} of ${plural(presses.length, "control")}`;
  return { outcome: "pressed", message: `Pressed ${count}${where}.${failed.length ? ` Not pressed: ${failed.join("; ")}.` : ""}` };
}
