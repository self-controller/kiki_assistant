// One assistant reply in the thread: the thinking feed, the answer's markdown streaming in (rendered a frame at a
// time, with new text fading in), then its cards and sources.
import type { Source } from "@kiki/shared";
import DOMPurify from "dompurify";
import type { SavedAction } from "../shared-types.ts";
import { el } from "./dom.ts";
import { hostOf } from "./feed.ts";
import { icon } from "./icons.ts";
import { holdLive, markdownToHtml, splitLive } from "./markdown.ts";
import { FADE_MS, freshRanges, revealTo, type FreshRange, type Reveal } from "./reveal.ts";
import { Trace } from "./trace.ts";

const kiki = window.kiki.popup;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

/** What an answer needs of the thread it's in. */
export interface AnswerHost {
  /** Where replies go. */
  content: HTMLElement;
  nearBottom(): boolean;
  scrollToBottom(force?: boolean): void;
  /** A card for an action Kiki proposed. */
  card(saved: SavedAction): HTMLElement;
}

/** The HTML for `markdown`, sanitized: code blocks with a copy button, math rendered. */
export function renderMarkdown(markdown: string): DocumentFragment {
  const fragment = DOMPurify.sanitize(markdownToHtml(markdown), { RETURN_DOM_FRAGMENT: true });
  // markdown.ts leaves the copy buttons empty for their icon.
  for (const button of fragment.querySelectorAll(".code-copy:empty")) button.append(icon("copy", 13));
  return fragment;
}

/** Copies a code block's code, and shows a tick for a moment. */
export function copyCode(button: HTMLElement): void {
  const code = button.closest(".code-block")?.querySelector("code")?.textContent ?? "";
  void kiki.copyText(code);
  button.replaceChildren(icon("check", 13));
  button.classList.add("copied");
  window.setTimeout(() => {
    button.replaceChildren(icon("copy", 13));
    button.classList.remove("copied");
  }, 1500);
}

/** The links an answer cites, by site. */
export function sourceList(items: Source[]): HTMLElement {
  const list = el("div", "sources");
  for (const item of items) {
    const link = el("a", undefined, hostOf(item.url));
    link.href = item.url;
    link.title = item.title;
    list.append(link);
  }
  return list;
}

/**
 * Wraps the text in `ranges` (offsets in the answer's text; `root`'s text starts at `offset`) in spans that fade
 * in, partway through their fade. Plain inline spans, so the text is laid out the same with or without them.
 */
function wrapFresh(root: Node, ranges: FreshRange[], offset: number): void {
  if (ranges.length === 0) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

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
      // Rebuilt as the block renders again: each run picks up its fade where it was.
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
export class Answer {
  readonly root = el("div", "msg assistant");
  readonly trace: Trace;
  readonly body = el("div", "answer");
  /** Action cards Kiki proposed, below the text. */
  readonly cards = el("div", "action-cards");
  /** The markdown received so far; the first `#shown` characters of it are on screen. */
  raw = "";
  #shown = 0;
  finished = false;
  /** Runs of the rendered text that are still animating in, and the rendered text's length. */
  #reveals: Reveal[] = [];
  #length = 0;
  /**
   * The blocks before the one being written, rendered once and kept as `body`'s first children: their markdown,
   * how many nodes they are, and how long their text is.
   */
  #settled = { markdown: "", nodes: 0, chars: 0 };
  /** Sources and notes, added below the text once all of it is on screen. */
  #after: Array<() => void> = [];
  #frame = 0;
  #lastFrame = 0;
  #settleTimer = 0;
  /** The last render left out a formula still streaming in. */
  #heldBack = false;
  readonly #host: AnswerHost;

  constructor(host: AnswerHost) {
    this.#host = host;
    this.trace = new Trace(() => host.scrollToBottom());
    this.root.append(this.trace.root, this.body, this.cards);
    host.content.append(this.root);
    host.scrollToBottom(true);
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
      if (this.finished) {
        // A formula left unfinished at the very end shows as written.
        if (this.#heldBack) this.#render(now);
        for (const add of this.#after.splice(0)) add();
      }
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

  /**
   * Renders what's on screen. While the text streams in, only the block being written is rendered again each
   * frame; the blocks before it stay as they are, and a formula shows once it's whole. With everything in, the
   * last render goes over all of it: markdown can reread earlier text as more arrives (a closing ** turns
   * literal stars into bold).
   */
  #render(now: number): void {
    const stick = this.#host.nearBottom();
    const shown = this.raw.slice(0, this.#shown);
    const whole = this.finished && this.#shown === this.raw.length;
    const { settled, live, open } = whole ? { settled: "", live: shown, open: false } : splitLive(shown);
    const tail = whole || open ? live : holdLive(live);
    this.#heldBack = tail.length < live.length;

    let settledFragment: DocumentFragment | null = null;
    if (settled !== this.#settled.markdown) {
      settledFragment = renderMarkdown(settled);
      this.#settled = { markdown: settled, nodes: settledFragment.childNodes.length, chars: settledFragment.textContent?.length ?? 0 };
    }
    const liveFragment = renderMarkdown(tail);
    const length = this.#settled.chars + (liveFragment.textContent?.length ?? 0);
    if (length < this.#length) this.#reveals = this.#reveals.filter((reveal) => reveal.start < length);
    else if (length > this.#length) this.#reveals.push({ start: this.#length, time: now });
    this.#length = length;
    this.#reveals = this.#reveals.filter((reveal) => now - reveal.time < FADE_MS);
    const ranges = freshRanges(this.#reveals, length, now);
    // Spans in the settled blocks are made once and finish their fade on their own.
    if (settledFragment) wrapFresh(settledFragment, ranges, 0);
    wrapFresh(liveFragment, ranges, this.#settled.chars);

    if (settledFragment) {
      this.body.replaceChildren(settledFragment, liveFragment);
    } else {
      while (this.body.childNodes.length > this.#settled.nodes) this.body.lastChild!.remove();
      this.body.append(liveFragment);
    }
    if (stick) this.#host.scrollToBottom(true);
  }

  /** Adds `add` below the answer once the stream has finished and all its text is on screen. */
  #afterText(add: () => void): void {
    this.#after.push(add);
    this.#run();
  }

  /** The last `chars` of the text were Kiki's notes on the way to a lookup or card: they go in the feed. */
  retract(chars: number): void {
    const keep = Math.max(0, this.raw.length - chars);
    const moved = this.raw.slice(keep).trim();
    this.raw = this.raw.slice(0, keep);
    this.#shown = Math.min(this.#shown, keep);
    this.#reveals = [];
    this.#render(performance.now());
    if (!this.trace.root.isConnected) this.root.prepend(this.trace.root);
    this.trace.resume();
    if (moved) this.trace.addThinking(`\n\n${moved}`);
  }

  addCard(saved: SavedAction): void {
    this.settleTrace();
    this.cards.append(this.#host.card(saved));
    this.#host.scrollToBottom();
  }

  sources(items: Source[]): void {
    this.#afterText(() => {
      this.root.append(sourceList(items));
      this.#host.scrollToBottom();
    });
  }

  /** The stream has ended; the text still being shown finishes at its own pace. */
  finish(note?: string): void {
    if (this.finished) return;
    this.finished = true;
    this.settleTrace();
    if (note) this.#afterText(() => this.root.append(el("div", "cutoff", note)));
    if (!this.raw && !note && !this.cards.hasChildNodes()) this.root.remove();
    this.#run();
  }
}
