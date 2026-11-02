import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "katex/dist/katex.min.css";
import {
  CUSTOM_MODEL_PATTERN,
  EFFORT_LEVELS,
  isCustomModel,
  LIMITS,
  MODEL_CHOICES,
  MODEL_PROVIDERS,
  PROVIDERS,
  type AttachedFile,
  type EffortLevel,
  type FormField,
  type ModelChoice,
  type ModelPick,
  type Provider,
  type QuestionOptions,
  type Screenshot,
} from "@kiki/shared";
import type {
  ContextOmissions,
  CustomModelInfo,
  EditInfo,
  HistoryItem,
  PastSession,
  PastTurn,
  PopupEvent,
  PopupInit,
  PopupLayout,
  ProviderStatus,
  SavedAction,
  WindowContext,
  WindowRect,
} from "../shared-types.ts";
import { renderActionCard, type CardOptions } from "./actionCard.ts";
import { Answer, copyCode, renderMarkdown, sourceList, type AnswerHost } from "./answer.ts";
import { clip, el, keepFocus } from "./dom.ts";
import { plural } from "./feed.ts";
import { renderHistory } from "./history.ts";
import { icon, setIcon, type IconName } from "./icons.ts";
import { cardBottomIn, INSETS, springStep, type Spring } from "./layout.ts";
import { MAX_FILE_BYTES, readTextFile } from "./textFile.ts";
import { morphText } from "./textfx.ts";
import "./popup.css";

const kiki = window.kiki.popup;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const popup = $<HTMLDivElement>("popup");
const card = $<HTMLElement>("card");
const mascot = $<HTMLButtonElement>("mascot");
const closeButton = $<HTMLButtonElement>("close");
const thread = $<HTMLDivElement>("thread");
const threadContent = $<HTMLDivElement>("threadContent");
const historyView = $<HTMLDivElement>("history");
const composer = $<HTMLFormElement>("composer");
const context = $<HTMLDivElement>("context");
const chips = $<HTMLDivElement>("chips");
const notes = $<HTMLParagraphElement>("notes");
const helperNote = $<HTMLParagraphElement>("helperNote");
const helperNoteText = $<HTMLSpanElement>("helperNoteText");
const helperOn = $<HTMLButtonElement>("helperOn");
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
const providerTabs = $<HTMLDivElement>("providerTabs");
const providerHint = $<HTMLDivElement>("providerHint");
const providerHintText = $<HTMLParagraphElement>("providerHintText");
const providerSettings = $<HTMLButtonElement>("providerSettings");

const MAX_IMAGE_EDGE = 1568;
const MAX_INPUT_HEIGHT = 160;

const omit: ContextOmissions = {};
let started = false;
let busy = false;
/** Cards whose buttons are running (a paste, an undo): the composer's button is Stop meanwhile. */
let cardsRunning = 0;
let current: Answer | null = null;
/** A Google account is connected, so cards act directly instead of opening Google in the browser. */
let googleConnected = false;
/** Where edit cards write: the window this popup opened over, until a past session is opened. */
let editTarget: EditInfo | undefined;
/** The form fields fill cards set, in that same window. */
let formFields: FormField[] | undefined;
let attachments: Array<Screenshot & { preview: string; id: number }> = [];
let fileAttachments: Array<AttachedFile & { id: number }> = [];


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

/** The chat box's natural height: the composer plus the whole conversation (or the past sessions). */
/** The chat box's top and bottom borders together; they don't change. */
let cardBorders: number | undefined;

function naturalHeight(): number {
  if (cardBorders === undefined) {
    const style = getComputedStyle(card);
    cardBorders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  }
  const chrome = cardBorders;
  const conversation = historyOpen
    ? historyView.offsetHeight
    : threadContent.childElementCount > 0
      ? threadContent.offsetHeight
      : 0;
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
  popup.classList.toggle("shell-move", Boolean(place.shellMove));
  helperNote.hidden = !place.helperOff;
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
  reportHitRect();
}

/** Where the chat box (with Kiki and its ✕) is, as last told to the main process. */
let hitRect: WindowRect | null = null;
let hitFrame = 0;

/**
 * Kiki stays open on top of other windows, but its window is mostly transparent space around the chat
 * box: tells the main process where the box is, so clicks anywhere else go to the window below.
 */
function reportHitRect(): void {
  if (!place?.staysOpen || hitFrame) return;
  hitFrame = requestAnimationFrame(() => {
    hitFrame = 0;
    // The model menu opens upward, and can reach above Kiki when the box is short.
    const nodes = modelMenu.classList.contains("open") ? [card, mascot, closeButton, modelMenu] : [card, mascot, closeButton];
    const rects = nodes.map((node) => node.getBoundingClientRect());
    const slop = 2;
    const left = Math.floor(Math.min(...rects.map((r) => r.left)) - slop);
    const top = Math.floor(Math.min(...rects.map((r) => r.top)) - slop);
    const right = Math.ceil(Math.max(...rects.map((r) => r.right)) + slop);
    const bottom = Math.ceil(Math.max(...rects.map((r) => r.bottom)) + slop);
    const rect = { x: left, y: top, width: right - left, height: bottom - top };
    if (
      hitRect &&
      hitRect.x === rect.x &&
      hitRect.y === rect.y &&
      hitRect.width === rect.width &&
      hitRect.height === rect.height
    ) {
      return;
    }
    hitRect = rect;
    kiki.hitRect(rect);
  });
}

// The box scales in as it first shows (its parts' own transitions, say a hover, don't move it).
popup.addEventListener("transitionend", (event) => {
  if (event.target === popup) reportHitRect();
});

new ResizeObserver(() => layout()).observe(threadContent);
new ResizeObserver(() => layout()).observe(historyView);
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

// Without click-through (Wayland without Kiki's GNOME extension v5), the transparent space around the
// chat box would block the windows below it, so a click there, or focus leaving, closes Kiki instead.
// Otherwise Kiki stays on top until it's closed: clicks around the box go to the window below.
document.addEventListener("pointerdown", (event) => {
  if (place?.staysOpen) return;
  if (event.target === document.body || event.target === document.documentElement) close();
});

const INTERACTIVE = "button, textarea, input";

/**
 * Whether the pointer was last on a part of the box that moves the window. Those parts eat
 * `pointerdown`, but moves near them still reach the page, so this goes by where the pointer was.
 */
let onDragRegion = false;
/** The compositor is moving the window; its grab takes focus away, which isn't a reason to close. */
let moving = false;

/** The parts of the box that move the window. */
const dragRegions = [".grip", ".actions"].map((selector) => card.querySelector(selector));

function nearDragRegion(event: PointerEvent): boolean {
  if ((event.target as Element | null)?.closest?.(INTERACTIVE)) return false;
  const slop = 4;
  return dragRegions.some((region) => {
    const rect = region?.getBoundingClientRect();
    return (
      rect !== undefined &&
      event.clientX >= rect.left - slop &&
      event.clientX <= rect.right + slop &&
      event.clientY >= rect.top - slop &&
      event.clientY <= rect.bottom + slop
    );
  });
}

/** Whether the pointer was over `hitRect`, as last told to the main process. */
let pointerOver = true;

document.addEventListener("pointermove", (event) => {
  // Moves reach the page again once the compositor lets go of the window.
  moving = false;
  // Only the blur handler asks, and only without click-through.
  if (!place?.staysOpen) onDragRegion = nearDragRegion(event);
  if (place?.staysOpen && hitRect) {
    const inside =
      event.clientX >= hitRect.x &&
      event.clientX <= hitRect.x + hitRect.width &&
      event.clientY >= hitRect.y &&
      event.clientY <= hitRect.y + hitRect.height;
    if (inside !== pointerOver) {
      pointerOver = inside;
      kiki.pointerOver(inside);
    }
  }
});

// With Kiki's GNOME extension, a press on the top edge or the toolbar's empty space has the extension
// move the window. A move the window starts itself can't take its top above the top bar, and most of
// the window is transparent space above the box, so the box couldn't go higher than where it opened.
card.addEventListener("pointerdown", (event) => {
  if (!popup.classList.contains("shell-move") || event.button !== 0) return;
  const target = event.target as Element;
  if (target.closest(INTERACTIVE) || !target.closest(".grip, .actions")) return;
  event.preventDefault();
  onDragRegion = true;
  kiki.move();
});

// Without click-through, a popup, not a window to come back to: close when focus leaves.
window.addEventListener("blur", () => {
  if (place?.staysOpen) return;
  if (holdOpen || performance.now() - shownAt < 500) return;
  if (onDragRegion) {
    moving = true;
    return;
  }
  blurTimer = window.setTimeout(() => {
    if (!holdOpen && !moving && !document.hasFocus()) close();
  }, 150);
});
window.addEventListener("focus", () => {
  window.clearTimeout(blurTimer);
  moving = false;
  // Back from the file picker.
  if (holdOpen) setTimeout(() => (holdOpen = false), 300);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (cardsRunning > 0) {
    // A card's button is still running (pasting, undoing): Esc stops it, like Stop.
    kiki.cancel();
  } else if (modelMenu.classList.contains("open")) {
    setModelMenu(false);
    input.focus();
  } else if (historyOpen) {
    closeHistory();
    input.focus();
  } else if ((event.target as HTMLElement | null)?.closest?.(".action-card")) {
    // Leaves the card's field, keeping the edits.
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

const cardOptions: CardOptions = {
  get google() {
    return googleConnected;
  },
  get edit() {
    return editTarget;
  },
  get fields() {
    return formFields;
  },
  run: async (id, edited, mode) => {
    // Stop cancels a card that's running, like an answer.
    if (mode !== "dismiss") setCardBusy(true);
    try {
      const result = await kiki.runAction(id, edited, mode);
      // An edit moves the target onto Kiki's text, for the next card (and back onto the original after an undo).
      if (result.ok && result.edit !== undefined) editTarget = result.edit ?? undefined;
      return result;
    } finally {
      if (mode !== "dismiss") setCardBusy(false);
    }
  },
  openSettings: () => kiki.openSettings(),
  onChange: () => layout(),
};

/** What answers need of the thread. */
const answerHost: AnswerHost = {
  content: threadContent,
  nearBottom,
  scrollToBottom,
  card: (saved) => renderActionCard(saved, cardOptions),
};

// Kiki's GNOME extension was switched off: turning it on places the next popup at the pointer again.
helperOn.addEventListener("click", async () => {
  helperOn.disabled = true;
  const result = await kiki.enableExtension();
  helperNoteText.textContent = result.message ?? "Turned on.";
  if (result.ok) helperOn.remove();
  else helperOn.disabled = false;
  layout();
});

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
    case "action":
      answer?.addCard({ action: event.action });
      break;
    case "card":
      // Applied right away ("Act without asking"): the card arrives done.
      answer?.addCard(event.saved);
      if (event.edit !== undefined) editTarget = event.edit ?? undefined;
      break;
    case "notes":
      if (answer && !answer.finished) answer.retract(event.chars);
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
    case "context":
      // For a highlight the hotkey brought in: only while it waits for the next question.
      if (event.selection !== undefined) {
        if (!pending) break;
        setHighlightChip(event.selection);
        if (!pending.withWindow) break;
      }
      setTextChip(event.textChars, event.textPreview);
      break;
    case "fields":
      if (event.next && pending) pending.fields = event.fields;
      else formFields = event.fields;
      break;
    case "target":
      setTargetChip(event.kind, event.label);
      break;
    case "recapture":
      takeCapture(event);
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

/** Kiki is answering, or a card's button is running: the composer's button is Stop meanwhile. */
function working(): boolean {
  return busy || cardsRunning > 0;
}

function syncBusy(): void {
  popup.classList.toggle("busy", working());
  updateSend();
}

function setBusy(next: boolean): void {
  busy = next;
  syncBusy();
}

function setCardBusy(running: boolean): void {
  cardsRunning = Math.max(0, cardsRunning + (running ? 1 : -1));
  syncBusy();
}

// ---------- Model, effort and search ----------

const MODELS: Record<ModelChoice, { label: string; icon: IconName }> = {
  haiku: { label: "Haiku", icon: "zap" },
  sonnet: { label: "Sonnet", icon: "sparkle" },
  opus: { label: "Opus", icon: "gem" },
  "flash-lite": { label: "Flash-Lite", icon: "zap" },
  flash: { label: "Flash", icon: "sparkle" },
  argon: { label: "Argon", icon: "gem" },
  luna: { label: "Luna", icon: "zap" },
  sol: { label: "Sol", icon: "sparkle" },
  astra: { label: "Astra", icon: "gem" },
};

/** The model menu's tabs: each provider's models, then the ones the person added ("Other"). */
type MenuTab = Provider | "custom";
const MENU_TABS: readonly MenuTab[] = [...PROVIDERS, "custom"];

/** Each tab's name, the family its models belong to, and what to set up in Settings before they can answer. */
const TAB_INFO: Record<MenuTab, { tab: string; family: string; setup: string }> = {
  anthropic: { tab: "Anthropic", family: "Claude", setup: "To ask Claude, set up Claude Code or add an Anthropic API key in Settings." },
  google: { tab: "Google", family: "Gemini", setup: "To ask Gemini, add your Gemini API key in Settings." },
  openai: { tab: "OpenAI", family: "GPT", setup: "To ask GPT, set up Codex or add an OpenAI API key in Settings." },
  custom: { tab: "Other", family: "", setup: "Add models from other services, or ones on this computer, in Settings." },
};

function tabOf(choice: ModelPick): MenuTab {
  return isCustomModel(choice) ? "custom" : MODEL_PROVIDERS[choice];
}

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

/** A model picked in an earlier popup: a built-in one, or one the person added (checked once init lists them). */
function rememberedModel(key: string): ModelPick | null {
  try {
    const value = localStorage.getItem(key);
    if (MODEL_CHOICES.includes(value as ModelChoice)) return value as ModelChoice;
    return value && CUSTOM_MODEL_PATTERN.test(value) ? (value as ModelPick) : null;
  } catch {
    return null;
  }
}

let model: ModelPick = rememberedModel("kiki.model") ?? "opus";
/** Which tabs the menu offers and whether they're set up, from the popup's init. Until then, only Anthropic. */
let tabStatus: Partial<Record<MenuTab, ProviderStatus>> = { anthropic: "ready" };
/** The models the person added, from the popup's init. */
let customModels: CustomModelInfo[] = [];
/** The tab whose models the menu lists. */
let menuTab: MenuTab = tabOf(model);
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

/** A model's label and icon in the menu: a cloud or a chip for the ones the person added. */
function modelInfo(choice: ModelPick): { label: string; icon: IconName; spoken: string } {
  if (!isCustomModel(choice)) {
    const { label, icon: name } = MODELS[choice];
    return { label, icon: name, spoken: `${TAB_INFO[MODEL_PROVIDERS[choice]].family} ${label}` };
  }
  const added = customModels.find((info) => info.choice === choice);
  return {
    label: added?.name ?? "Model",
    icon: added?.local ? "cpu" : "cloud",
    spoken: added ? `${added.name} on ${added.service}` : "a model you added",
  };
}

/** Picks the model. `keep` false: only for this popup (a stand-in while the chosen one can't be asked). */
function setModel(choice: ModelPick, keep = true): void {
  model = choice;
  if (keep) {
    remember("kiki.model", choice);
    remember(`kiki.model.${tabOf(choice)}`, choice);
  }
  const info = modelInfo(choice);
  setIcon(modelIcon, info.icon, 14);
  morphText(modelLabel, info.label);
  modelButton.setAttribute("aria-label", `Model: ${info.spoken}`);
  modelButton.title = "Choose the model";
  for (const item of modelItems.querySelectorAll<HTMLElement>(".menu-item")) {
    item.setAttribute("aria-checked", String(item.dataset["model"] === choice));
  }
  syncCapabilities();
}

/** Models the person added can't search the web, and take no effort level: those buttons sit out. */
function syncCapabilities(): void {
  const custom = isCustomModel(model);
  for (const button of [searchToggle, effortButton]) {
    button.classList.toggle("unavailable", custom);
    button.setAttribute("aria-disabled", String(custom));
  }
  searchToggle.title = custom ? "This model can't search the web" : "Search the web";
  effortButton.title = custom ? "This model thinks as it's set up to" : "How hard Kiki thinks (click to change)";
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
  // It opens on the current model's tab.
  if (open) showTab(tabOf(model));
  modelMenu.classList.toggle("open", open);
  modelButton.setAttribute("aria-expanded", String(open));
  if (!open) hideHighlight();
  reportHitRect();
}

function menuItem(choice: ModelPick): HTMLElement {
  const item = el("button", "menu-item");
  item.type = "button";
  item.dataset["model"] = choice;
  item.dataset["tab"] = tabOf(choice);
  item.setAttribute("role", "menuitemradio");
  item.hidden = tabOf(choice) !== menuTab;
  const check = icon("check", 13, 2.5);
  check.classList.add("check");
  const info = modelInfo(choice);
  const label = el("span", undefined, info.label);
  if (isCustomModel(choice)) label.title = info.spoken;
  item.append(icon(info.icon, 14), label, check);
  item.addEventListener("pointerenter", () => moveHighlight(visibleItems().indexOf(item)));
  item.addEventListener("focus", () => moveHighlight(visibleItems().indexOf(item)));
  keepFocus(item);
  item.addEventListener("click", () => {
    setModel(choice);
    setModelMenu(false);
    input.focus();
  });
  modelItems.append(item);
  return item;
}

/** The built-in models' items, then the ones for the models the person added. */
let modelItemNodes = MODEL_CHOICES.map(menuItem);

/** The menu's models for the tab it shows. */
function visibleItems(): HTMLElement[] {
  return modelItemNodes.filter((item) => !item.hidden);
}

const tabNodes = MENU_TABS.map((menu) => {
  const tab = el("button", "provider-tab", TAB_INFO[menu].tab);
  tab.type = "button";
  tab.dataset["tab"] = menu;
  keepFocus(tab);
  tab.addEventListener("click", () => showTab(menu));
  providerTabs.append(tab);
  return tab;
});

/** The tabs the menu shows: every provider, and Other when the person added models. */
function visibleTabs(): HTMLElement[] {
  return tabNodes.filter((tab) => !tab.hidden);
}

/** Lists `menu`'s models, or, when they aren't set up, what to set up in Settings. */
function showTab(menu: MenuTab): void {
  menuTab = menu;
  const ready = tabStatus[menu] === "ready";
  for (const tab of tabNodes) {
    const status = tabStatus[tab.dataset["tab"] as MenuTab];
    tab.hidden = !status;
    tab.classList.toggle("needs-key", status === "needsSetup");
    tab.setAttribute("aria-pressed", String(tab.dataset["tab"] === menu));
  }
  providerTabs.hidden = visibleTabs().length < 2;
  for (const item of modelItemNodes) item.hidden = item.dataset["tab"] !== menu;
  modelItems.hidden = !ready;
  providerHint.hidden = ready;
  if (!ready) providerHintText.textContent = TAB_INFO[menu].setup;
  hideHighlight();
  reportHitRect();
}

/** A model that can answer, for when the chosen one can't: the last one picked on the first tab that's set up. */
function standIn(): ModelPick | null {
  for (const menu of ["anthropic", "openai", "google", "custom"] as const) {
    if (tabStatus[menu] !== "ready") continue;
    const last = rememberedModel(`kiki.model.${menu}`);
    const items = modelItemNodes.filter((item) => item.dataset["tab"] === menu);
    if (last && items.some((item) => item.dataset["model"] === last)) return last;
    const first = items[0]?.dataset["model"];
    if (first) return first as ModelPick;
  }
  return null;
}

/** Offers the models that are set up, and the ones the person added, from the popup's init. */
function applyModels(init: PopupInit): void {
  customModels = init.customModels;
  tabStatus = { ...init.providers, ...(customModels.length ? { custom: "ready" as const } : {}) };
  for (const item of modelItemNodes.filter((node) => node.dataset["tab"] === "custom")) item.remove();
  modelItemNodes = [...modelItemNodes.filter((node) => node.dataset["tab"] !== "custom"), ...customModels.map((info) => menuItem(info.choice))];
  // A model that can't be asked now (removed, or its key or sign-in is gone) gives way, for this popup.
  const gone = isCustomModel(model) && !customModels.some((info) => info.choice === model);
  if (gone || tabStatus[tabOf(model)] !== "ready") {
    const other = standIn();
    if (other) setModel(other, false);
  } else setModel(model, false);
  showTab(tabOf(model));
}

keepFocus(providerSettings);
providerSettings.addEventListener("click", () => {
  setModelMenu(false);
  kiki.openSettings();
});

modelItems.addEventListener("pointerleave", hideHighlight);
modelMenu.addEventListener("transitionend", (event) => {
  if (event.target === modelMenu) reportHitRect();
});
modelMenu.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    // Between tabs: onto the next one's current (or first) model, or its Settings button.
    const tabs = visibleTabs();
    if (tabs.length < 2) return;
    event.preventDefault();
    const at = tabs.findIndex((tab) => tab.dataset["tab"] === menuTab);
    const step = event.key === "ArrowRight" ? 1 : -1;
    showTab(tabs[(at + step + tabs.length) % tabs.length]!.dataset["tab"] as MenuTab);
    const items = visibleItems();
    if (providerHint.hidden) (items.find((item) => item.dataset["model"] === model) ?? items[0])?.focus();
    else providerSettings.focus();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const items = visibleItems();
  if (items.length === 0) return;
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
  if (isCustomModel(model)) return;
  setEffort(EFFORT_LEVELS[(EFFORT_LEVELS.indexOf(effort) + 1) % EFFORT_LEVELS.length]!);
});

searchToggle.addEventListener("click", () => {
  if (!isCustomModel(model)) setToggle(searchToggle, !isOn(searchToggle));
});

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
    // Before the first question it joins the context chips, as it does a new highlight's; otherwise it shows
    // with the next question.
    if (!started || pending) showScreenshotChip(thumb);
  }
  omit.screenshot = false;
  syncScreenshot();
});

// Clicking a control keeps the cursor in the question.
for (const button of [mascot, modelButton, effortButton, searchToggle, screenshotToggle, attachButton, sendButton]) {
  keepFocus(button);
}
thread.addEventListener("mousedown", (event) => {
  if ((event.target as HTMLElement).closest(".code-copy")) event.preventDefault();
});

// ---------- Composer ----------

function hasContent(): boolean {
  return input.value.trim() !== "" || attachments.length > 0 || fileAttachments.length > 0;
}

function updateSend(): void {
  const label = working() ? "Stop" : hasContent() || started ? "Ask" : "Explain this";
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

/** The first question is going out: the box is a conversation from now on. */
function startConversation(): void {
  started = true;
  card.classList.add("started");
  chips.classList.add("locked");
  input.placeholder = "Ask a follow-up…";
}

/** The question's options from the composer: search, the model and the effort level. */
function composerOptions(): QuestionOptions {
  // Models the person added can't search, and think as they're set up to.
  return isCustomModel(model) ? { search: false, model } : { search: isOn(searchToggle), model, effort };
}

async function ask(question: string): Promise<void> {
  question = question.trim();
  if (!question || busy) return;
  closeHistory();
  const images = attachments;
  const files = fileAttachments;
  const options = composerOptions();
  // Kiki sends the screenshot once: with the first question, or the first one after it's turned on (with a
  // new highlight, its chip shows it).
  const followUpShot = started && !pending && screenshotOn() && !screenshotSent ? screenshotThumb : null;
  if (screenshotOn()) {
    screenshotSent = true;
    syncScreenshot();
  }
  if (!started) {
    startConversation();
    // The context chips lead the conversation from now on.
    threadContent.append(context);
  }
  commitPending();
  threadContent.append(
    userMessage(
      question,
      [...(followUpShot ? [followUpShot] : []), ...images.map((i) => i.preview)],
      files.map((file) => file.name),
    ),
  );
  input.value = "";
  attachments = [];
  fileAttachments = [];
  renderAttachments();
  autoGrow();
  current = new Answer(answerHost);
  setBusy(true);
  try {
    await kiki.ask({
      question,
      omit,
      images: images.map(({ mediaType, data }) => ({ mediaType, data })),
      files: files.map(({ name, text, truncated }) => ({ name, text, ...(truncated ? { truncated } : {}) })),
      options,
    });
  } catch (error) {
    showError(`Something went wrong: ${String(error)}`);
    endTurn();
  }
}

function userMessage(question: string, previews: string[], files: string[] = []) {
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
  if (files.length > 0) {
    const row = el("div", "user-files");
    for (const name of files) {
      const chip = el("span", "file-chip");
      chip.title = name;
      chip.append(icon("file", 12), el("span", "file-name", name));
      row.append(chip);
    }
    message.append(row);
  }
  message.append(el("div", "user-text", question));
  return message;
}

/** Where new context chips go: the composer's, or a new highlight's after the first question. */
let chipRow = chips;

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
  chipRow.append(chip);
  return sync;
}

/** The size in the "Nearby text" chip, once there is one. */
let textCount: HTMLElement | null = null;

/** Adds the "Nearby text" chip, or updates it when the window's full text arrives. */
function setTextChip(chars: number, preview: string | undefined): void {
  if (chars === 0) return;
  if (textCount) {
    textCount.textContent = formatChars(chars);
    const chip = textCount.closest<HTMLElement>(".chip");
    if (chip && preview) chip.title = preview;
    return;
  }
  textCount = el("span", "mono", formatChars(chars));
  const label = el("span");
  label.append("Nearby text · ", textCount);
  addChip(label, "text", { title: preview, name: "the nearby text" });
}

function addWindowChip(appName: string | undefined, windowTitle: string | undefined): void {
  const windowLabel = [appName, windowTitle].filter(Boolean).join(" — ");
  if (windowLabel) addChip(windowLabel, "window", { title: windowLabel, name: "the window name" });
}

/** The chip saying where Kiki is looking when it isn't the window the question came from. */
let targetChip: HTMLElement | null = null;

function setTargetChip(kind: "browser" | "window", label: string | null): void {
  targetChip?.remove();
  targetChip = null;
  if (!label) return;
  const chip = el("span", "chip target");
  chip.append(icon(kind === "browser" ? "globe" : "appWindow", 12), el("span", "chip-label", `${kind === "browser" ? "Kiki's browser" : "Window"}: ${label}`));
  chip.title = label;
  chips.append(chip);
  targetChip = chip;
}

/** The window's chips (`withWindow`; otherwise only the screenshot's) and the camera button for it. */
function renderWindow(info: WindowContext, withWindow = true): void {
  if (withWindow) {
    addWindowChip(info.appName, info.windowTitle);
    setTextChip(info.textChars, info.textPreview);
  }
  if (info.screenshotThumb) {
    screenshotThumb = info.screenshotThumb;
    showScreenshotChip(info.screenshotThumb);
  }
  screenshotUnavailable = info.screenshot === "unavailable";
  screenshotToggle.hidden = !info.screenshot;
  syncScreenshot();
}

function renderContext(init: PopupInit): void {
  renderWindow(init);
  googleConnected = init.google;
  applyModels(init);
  editTarget = init.edit;
  formFields = init.fields;
  if (!init.configured) showError("Kiki isn't set up yet.", "unauthorized");
}

// ---------- The hotkey, pressed again while Kiki is open ----------

/**
 * A highlight the hotkey brought in after the first question, waiting for the next one: its chips above
 * the question, and where cards for its window write.
 */
let pending: {
  root: HTMLElement;
  chips: HTMLElement;
  /** The window's chips show too (another page, or nothing highlighted). */
  withWindow: boolean;
  highlight: HTMLElement | null;
  edit?: EditInfo;
  fields?: FormField[];
} | null = null;

/** Forgets the screenshot of the window before: the camera is for the new one. */
function resetScreenshot(): void {
  delete omit.screenshot;
  screenshotThumb = null;
  screenshotSent = false;
  syncScreenshotChip = null;
}

/** Clears the chips and what they stood for: the popup starts over, with another window or a past session. */
function resetContext(): void {
  for (const key of Object.keys(omit) as Array<keyof ContextOmissions>) delete omit[key];
  pending?.root.remove();
  pending = null;
  chipRow = chips;
  resetScreenshot();
  textCount = null;
  notes.hidden = true;
  chips.replaceChildren();
}

/**
 * The chat takes in what the hotkey read. Before the first question, the popup starts over with the new
 * window; after it, the new highlight (and its window, when that's new) waits above the next question.
 */
function takeCapture(event: Extract<PopupEvent, { type: "recapture" }>): void {
  closeHistory();
  if (event.fresh && !started) {
    resetContext();
    renderWindow(event);
    editTarget = event.edit;
    formFields = event.fields;
  } else {
    pending?.root.remove();
    delete omit.selection;
    // Another page's context starts out sent, like the first one's; on the same page, earlier choices stand.
    if (event.withWindow) {
      delete omit.window;
      delete omit.text;
      textCount = null;
    }
    resetScreenshot();
    const root = el("div", "context pending");
    const row = el("div", "chips");
    root.append(row);
    composer.insertBefore(root, attachmentsRow);
    pending = {
      root,
      chips: row,
      withWindow: event.withWindow,
      highlight: null,
      edit: event.edit,
      fields: event.fields,
    };
    chipRow = row;
    setHighlightChip(event.selection);
    renderWindow(event, event.withWindow);
  }
  layout();
  input.focus();
}

/**
 * The new highlight's chip: what's highlighted, which its ✕ leaves out. Nothing highlighted removes it: the
 * window's full read found the highlight was from another window.
 */
function setHighlightChip(selection: string): void {
  const text = clip(selection, 48);
  if (!pending || pending.highlight?.title === selection) return;
  pending.highlight?.remove();
  pending.highlight = null;
  if (!text) return;
  addChip(`Highlighted · “${text}”`, "selection", {
    title: selection,
    name: "the highlighted text",
  });
  pending.highlight = pending.chips.lastElementChild as HTMLElement;
  // It leads the row.
  pending.chips.prepend(pending.highlight);
}

/** The new highlight goes with the question being asked: its chips move into the conversation above it. */
function commitPending(): void {
  if (!pending) return;
  pending.root.classList.remove("pending");
  pending.chips.classList.add("locked");
  threadContent.append(pending.root);
  editTarget = pending.edit;
  formFields = pending.fields;
  pending = null;
}

thread.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const copy = target.closest<HTMLElement>(".code-copy");
  if (copy) return copyCode(copy);
  const link = target.closest("a");
  if (link?.href) {
    event.preventDefault();
    kiki.openLink(link.href);
  }
});

function defaultQuestion(): string {
  if (attachments.length > 0) return "What's in this image?";
  if (fileAttachments.length > 0) return fileAttachments.length === 1 ? "Summarize this file." : "Summarize these files.";
  return "Explain this.";
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (working()) kiki.cancel();
  else void ask(input.value || defaultQuestion());
});

input.addEventListener("input", () => {
  autoGrow();
  updateSend();
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (working()) return;
    void ask(input.value || defaultQuestion());
  }
});

// ---------- Images and text files: paste, drop, or pick ----------

let nextAttachmentId = 0;

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
  return { mediaType: "image/jpeg", data: preview.slice(preview.indexOf(",") + 1), preview, id: nextAttachmentId++ };
}

async function addImage(file: File): Promise<void> {
  if (attachments.length >= LIMITS.imagesPerQuestion) {
    return flashNote(`You can attach up to ${LIMITS.imagesPerQuestion} images per question.`);
  }
  try {
    const image = await loadImage(file);
    if (image.data.length > LIMITS.screenshotBase64Chars) throw new Error("too large");
    attachments.push(image);
  } catch {
    flashNote("Kiki couldn't read that image.");
  }
}

/** A Markdown, text or code file, sent as its text. */
async function addTextFile(file: File): Promise<void> {
  if (fileAttachments.length >= LIMITS.filesPerQuestion) {
    return flashNote(`You can attach up to ${LIMITS.filesPerQuestion} files per question.`);
  }
  const read = file.size <= MAX_FILE_BYTES ? readTextFile(new Uint8Array(await file.arrayBuffer())) : null;
  if (!read) return flashNote("Kiki can read images and text files, like .md, .txt or code.");
  const name = file.name.slice(0, LIMITS.fileNameChars) || "file";
  fileAttachments.push({ name, ...read, id: nextAttachmentId++ });
}

async function addFiles(files: Iterable<File>): Promise<void> {
  // A copy first: the picker's and a drop's file lists empty out once the event is over.
  for (const file of [...files]) {
    if (file.type.startsWith("image/")) await addImage(file);
    else await addTextFile(file).catch(() => flashNote("Kiki couldn't read that file."));
  }
  renderAttachments();
  input.focus();
}

/** Thumbnails by attachment, so the ones already showing don't drop in again. */
const thumbs = new Map<number, HTMLElement>();

function renderAttachments(): void {
  let added = 0;
  const thumb = (id: number, content: Node[], label: string, remove: () => void) => {
    let node = thumbs.get(id);
    if (!node) {
      node = el("div", "thumb");
      node.style.setProperty("--i", String(added++));
      const button = el("button");
      button.type = "button";
      button.setAttribute("aria-label", label);
      button.append(icon("x", 9, 3));
      button.addEventListener("click", () => {
        remove();
        renderAttachments();
        input.focus();
      });
      node.append(...content, button);
      thumbs.set(id, node);
    }
    return node;
  };
  const nodes = [
    ...attachments.map((image, index) => {
      const img = el("img");
      img.src = image.preview;
      img.alt = `Attached image ${index + 1}`;
      return thumb(image.id, [img], "Remove image", () => {
        attachments = attachments.filter((item) => item.id !== image.id);
      });
    }),
    ...fileAttachments.map((file) => {
      const node = thumb(file.id, [icon("file", 14), el("span", "file-name", file.name)], `Remove ${file.name}`, () => {
        fileAttachments = fileAttachments.filter((item) => item.id !== file.id);
      });
      node.classList.add("file");
      node.title = file.truncated ? `${file.name} (only its start is sent)` : file.name;
      return node;
    }),
  ];
  const ids = new Set([...attachments, ...fileAttachments].map((item) => item.id));
  for (const id of [...thumbs.keys()]) if (!ids.has(id)) thumbs.delete(id);
  attachmentsRow.replaceChildren(...nodes);
  attachmentsRow.hidden = nodes.length === 0;
  attachButton.disabled =
    attachments.length >= LIMITS.imagesPerQuestion && fileAttachments.length >= LIMITS.filesPerQuestion;
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
  const files = [...(event.clipboardData?.files ?? [])];
  if (files.length === 0) return;
  event.preventDefault();
  void addFiles(files);
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
  void addFiles(event.dataTransfer?.files ?? []);
});

attachButton.addEventListener("click", () => {
  holdOpen = true;
  fileInput.click();
});
fileInput.addEventListener("change", () => {
  void addFiles(fileInput.files ?? []);
  fileInput.value = "";
});
fileInput.addEventListener("cancel", () => {
  holdOpen = false;
});

// ---------- Past sessions (click Kiki) ----------

let historyOpen = false;
let historyLoading = false;
/** Where the conversation was scrolled to, to come back to it. */
let threadScroll = 0;

async function openHistory(): Promise<void> {
  if (historyLoading || busy) return;
  historyLoading = true;
  const items = await kiki.history().catch((): HistoryItem[] => []);
  historyLoading = false;
  if (busy) return;
  showHistory(items);
}

function showHistory(items: HistoryItem[]): void {
  renderHistory(historyView, items, {
    open: (item) => void openPast(item),
    clear: () => {
      void kiki.clearHistory().finally(() => showHistory([]));
    },
    settings: () => kiki.openSettings(),
    save: (item, saved) => kiki.saveSession(item.id, saved).catch(() => false),
  });
  if (!historyOpen) threadScroll = thread.scrollTop;
  historyOpen = true;
  popup.classList.add("history-open");
  mascot.setAttribute("aria-expanded", "true");
  thread.scrollTop = 0;
  layout();
}

function closeHistory(): void {
  if (!historyOpen) return;
  historyOpen = false;
  popup.classList.remove("history-open");
  mascot.setAttribute("aria-expanded", "false");
  thread.scrollTop = threadScroll;
  layout();
}

async function openPast(item: HistoryItem): Promise<void> {
  if (item.current || busy) return closeHistory();
  const past = await kiki.openSession(item.id).catch(() => null);
  if (past) {
    // Its cards are for another window.
    editTarget = undefined;
    formFields = undefined;
    loadSession(past);
  } else {
    closeHistory();
    flashNote("Kiki couldn't open that session.");
  }
}

/** What a past question was about, when the hotkey brought its highlight into the chat. */
function highlightNote(highlight: string): HTMLElement {
  const note = el("div", "user-note", `Highlighted “${clip(highlight, 80)}”`);
  note.title = highlight;
  return note;
}

/** A finished answer from a past session, shown whole. */
function pastAnswer(turn: PastTurn): HTMLElement {
  const message = el("div", "msg assistant");
  const body = el("div", "answer");
  body.replaceChildren(renderMarkdown(turn.answer));
  message.append(body);
  if (turn.actions?.length) {
    const cards = el("div", "action-cards");
    cards.append(...turn.actions.map(answerHost.card));
    message.append(cards);
  }
  if (turn.sources?.length) message.append(sourceList(turn.sources));
  if (turn.cutOff) message.append(el("div", "cutoff", "The answer was cut off."));
  return message;
}

/**
 * Switches the popup to a past session, to read and continue. Nothing from the window Kiki opened over
 * comes along: its context, screenshot and attached images stay behind.
 */
function loadSession(past: PastSession): void {
  attachments = [];
  fileAttachments = [];
  renderAttachments();
  resetContext();
  // Its screenshot (if any) wasn't kept, and the one for this window doesn't belong to it.
  screenshotSent = true;
  screenshotToggle.hidden = true;
  addWindowChip(past.appName, past.windowTitle);
  setTextChip(past.textChars, past.textPreview);

  startConversation();
  threadContent.replaceChildren(context);
  for (const turn of past.turns) {
    const question = userMessage(turn.question, []);
    const sent = [turn.images ? plural(turn.images, "image") : "", ...(turn.files ?? [])].filter(Boolean);
    if (sent.length) question.prepend(el("div", "user-note", `Sent ${sent.join(" · ")}`));
    if (turn.highlight) question.prepend(highlightNote(turn.highlight));
    threadContent.append(question, pastAnswer(turn));
  }
  closeHistory();
  scrollToBottom(true);
  updateSend();
  input.focus();
}

mascot.addEventListener("click", () => {
  if (historyOpen) closeHistory();
  else void openHistory();
});

// ---------- Start ----------

setIcon(attachButton, "plus", 16, 2);
setIcon(closeButton, "x", 12, 2.5);
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
  // A Claude Code process for the question starts now, so it doesn't wait for one.
  if (init) kiki.warm(composerOptions());
});
