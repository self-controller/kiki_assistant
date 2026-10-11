import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import {
  EFFORT_LEVELS,
  LIMITS,
  MODEL_CHOICES,
  type EffortLevel,
  type ModelChoice,
  type Screenshot,
  type Source,
} from "@kiki/shared";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { ContextOmissions, PopupEvent, PopupInit, PopupLayout } from "../shared-types.ts";
import { hostOf } from "./feed.ts";
import { icon, setIcon, type IconName } from "./icons.ts";
import { cardBottomIn, INSETS, springStep, type Spring } from "./layout.ts";
import { FADE_MS, freshRanges, revealTo, type FreshRange, type Reveal } from "./reveal.ts";
import { morphText } from "./textfx.ts";
import { Trace } from "./trace.ts";
import "./styles.css";
import "./popup.css";

const kiki = window.kiki.popup;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const popup = $<HTMLDivElement>("popup");
const card = $<HTMLElement>("card");
const closeButton = $<HTMLButtonElement>("close");
const thread = $<HTMLDivElement>("thread");
const threadContent = $<HTMLDivElement>("threadContent");
const composer = $<HTMLFormElement>("composer");
const context = $<HTMLDivElement>("context");
const chips = $<HTMLDivElement>("chips");
const notes = $<HTMLParagraphElement>("notes");
const attachmentsRow = $<HTMLDivElement>("attachments");
const input = $<HTMLTextAreaElement>("input");
const modelButton = $<HTMLButtonElement>("model");
const effortButton = $<HTMLButtonElement>("effort");
const searchToggle = $<HTMLButtonElement>("search");
const screenshotToggle = $<HTMLButtonElement>("screenshot");
const attachButton = $<HTMLButtonElement>("attach");
const fileInput = $<HTMLInputElement>("file");
const sendButton = $<HTMLButtonElement>("send");
const modelMenu = $<HTMLDivElement>("modelMenu");
const modelItems = $<HTMLDivElement>("modelItems");

const MAX_IMAGE_EDGE = 1568;
const MAX_INPUT_HEIGHT = 160;

const omit: ContextOmissions = {};
let started = false;
let busy = false;
let current: Answer | null = null;
let attachments: Array<Screenshot & { preview: string; id: number }> = [];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatChars(count: number): string {
  return count >= 1000 ? `${Math.round(count / 1000)}k chars` : `${count} chars`;
}

// ---------- Size and position ----------

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

/** Set once the popup has its context, so the window first shows with the chat box at its real size. */
let ready = false;
let showing = false;
/** Where the window put the chat box. The window never resizes; the box moves inside it. */
let place: PopupLayout | null = null;
/** The chat box's content height (up to the cap), which the box follows like a spring. */
let target = 0;
let box: Spring = { value: 0, velocity: 0 };
let sizeFrame = 0;
let lastSizeFrame = 0;

/** The chat box's natural height: the composer plus the whole conversation. */
function naturalHeight(): number {
  const style = getComputedStyle(card);
  const chrome = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  const conversation = threadContent.childElementCount > 0 ? threadContent.offsetHeight : 0;
  return Math.ceil(chrome + conversation + composer.offsetHeight);
}

/** Measures the chat box's content; the box then follows it a frame at a time. */
function layout(): void {
  if (!ready) return;
  if (!place) {
    if (!showing) void show(naturalHeight());
    return;
  }
  target = Math.min(naturalHeight(), place.maxCard);
  if (!sizeFrame) sizeFrame = requestAnimationFrame(sizeStep);
}

/** Opens the window with the chat box at its real size; then the box fades in. */
async function show(cardHeight: number): Promise<void> {
  showing = true;
  const height = window.innerHeight;
  place = (await kiki.show(cardHeight)) ?? {
    height,
    anchorY: height - INSETS.bottom,
    maxCard: height - INSETS.top - INSETS.bottom,
  };
  target = Math.min(naturalHeight(), place.maxCard);
  box = { value: target, velocity: 0 };
  placeBox(target);
  requestAnimationFrame(() => {
    popup.classList.add("shown");
    shownAt = performance.now();
  });
  layout();
}

/** One frame of the chat box's height following its content. */
function sizeStep(now: number): void {
  sizeFrame = 0;
  // After a long frame, carry on from where the box was instead of jumping.
  const dt = lastSizeFrame ? Math.min(now - lastSizeFrame, 32) : 16;
  box = reduceMotion.matches ? { value: target, velocity: 0 } : springStep(box, target, dt);
  const settled = Math.abs(box.value - target) < 0.5 && Math.abs(box.velocity) < 5;
  if (settled) box = { value: target, velocity: 0 };
  placeBox(box.value);
  lastSizeFrame = settled ? 0 : now;
  if (!settled) sizeFrame = requestAnimationFrame(sizeStep);
}

/** Where a chat box `height` tall sits: its top edge, from the window's top. */
function boxTop(height: number): number {
  return place ? cardBottomIn(place.anchorY, height, place.height) - height : 0;
}

/**
 * Sizes the chat box and puts it in place. It grows upward from where it opened, so the input stays
 * put; once it reaches the top of the window, it glides down as it keeps growing.
 */
function placeBox(height: number): void {
  if (!place) return;
  const rounded = Math.round(Math.min(height, place.maxCard));
  const stick = nearBottom();
  card.style.height = `${rounded}px`;
  popup.style.translate = `0 ${boxTop(rounded)}px`;
  if (stick) scrollToBottom(true);
  thread.classList.toggle("faded", thread.scrollTop > 4);
}

new ResizeObserver(() => layout()).observe(threadContent);
new ResizeObserver(() => layout()).observe(composer);
thread.addEventListener("scroll", () => thread.classList.toggle("faded", thread.scrollTop > 4));

// ---------- Closing ----------

/** The file picker is open; losing focus to it isn't a reason to close. */
let holdOpen = false;
let shownAt = Infinity;
let blurTimer = 0;

function close(): void {
  kiki.close();
}

closeButton.addEventListener("click", close);
// A click on the transparent space around the chat box is a click outside it.
document.addEventListener("pointerdown", (event) => {
  if (event.target === document.body || event.target === document.documentElement) close();
});

// A popup, not a window to come back to: close when focus leaves.
window.addEventListener("blur", () => {
  if (holdOpen || performance.now() - shownAt < 500) return;
  blurTimer = window.setTimeout(() => {
    if (!holdOpen && !document.hasFocus()) close();
  }, 150);
});
window.addEventListener("focus", () => {
  window.clearTimeout(blurTimer);
  // Back from the file picker.
  if (holdOpen) setTimeout(() => (holdOpen = false), 300);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (modelMenu.classList.contains("open")) {
    setModelMenu(false);
    input.focus();
  } else {
    close();
  }
});

// ---------- Conversation ----------

function nearBottom(): boolean {
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;
}

function scrollToBottom(force = false): void {
  if (force || nearBottom()) thread.scrollTop = thread.scrollHeight;
}

/**
 * Wraps the text in `ranges` (counted like `root.textContent`) in spans that fade in, partway through
 * their fade. Plain inline spans, so the text is laid out the same with or without them.
 */
function wrapFresh(root: HTMLElement, ranges: FreshRange[]): void {
  if (ranges.length === 0) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  let offset = 0;
  for (const node of nodes) {
    const start = offset;
    const end = (offset += node.data.length);
    // Whitespace between blocks (say, "\n" between list items) has nothing to animate.
    if (end <= ranges[0]!.start || !node.data.trim()) continue;
    const fragment = document.createDocumentFragment();
    let at = start;
    for (const range of ranges) {
      if (range.end <= at || range.start >= end) continue;
      if (range.start > at) fragment.append(node.data.slice(at - start, range.start - start));
      const from = Math.max(range.start, at);
      const until = Math.min(range.end, end);
      // Rebuilt every frame: each run picks up its fade where it was.
      const fresh = el("span", "fresh", node.data.slice(from - start, until - start));
      fresh.style.setProperty("--d", `${-Math.round(range.age)}ms`);
      fragment.append(fresh);
      at = until;
    }
    if (at === start) continue;
    if (at < end) fragment.append(node.data.slice(at - start));
    node.replaceWith(fragment);
  }
}

/** One assistant reply: the thinking feed, streamed markdown that fades in, then sources. */
class Answer {
  readonly root = el("div", "msg assistant");
  readonly trace = new Trace(() => scrollToBottom());
  readonly body = el("div", "answer");
  /** The markdown received so far; the first `#shown` characters of it are on screen. */
  raw = "";
  #shown = 0;
  finished = false;
  /** Runs of the rendered text that are still animating in, and the rendered text's length. */
  #reveals: Reveal[] = [];
  #length = 0;
  /** Sources and notes, added below the text once all of it is on screen. */
  #after: Array<() => void> = [];
  #frame = 0;
  #lastFrame = 0;
  #settleTimer = 0;

  constructor() {
    this.root.append(this.trace.root, this.body);
    threadContent.append(this.root);
    scrollToBottom(true);
  }

  /** The answer has started: fold the thinking feed, or drop it if there was nothing to show. */
  settleTrace(): void {
    if (this.trace.finished) return;
    this.trace.finish();
    // A quick answer with nothing to show besides the header: drop the feed.
    if (!this.trace.hasContent) this.trace.root.remove();
  }

  append(delta: string): void {
    this.raw += delta;
    this.settleTrace();
    this.#run();
  }

  #run(): void {
    if (!this.#frame) this.#frame = requestAnimationFrame((now) => this.#step(now));
  }

  /** One frame: shows a few more words, at a pace that keeps up with the stream. */
  #step(now: number): void {
    this.#frame = 0;
    const dt = this.#lastFrame ? Math.min(now - this.#lastFrame, 50) : 16;
    const next = reduceMotion.matches ? this.raw.length : revealTo(this.raw, this.#shown, dt);
    if (next !== this.#shown) {
      this.#shown = next;
      this.#render(now);
    }
    if (this.#shown < this.raw.length) {
      this.#lastFrame = now;
      this.#run();
    } else {
      this.#lastFrame = 0;
      if (this.finished) for (const add of this.#after.splice(0)) add();
      this.#settle();
    }
  }

  /** Once the last run has faded in, renders the text once more as plain text. */
  #settle(): void {
    window.clearTimeout(this.#settleTimer);
    const last = this.#reveals.at(-1);
    if (!last) return;
    this.#settleTimer = window.setTimeout(
      () => {
        // More text came in meanwhile; its last frame settles again.
        if (!this.#frame) this.#render(performance.now());
      },
      Math.max(0, last.time + FADE_MS - performance.now()),
    );
  }

  #render(now: number): void {
    const stick = nearBottom();
    const html = marked.parse(this.raw.slice(0, this.#shown), { async: false, gfm: true });
    this.body.innerHTML = DOMPurify.sanitize(html);
    const length = this.body.textContent?.length ?? 0;
    // Markdown can reread earlier text as more arrives (a closing ** turns literal stars into bold).
    if (length < this.#length) this.#reveals = this.#reveals.filter((reveal) => reveal.start < length);
    else if (length > this.#length) this.#reveals.push({ start: this.#length, time: now });
    this.#length = length;
    this.#reveals = this.#reveals.filter((reveal) => now - reveal.time < FADE_MS);
    wrapFresh(this.body, freshRanges(this.#reveals, length, now));
    if (stick) scrollToBottom(true);
  }

  /** Adds `add` below the answer once the stream has finished and all its text is on screen. */
  #afterText(add: () => void): void {
    this.#after.push(add);
    this.#run();
  }

  sources(items: Source[]): void {
    this.#afterText(() => {
      const list = el("div", "sources");
      for (const item of items) {
        const link = el("a", undefined, hostOf(item.url));
        link.href = item.url;
        link.title = item.title;
        list.append(link);
      }
      this.root.append(list);
      scrollToBottom();
    });
  }

  /** The stream has ended; the text still being shown finishes at its own pace. */
  finish(note?: string): void {
    if (this.finished) return;
    this.finished = true;
    this.settleTrace();
    if (note) this.#afterText(() => this.root.append(el("div", "cutoff", note)));
    if (!this.raw && !note) this.root.remove();
    this.#run();
  }
}

function showError(message: string, code?: string): void {
  const box = el("div", "msg error", message);
  if (code === "unauthorized") {
    const button = el("button", undefined, "Open Settings");
    button.type = "button";
    button.addEventListener("click", () => kiki.openSettings());
    box.append(button);
  }
  threadContent.append(box);
  scrollToBottom(true);
}

function handleEvent(event: PopupEvent): void {
  const answer = current;
  switch (event.type) {
    case "status":
      if (!answer || answer.finished) return;
      // Older servers only report searches here; newer ones also send an activity (deduplicated).
      if (event.phase === "searching") {
        answer.trace.setPhase("searching");
        if (event.query) answer.trace.addSearch(event.query);
      } else if (event.phase === "thinking") {
        answer.trace.setPhase("thinking");
      } else {
        answer.settleTrace();
      }
      break;
    case "thinking":
      answer?.trace.addThinking(event.delta);
      break;
    case "activity":
      answer?.trace.addActivity(event.activity);
      break;
    case "text":
      answer?.append(event.delta);
      break;
    case "sources":
      answer?.sources(event.items);
      break;
    case "done":
      answer?.finish(event.stopReason === "max_tokens" ? "The answer was cut off." : undefined);
      break;
    case "error":
      answer?.finish(event.code === "refused" && answer.raw ? "Kiki stopped this answer." : undefined);
      showError(event.message, event.code);
      break;
    case "notice":
      // Shown above the answer it explains.
      threadContent.insertBefore(el("div", "notice", event.message), answer?.root ?? null);
      break;
    case "end":
      endTurn();
      break;
  }
}

/** The turn is over for any reason; unfinished means the user pressed Stop. */
function endTurn(): void {
  if (!busy) return;
  if (current && !current.finished) current.finish("Stopped.");
  current = null;
  setBusy(false);
  input.focus();
}

function setBusy(next: boolean): void {
  busy = next;
  popup.classList.toggle("busy", next);
  updateSend();
}

// ---------- Model, effort and search ----------

const MODELS: Record<ModelChoice, { label: string; icon: IconName }> = {
  haiku: { label: "Haiku", icon: "zap" },
  sonnet: { label: "Sonnet", icon: "sparkle" },
  opus: { label: "Opus", icon: "gem" },
};

const EFFORTS: Record<EffortLevel, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "XHigh" };

/** The last choice, kept between popups. Storage can be unavailable; the default then stands. */
function remembered<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered; fine.
  }
}

let model: ModelChoice = remembered("kiki.model", MODEL_CHOICES, "opus");
let effort: EffortLevel = remembered("kiki.effort", EFFORT_LEVELS, "low");

const modelIcon = modelButton.querySelector<HTMLElement>(".pill-icon")!;
const modelLabel = modelButton.querySelector<HTMLElement>(".morph")!;
const effortLabel = effortButton.querySelector<HTMLElement>(".morph")!;
const highlight = modelItems.querySelector<HTMLElement>(".menu-highlight")!;
const ITEM_STEP = 34;

/** Four bars, lit up to the effort level. */
const SVG_NS = "http://www.w3.org/2000/svg";
const bars = document.createElementNS(SVG_NS, "svg");
bars.setAttribute("viewBox", "0 0 14 14");
bars.setAttribute("width", "14");
bars.setAttribute("height", "14");
bars.setAttribute("aria-hidden", "true");
bars.classList.add("bars");
const barNodes = [3.5, 6, 8.5, 11].map((height, index) => {
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("x", String(0.9 + index * 3.3));
  rect.setAttribute("y", String(12.5 - height));
  rect.setAttribute("width", "2.2");
  rect.setAttribute("height", String(height));
  rect.setAttribute("rx", "0.9");
  rect.setAttribute("fill", "currentColor");
  bars.append(rect);
  return rect;
});
effortButton.querySelector(".pill-icon")!.append(bars);

function setModel(choice: ModelChoice): void {
  model = choice;
  remember("kiki.model", choice);
  setIcon(modelIcon, MODELS[choice].icon, 14);
  morphText(modelLabel, MODELS[choice].label);
  modelButton.setAttribute("aria-label", `Model: ${MODELS[choice].label}`);
  modelButton.title = "Choose the model";
  for (const item of modelItems.querySelectorAll<HTMLElement>(".menu-item")) {
    item.setAttribute("aria-checked", String(item.dataset["model"] === choice));
  }
}

function setEffort(level: EffortLevel): void {
  effort = level;
  remember("kiki.effort", level);
  const rank = EFFORT_LEVELS.indexOf(level);
  barNodes.forEach((bar, index) => bar.setAttribute("opacity", index <= rank ? "1" : "0.3"));
  morphText(effortLabel, EFFORTS[level]);
  effortButton.setAttribute("aria-label", `Thinking effort: ${EFFORTS[level]}`);
  effortButton.title = "How hard Kiki thinks (click to change)";
}

let highlightShown = false;

function moveHighlight(index: number): void {
  highlight.style.transition = highlightShown
    ? "transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.15s ease"
    : "opacity 0.15s ease-out";
  highlight.style.transform = `translateY(${index * ITEM_STEP}px)`;
  highlight.style.opacity = "1";
  highlightShown = true;
}

function hideHighlight(): void {
  highlight.style.transition = "opacity 0.2s ease-in";
  highlight.style.opacity = "0";
  highlightShown = false;
}

function setModelMenu(open: boolean): void {
  modelMenu.classList.toggle("open", open);
  modelButton.setAttribute("aria-expanded", String(open));
  if (!open) hideHighlight();
}

MODEL_CHOICES.forEach((choice, index) => {
  const item = el("button", "menu-item");
  item.type = "button";
  item.dataset["model"] = choice;
  item.setAttribute("role", "menuitemradio");
  const check = icon("check", 13, 2.5);
  check.classList.add("check");
  item.append(icon(MODELS[choice].icon, 14), el("span", undefined, MODELS[choice].label), check);
  item.addEventListener("pointerenter", () => moveHighlight(index));
  item.addEventListener("focus", () => moveHighlight(index));
  item.addEventListener("mousedown", (event) => event.preventDefault());
  item.addEventListener("click", () => {
    setModel(choice);
    setModelMenu(false);
    input.focus();
  });
  modelItems.append(item);
});
modelItems.addEventListener("pointerleave", hideHighlight);
modelMenu.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const items = [...modelItems.querySelectorAll<HTMLElement>(".menu-item")];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const step = event.key === "ArrowDown" ? 1 : -1;
  items[(at + step + items.length) % items.length]?.focus();
});

modelButton.addEventListener("click", (event) => {
  const open = !modelMenu.classList.contains("open");
  setModelMenu(open);
  // Opened from the keyboard: start on the current model.
  if (open && event.detail === 0) modelItems.querySelector<HTMLElement>(`[data-model="${model}"]`)?.focus();
});
document.addEventListener("pointerdown", (event) => {
  const target = event.target as Node;
  if (modelMenu.classList.contains("open") && !modelMenu.contains(target) && !modelButton.contains(target)) {
    setModelMenu(false);
  }
});

effortButton.addEventListener("click", () => {
  setEffort(EFFORT_LEVELS[(EFFORT_LEVELS.indexOf(effort) + 1) % EFFORT_LEVELS.length]!);
});

searchToggle.addEventListener("click", () => setToggle(searchToggle, !isOn(searchToggle)));

// ---------- Screenshot ----------

/** The screenshot's thumbnail, once Kiki has one. */
let screenshotThumb: string | null = null;
/** Kiki can't take a screenshot here (no GNOME helper yet, or no permission). */
let screenshotUnavailable = false;
/** It went with a question, so it's part of the conversation now. */
let screenshotSent = false;
let syncScreenshotChip: (() => void) | null = null;

function screenshotOn(): boolean {
  return screenshotThumb !== null && !omit.screenshot;
}

function syncScreenshot(): void {
  const on = screenshotOn();
  setToggle(screenshotToggle, on);
  syncScreenshotChip?.();
  const locked = screenshotUnavailable || screenshotSent;
  screenshotToggle.setAttribute("aria-disabled", String(locked));
  screenshotToggle.setAttribute("aria-label", on ? "Screenshot: on" : "Screenshot: off");
  screenshotToggle.title = screenshotUnavailable
    ? "Kiki can't take a screenshot here yet (see Settings)"
    : screenshotSent
      ? "The screenshot went with this conversation"
      : on
        ? "Don't send the screenshot"
        : "Show Kiki a screenshot of this window";
}

function showScreenshotChip(thumb: string): void {
  syncScreenshotChip = addChip("Screenshot", "screenshot", {
    image: thumb,
    name: "the screenshot",
    onChange: syncScreenshot,
  });
}

screenshotToggle.addEventListener("click", async () => {
  if (screenshotToggle.getAttribute("aria-disabled") === "true" || screenshotToggle.hasAttribute("aria-busy")) return;
  if (screenshotOn()) {
    omit.screenshot = true;
    syncScreenshot();
    return;
  }
  if (!screenshotThumb) {
    screenshotToggle.setAttribute("aria-busy", "true");
    screenshotToggle.title = "Taking a screenshot…";
    const thumb = await kiki.screenshot().catch(() => null);
    screenshotToggle.removeAttribute("aria-busy");
    if (!thumb) {
      syncScreenshot();
      screenshotToggle.title = "Kiki couldn't take a screenshot";
      return;
    }
    screenshotThumb = thumb;
    // Before the first question it joins the context chips; after, it shows with the next question.
    if (!started) showScreenshotChip(thumb);
  }
  omit.screenshot = false;
  syncScreenshot();
});

// Clicking a control keeps the cursor in the question.
for (const button of [modelButton, effortButton, searchToggle, screenshotToggle, attachButton, sendButton]) {
  button.addEventListener("mousedown", (event) => event.preventDefault());
}

// ---------- Composer ----------

function hasContent(): boolean {
  return input.value.trim() !== "" || attachments.length > 0;
}

function updateSend(): void {
  const label = busy ? "Stop" : hasContent() || started ? "Ask" : "Explain this";
  sendButton.setAttribute("aria-label", label);
  sendButton.title = label;
}

function autoGrow(): void {
  input.style.height = "auto";
  const full = input.scrollHeight;
  input.style.height = `${Math.min(full, MAX_INPUT_HEIGHT)}px`;
  input.classList.toggle("scrolling", full > MAX_INPUT_HEIGHT);
}

function setToggle(button: HTMLButtonElement, on: boolean): void {
  button.setAttribute("aria-pressed", String(on));
}

function isOn(button: HTMLButtonElement): boolean {
  return button.getAttribute("aria-pressed") === "true";
}

async function ask(question: string): Promise<void> {
  question = question.trim();
  if (!question || busy) return;
  const images = attachments;
  const options = { search: isOn(searchToggle), model, effort };
  // Kiki sends the screenshot once: with the first question, or the first one after it's turned on.
  const followUpShot = started && screenshotOn() && !screenshotSent ? screenshotThumb : null;
  if (screenshotOn()) {
    screenshotSent = true;
    syncScreenshot();
  }
  if (!started) {
    started = true;
    card.classList.add("started");
    chips.classList.add("locked");
    // The context chips lead the conversation from now on.
    threadContent.append(context);
    input.placeholder = "Ask a follow-up…";
  }
  threadContent.append(userMessage(question, [...(followUpShot ? [followUpShot] : []), ...images.map((i) => i.preview)]));
  input.value = "";
  attachments = [];
  renderAttachments();
  autoGrow();
  current = new Answer();
  setBusy(true);
  try {
    await kiki.ask({
      question,
      omit,
      images: images.map(({ mediaType, data }) => ({ mediaType, data })),
      options,
    });
  } catch (error) {
    showError(`Something went wrong: ${String(error)}`);
    endTurn();
  }
}

function userMessage(question: string, previews: string[]) {
  const message = el("div", "msg user");
  if (previews.length > 0) {
    const row = el("div", "user-images");
    for (const preview of previews) {
      const img = el("img");
      img.src = preview;
      img.alt = "Attached image";
      row.append(img);
    }
    message.append(row);
  }
  message.append(el("div", "user-text", question));
  return message;
}

/** Adds a context chip whose ✕ leaves that context out. Returns a function that redraws it. */
function addChip(
  label: string | Node,
  key: keyof ContextOmissions,
  options: { title?: string; image?: string; name: string; onChange?: () => void },
): () => void {
  const chip = el("span", "chip");
  if (options.image) {
    const img = el("img");
    img.src = options.image;
    img.alt = "";
    chip.append(img);
  }
  const text = el("span", "chip-label");
  text.append(label);
  if (options.title) chip.title = options.title;
  const remove = el("button");
  remove.type = "button";
  const sync = () => {
    chip.classList.toggle("removed", Boolean(omit[key]));
    remove.replaceChildren(omit[key] ? document.createTextNode("↺") : icon("x", 11, 2.5));
    remove.setAttribute("aria-label", omit[key] ? `Send ${options.name}` : `Don't send ${options.name}`);
  };
  remove.addEventListener("click", () => {
    omit[key] = !omit[key];
    sync();
    options.onChange?.();
  });
  sync();
  chip.append(text, remove);
  chips.append(chip);
  return sync;
}

function renderContext(init: PopupInit): void {
  const windowLabel = [init.appName, init.windowTitle].filter(Boolean).join(" — ");
  if (windowLabel) addChip(windowLabel, "window", { title: windowLabel, name: "the window name" });
  if (init.textChars > 0) {
    const label = el("span");
    label.append("Nearby text · ", el("span", "mono", formatChars(init.textChars)));
    addChip(label, "text", { title: init.textPreview, name: "the nearby text" });
  }
  if (init.screenshotThumb) {
    screenshotThumb = init.screenshotThumb;
    showScreenshotChip(init.screenshotThumb);
  }
  if (init.screenshot) {
    screenshotUnavailable = init.screenshot === "unavailable";
    screenshotToggle.hidden = false;
    syncScreenshot();
  }
  if (!init.configured) showError("Kiki isn't set up yet.", "unauthorized");
}

thread.addEventListener("click", (event) => {
  const link = (event.target as HTMLElement).closest("a");
  if (link?.href) {
    event.preventDefault();
    kiki.openLink(link.href);
  }
});

function defaultQuestion(): string {
  return attachments.length > 0 ? "What's in this image?" : "Explain this.";
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) kiki.cancel();
  else void ask(input.value || defaultQuestion());
});

input.addEventListener("input", () => {
  autoGrow();
  updateSend();
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (busy) return;
    void ask(input.value || defaultQuestion());
  }
});

// ---------- Images: paste, drop, or pick ----------

let nextImageId = 0;

/** Downscales an image to what Claude reads at full detail, as JPEG. */
async function loadImage(file: Blob): Promise<Screenshot & { preview: string; id: number }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = el("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d")!;
  // JPEG has no transparency; put see-through images on white.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const preview = canvas.toDataURL("image/jpeg", 0.85);
  return { mediaType: "image/jpeg", data: preview.slice(preview.indexOf(",") + 1), preview, id: nextImageId++ };
}

async function addImages(files: Iterable<File>): Promise<void> {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    if (attachments.length >= LIMITS.imagesPerQuestion) {
      flashNote(`You can attach up to ${LIMITS.imagesPerQuestion} images per question.`);
      break;
    }
    try {
      const image = await loadImage(file);
      if (image.data.length > LIMITS.screenshotBase64Chars) throw new Error("too large");
      attachments.push(image);
    } catch {
      flashNote("Kiki couldn't read that image.");
    }
  }
  renderAttachments();
  input.focus();
}

/** Thumbnails by image, so the ones already showing don't drop in again. */
const thumbs = new Map<number, HTMLElement>();

function renderAttachments(): void {
  let added = 0;
  const nodes = attachments.map((image, index) => {
    let thumb = thumbs.get(image.id);
    if (!thumb) {
      thumb = el("div", "thumb");
      thumb.style.setProperty("--i", String(added++));
      const img = el("img");
      img.src = image.preview;
      img.alt = `Attached image ${index + 1}`;
      const remove = el("button");
      remove.type = "button";
      remove.setAttribute("aria-label", "Remove image");
      remove.append(icon("x", 9, 3));
      remove.addEventListener("click", () => {
        attachments = attachments.filter((item) => item.id !== image.id);
        renderAttachments();
        input.focus();
      });
      thumb.append(img, remove);
      thumbs.set(image.id, thumb);
    }
    return thumb;
  });
  for (const id of [...thumbs.keys()]) if (!attachments.some((image) => image.id === id)) thumbs.delete(id);
  attachmentsRow.replaceChildren(...nodes);
  attachmentsRow.hidden = attachments.length === 0;
  attachButton.disabled = attachments.length >= LIMITS.imagesPerQuestion;
  updateSend();
}

let noteTimer = 0;
function flashNote(message: string): void {
  // After the first question, the notes line has moved into the conversation with the context.
  if (started) return showError(message);
  const previous = notes.hidden ? null : notes.textContent;
  notes.textContent = message;
  notes.hidden = false;
  window.clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => {
    notes.textContent = previous;
    notes.hidden = previous === null;
  }, 3500);
}

document.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
  if (files.length === 0) return;
  event.preventDefault();
  void addImages(files);
});

card.addEventListener("dragover", (event) => {
  if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
  event.preventDefault();
  card.classList.add("dropping");
});
card.addEventListener("dragleave", (event) => {
  if (!card.contains(event.relatedTarget as Node | null)) card.classList.remove("dropping");
});
card.addEventListener("drop", (event) => {
  event.preventDefault();
  card.classList.remove("dropping");
  void addImages(event.dataTransfer?.files ?? []);
});

attachButton.addEventListener("click", () => {
  holdOpen = true;
  fileInput.click();
});
fileInput.addEventListener("change", () => {
  void addImages(fileInput.files ?? []);
  fileInput.value = "";
});
fileInput.addEventListener("cancel", () => {
  holdOpen = false;
});

// ---------- Start ----------

setIcon(closeButton, "x", 12, 2.5);
setIcon(attachButton, "plus", 16, 2);
searchToggle.querySelector(".pill-icon")!.append(icon("globe", 14));
screenshotToggle.querySelector(".pill-icon")!.append(icon("camera", 14));
sendButton.querySelector(".send-arrow")!.append(icon("arrowUp", 16, 2.5));
sendButton.querySelector(".send-stop")!.append(icon("square", 12, 2));
setModel(model);
setEffort(effort);
updateSend();

kiki.onEvent(handleEvent);

void kiki.init().then((init) => {
  if (init) renderContext(init);
  autoGrow();
  updateSend();
  input.focus();
  ready = true;
  layout();
});
