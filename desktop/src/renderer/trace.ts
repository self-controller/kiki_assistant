// The "Thinking…" feed above an answer: what Kiki thinks, searches, reads, opens, scrolls and clicks while it works,
// collapsing to one line ("Thought for 6s · 2 searches · 5 sources") once the answer starts.
import type { Activity, Source } from "@kiki/shared";
import { formatSeconds, hostOf, paragraphs, plural, thoughtLine } from "./feed.ts";
import { icon, type IconName } from "./icons.ts";
import { SwapText } from "./textfx.ts";

/** What Kiki is doing right now, as the feed's title says it. */
export type TracePhase = "thinking" | "searching" | "reading" | "scrolling" | "clicking";

const PHASE_TITLES: Record<TracePhase, string> = {
  thinking: "Thinking…",
  searching: "Searching the web…",
  reading: "Reading…",
  scrolling: "Scrolling…",
  clicking: "Clicking…",
};

/** The icon for a lookup or check line, by what it checks. */
function lookupIcon(label: string): IconName {
  if (label.includes("task")) return "listTodo";
  if (label.includes("button")) return "pointerClick";
  if (label.includes("form")) return "form";
  if (label.includes("changes")) return "replaceAll";
  return "calendar";
}

/** Feed lines shown while Kiki works; older ones fold into "+N earlier". */
const VISIBLE_LINES = 5;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Trace {
  readonly root = el("div", "trace live");
  readonly #head = el("button", "trace-head");
  readonly #title = new SwapText("trace-title", PHASE_TITLES.thinking);
  readonly #meta = el("span", "trace-meta");
  readonly #feed = el("ol", "feed");
  readonly #earlier = el("li", "line earlier");
  readonly #full = el("div", "thinking-full");
  readonly #started = Date.now();
  #timer: number;
  /** Feed lines in order; a thought line follows one paragraph of the thinking text. */
  readonly #lines: Array<{ node: HTMLLIElement; paragraph?: number }> = [];
  readonly #reads = new Map<string, HTMLLIElement>();
  readonly #queries = new Set<string>();
  readonly #hosts = new Set<string>();
  /** Scrolls of the person's window and clicks in it, for the summary. */
  #scrolls = 0;
  #clicks = 0;
  #thinking = "";
  #paragraphs = 0;
  #frame = 0;
  #finished = false;

  readonly onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
    this.#head.type = "button";
    this.#head.setAttribute("aria-expanded", "false");
    const chevron = el("span", "trace-chevron");
    chevron.append(icon("chevron", 13));
    this.#head.append(this.#title.root, this.#meta, chevron);
    this.#head.addEventListener("click", () => this.#toggle());

    this.#earlier.hidden = true;
    this.#full.hidden = true;
    this.#feed.append(this.#earlier);
    const inner = el("div");
    inner.append(this.#feed, this.#full);
    const body = el("div", "trace-body");
    body.append(inner);
    this.root.append(this.#head, body);
    this.#timer = window.setInterval(() => this.#tick(), 1000);
  }

  get finished(): boolean {
    return this.#finished;
  }

  /** True once there's anything worth showing besides the "Thinking" header. */
  get hasContent(): boolean {
    return this.#lines.length > 0;
  }

  /** Changes the title to what Kiki is doing now; the old one's letters blur away first. */
  setPhase(phase: TracePhase): void {
    if (!this.#finished) this.#title.set(PHASE_TITLES[phase]);
  }

  addThinking(delta: string): void {
    if (this.#finished) return;
    this.#thinking += delta;
    if (!this.#frame) {
      this.#frame = requestAnimationFrame(() => {
        this.#frame = 0;
        this.#renderThoughts();
      });
    }
  }

  addActivity(activity: Activity): void {
    if (this.#finished) return;
    this.#renderThoughts();
    switch (activity.kind) {
      case "search":
        this.addSearch(activity.query);
        break;
      case "results":
        this.#addResults(activity.sources);
        break;
      case "read":
        this.#addRead(activity.url, activity.title);
        break;
      case "lookup": {
        const line = this.#line("lookup", icon(lookupIcon(activity.label), 12));
        line.append(el("span", "line-text", activity.label));
        this.onChange();
        break;
      }
      case "open": {
        const line = this.#line("open", icon("globe", 12));
        const text = el("span", "line-text", `Opening ${activity.label} for `);
        text.append(el("q", undefined, activity.query));
        line.append(text);
        this.onChange();
        break;
      }
      case "scroll": {
        const looking = !activity.label.startsWith("Scrolling");
        if (!looking) {
          this.#scrolls++;
          this.setPhase("scrolling");
        }
        const line = this.#line("scroll", icon(looking ? "eye" : "mouse", 12));
        line.append(el("span", "line-text", activity.label));
        this.onChange();
        break;
      }
      case "click": {
        this.#clicks++;
        this.setPhase("clicking");
        const line = this.#line("click", icon("pointerClick", 12));
        const text = el("span", "line-text", "Clicking ");
        text.append(el("q", undefined, activity.label));
        line.append(text);
        this.onChange();
        break;
      }
    }
  }

  /** Also used for older servers, which only report the query in a status event. */
  addSearch(query: string): void {
    if (this.#finished || this.#queries.has(query)) return;
    this.#queries.add(query);
    this.setPhase("searching");
    const line = this.#line("search", icon("search", 12));
    const text = el("span", "line-text", "Searching ");
    text.append(el("q", undefined, query));
    line.append(text);
  }

  #addResults(sources: Source[]): void {
    const line = this.#line("results");
    const list = el("div", "domains");
    for (const source of sources) {
      const host = hostOf(source.url);
      this.#hosts.add(host);
      const chip = el("span", "domain");
      chip.title = source.title;
      chip.append(el("b", undefined, host.charAt(0)), host);
      list.append(chip);
    }
    line.append(list);
  }

  #addRead(url: string, title?: string): void {
    this.setPhase("reading");
    const host = hostOf(url);
    this.#hosts.add(host);
    let line = this.#reads.get(url);
    if (!line) {
      line = this.#line("read", icon("file", 12));
      this.#reads.set(url, line);
    }
    const text = el("span", "line-text", "Reading ");
    if (title) text.append(el("q", undefined, title));
    else text.append(host);
    line.replaceChildren(icon("file", 12), text);
    if (title) line.append(el("span", "host", host));
    this.onChange();
  }

  #line(kind: string, lead?: SVGElement, paragraph?: number): HTMLLIElement {
    const node = el("li", `line ${kind}`);
    if (lead) node.append(lead);
    this.#feed.append(node);
    this.#lines.push({ node, paragraph });
    this.#layout();
    return node;
  }

  #renderThoughts(): void {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    const parts = paragraphs(this.#thinking);
    for (let index = this.#paragraphs; index < parts.length; index++) {
      const line = this.#line("thought", undefined, index);
      line.append(el("span", "line-text"));
    }
    this.#paragraphs = Math.max(this.#paragraphs, parts.length);
    for (const { node, paragraph } of this.#lines) {
      if (paragraph === undefined) continue;
      const text = node.querySelector(".line-text");
      const line = thoughtLine(parts[paragraph] ?? "");
      if (text && text.textContent !== line) text.textContent = line;
    }
    this.onChange();
  }

  /** Shows the newest lines while live, everything once finished and opened. */
  #layout(): void {
    const all = this.#finished;
    const hidden = all ? 0 : Math.max(0, this.#lines.length - VISIBLE_LINES);
    this.#lines.forEach(({ node }, index) => {
      node.hidden = index < hidden;
      node.classList.toggle("current", index === this.#lines.length - 1);
    });
    this.#earlier.hidden = hidden === 0;
    this.#earlier.textContent = `+${hidden} earlier`;
  }

  #tick(): void {
    if (!this.#finished) this.#meta.textContent = formatSeconds(Date.now() - this.#started);
  }

  /** Kiki went back to work after it seemed to start answering: the feed goes live again. */
  resume(): void {
    if (!this.#finished) return;
    this.#finished = false;
    this.root.classList.remove("open");
    this.root.classList.replace("done", "live");
    this.#head.setAttribute("aria-expanded", "false");
    this.#full.hidden = true;
    this.#title.set(PHASE_TITLES.thinking);
    this.#timer = window.setInterval(() => this.#tick(), 1000);
    this.#layout();
    this.onChange();
  }

  /** The answer has started (or the turn ended): fold the feed into its summary line. */
  finish(): void {
    if (this.#finished) return;
    this.#renderThoughts();
    this.#finished = true;
    window.clearInterval(this.#timer);
    this.root.classList.replace("live", "done");
    this.#head.setAttribute("aria-expanded", "false");
    this.#title.set(`Thought for ${formatSeconds(Date.now() - this.#started)}`);
    const searches = this.#queries.size;
    const stats = [
      searches > 0 ? plural(searches, "search", "searches") : null,
      this.#hosts.size > 0 ? plural(this.#hosts.size, "source") : null,
      this.#scrolls > 0 ? plural(this.#scrolls, "scroll") : null,
      this.#clicks > 0 ? plural(this.#clicks, "click") : null,
    ].filter(Boolean);
    this.#meta.textContent = stats.length > 0 ? `· ${stats.join(" · ")}` : "";
    if (this.#thinking.trim()) this.#full.textContent = this.#thinking.trim();
    this.#layout();
    this.onChange();
  }

  #toggle(): void {
    if (!this.#finished) return;
    const open = this.root.classList.toggle("open");
    this.#head.setAttribute("aria-expanded", String(open));
    this.#full.hidden = !open || !this.#full.textContent;
    // Thought lines repeat the full text, so an opened feed shows only searches and reads.
    for (const { node, paragraph } of this.#lines) node.hidden = open && paragraph !== undefined && !this.#full.hidden;
    if (open) this.root.scrollIntoView({ block: "start", behavior: "smooth" });
  }
}
