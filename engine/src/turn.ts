// What every provider's turn shares: the options it runs with, the events it streams to the popup, the
// sources it collects, and Kiki's own tools, which run the same way whichever model calls them.
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { Activity, AppToolName, KikiEvent, Provider, Source, StatusPhase, ToolAccess, ToolResult } from "@kiki/shared";
import type { ClaudeConfig, Effort } from "./claude.ts";
import { screenBlocks } from "./prompt.ts";
import {
  CHECK_LABELS,
  isCheckTool,
  isOpenTool,
  isProposalTool,
  isReadTool,
  isTargetTool,
  LOOKUP_LABELS,
  parseProposal,
  parseSearch,
  parseTargetCall,
  PROPOSAL_ACK,
  searchLabel,
  type TargetCall,
} from "./tools.ts";

/** Rounds of Kiki's own tools (cards and lookups) per answer; after that the model must answer. */
export const MAX_TOOL_ROUNDS = 4;
/**
 * Screen steps per answer: scrolls, looks, clicks, acts, pages opened and windows switched to. Rounds of only
 * those don't count as tool rounds, while there are steps left.
 */
export const MAX_SCREEN_STEPS = 20;
/** Clicks per answer, within those steps (an act's clicks count): each one can open another page. */
export const MAX_CLICKS = 10;
/** Pages opened in Kiki's browser per answer. */
export const MAX_OPENS = 6;
/** Windows switched to (or apps started) per answer. */
export const MAX_SWITCHES = 4;
/** What the model is told when it clicks past the limit. */
export const OUT_OF_CLICKS = "That's as many clicks as Kiki makes for one answer: answer with what you've seen, or scroll and look instead.";
export const OUT_OF_STEPS = "That's as far as Kiki scrolls, clicks and browses for one answer: answer with what you've seen, or use another tool.";
export const OUT_OF_OPENS = "That's as many pages as Kiki opens for one answer: go on in the pages you have, or answer with what you've seen.";
export const OUT_OF_SWITCHES = "That's as many windows as Kiki switches to for one answer: work in the one you're on, or answer.";
const MAX_UNCITED_SOURCES = 5;
const MAX_RESULTS_SHOWN = 5;

/** Tokens and searches a turn used, for the log. */
export interface UsageDelta {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
}

export type CallTool = (id: string, name: AppToolName, input: Record<string, unknown>) => Promise<ToolResult>;

/** One user turn, for any provider. `history` must already end with the new user message; it is not modified. */
export interface TurnOptions {
  config: ClaudeConfig;
  history: Anthropic.Beta.BetaMessageParam[];
  emit: (event: KikiEvent) => void;
  signal?: AbortSignal;
  /** The model that answers: the composer's pick, as the route's provider names it. */
  model: string;
  /** Overrides `config.effort` for this turn (the effort button). */
  effort?: Effort;
  /** Which of Kiki's own tools the app handles. */
  tools?: ToolAccess;
  /** The personality the person chose, added to the end of the system prompt. */
  personality?: string;
  /** Runs a read tool in the app and waits for its result. */
  callTool?: CallTool;
  /** The conversation the turn belongs to, so a provider can keep its requests together in its prompt cache. */
  conversationId?: string;
  /** The agent's session (Claude Code, Codex) that holds all of `history` but its last message, to continue it. */
  agent?: AgentSession;
}

/** A conversation's session with an agent (Claude Code or Codex), which follow-ups continue. */
export interface AgentSession {
  provider: Provider;
  /** Claude Code's session id, or Codex's thread id. */
  id: string;
  /** What the session was started with (instructions, tools); one started with others can't be continued. */
  key: string;
}

export type TurnResult =
  | {
      kind: "answered";
      /**
       * Append these to the conversation unchanged: the model's replies, and the results of Kiki's tools. Every
       * provider returns them as Claude messages, so a conversation can switch models between turns.
       */
      messages: Anthropic.Beta.BetaMessageParam[];
      stopReason: string;
      sources: Source[];
      usage: UsageDelta;
      /** The agent's session, which now holds the conversation up to this answer. */
      agent?: AgentSession;
    }
  | { kind: "refused"; usage: UsageDelta };

export function emptyUsage(): UsageDelta {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 };
}

/** Runs `run` when `signal` aborts, right away if it already has; the returned function stops listening. */
export function whenAborted(signal: AbortSignal | undefined, run: () => void): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    run();
    return () => {};
  }
  signal.addEventListener("abort", run);
  return () => signal.removeEventListener("abort", run);
}

/** A base64 image as a data URL, for providers that take images that way. */
export function dataUrl(source: Anthropic.Beta.BetaBase64ImageSource): string {
  return `data:${source.media_type};base64,${source.data}`;
}

type ResultPart = { type: "text"; text: string } | { type: "image"; source: Anthropic.Beta.BetaBase64ImageSource };

/** A tool result's content as parts: its text, and the screenshots a scroll or look brought back. */
export function resultParts(content: Anthropic.Beta.BetaToolResultBlockParam["content"]): ResultPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return (content ?? []).flatMap((part): ResultPart[] => {
    if (part.type === "text") return [{ type: "text", text: part.text }];
    if (part.type === "image" && part.source.type === "base64") return [{ type: "image", source: part.source }];
    return [];
  });
}

/** A tool call's arguments as the model sent them (JSON text, or already an object); {} when they're unusable. */
export function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value || "{}");
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function isWebUrl(url: string): boolean {
  return url.startsWith("https://") || url.startsWith("http://");
}

export class SourceCollector {
  readonly #cited = new Map<string, string>();
  readonly #searched = new Map<string, string>();

  addCited(url: string, title: string | null | undefined): void {
    if (isWebUrl(url) && !this.#cited.has(url)) this.#cited.set(url, title || url);
  }

  addSearched(url: string, title: string | null | undefined): void {
    if (isWebUrl(url) && !this.#searched.has(url)) this.#searched.set(url, title || url);
  }

  /** Every page found so far, cited or searched. */
  urls(): string[] {
    return [...this.#cited.keys(), ...this.#searched.keys()];
  }

  /** Cited sources if the answer cites any, otherwise the top search results. */
  result(): Source[] {
    const entries =
      this.#cited.size > 0
        ? [...this.#cited]
        : [...this.#searched].slice(0, MAX_UNCITED_SOURCES);
    return entries.map(([url, title]) => ({ url, title }));
  }
}

/** What a turn streams to the popup: its phase, activity, answer text, thinking, and notes on the way to a tool. */
export class TurnFeed {
  readonly emit: (event: KikiEvent) => void;
  #phase: StatusPhase | null = null;
  /** Answer text the current response has streamed. */
  #responseChars = 0;
  #thoughtBlocks = 0;

  constructor(emit: (event: KikiEvent) => void) {
    this.emit = emit;
  }

  phase(next: StatusPhase, query?: string): void {
    if (next === this.#phase && query === undefined) return;
    this.#phase = next;
    this.emit(query === undefined ? { type: "status", phase: next } : { type: "status", phase: next, query });
  }

  activity(item: Activity): void {
    this.emit({ type: "activity", activity: item });
  }

  /** The model searches the web for `query`. */
  search(query: string): void {
    this.phase("searching", query);
    this.activity({ kind: "search", query });
  }

  /** What a search found: its web pages go to `sources`, and the first few to the popup. */
  results(found: Array<{ url?: unknown; title?: unknown }>, sources: SourceCollector): void {
    const pages: Source[] = [];
    for (const { url, title } of found) {
      if (typeof url !== "string") continue;
      const name = typeof title === "string" ? title : null;
      sources.addSearched(url, name);
      if (isWebUrl(url)) pages.push({ url, title: name || url });
    }
    if (pages.length > 0) this.activity({ kind: "results", sources: pages.slice(0, MAX_RESULTS_SHOWN) });
  }

  /** The model reads the web page at `url`, titled `title` when that's known. */
  read(url: string, title?: string): void {
    if (isWebUrl(url)) this.activity(title ? { kind: "read", url, title } : { kind: "read", url });
  }

  /** A new request to the model: it's thinking, and what it writes next is the answer until it uses a tool. */
  startResponse(): void {
    this.phase("thinking");
    this.#responseChars = 0;
  }

  text(delta: string): void {
    this.#responseChars += delta.length;
    this.emit({ type: "text", delta });
  }

  /** A new block of the reasoning summary, after a blank line so the popup can tell them apart. */
  thinkingBlock(): void {
    if (this.#thoughtBlocks++ > 0) this.emit({ type: "thinking", delta: "\n\n" });
  }

  thinking(delta: string): void {
    if (delta) this.emit({ type: "thinking", delta });
  }

  /** The model is using one of Kiki's tools: what it wrote before was notes on its way there, not the answer. */
  toolStarting(): void {
    if (this.#responseChars > 0) {
      this.emit({ type: "notes", chars: this.#responseChars });
      this.#responseChars = 0;
    }
    this.phase("thinking");
  }
}

/** How much of the answer's screen budget is used: steps in all, and the clicks, pages and window switches among them. */
export interface ScreenSteps {
  steps: number;
  clicks?: number;
  opens?: number;
  switches?: number;
}

/** Target tools that cost nothing: a list of windows, and showing or keeping the browser. */
const FREE_TARGET_TOOLS = new Set(["list_windows", "browser"]);

/** Why the model can't make this target call now (a limit), or null when it can. */
export function targetLimit(name: string, call: TargetCall, screen: ScreenSteps): string | null {
  if (!FREE_TARGET_TOOLS.has(name) && screen.steps >= MAX_SCREEN_STEPS) return OUT_OF_STEPS;
  if (call.clicks > 0 && (screen.clicks ?? 0) + call.clicks > MAX_CLICKS) {
    const left = MAX_CLICKS - (screen.clicks ?? 0);
    return left > 0 ? `That would be more than Kiki's ${MAX_CLICKS} clicks for one answer: ${left} left. Make it fewer.` : OUT_OF_CLICKS;
  }
  if (name === "open_url" && (screen.opens ?? 0) >= MAX_OPENS) return OUT_OF_OPENS;
  if ((name === "use_window" || name === "open_app") && (screen.switches ?? 0) >= MAX_SWITCHES) return OUT_OF_SWITCHES;
  return null;
}

/** Counts a target call that's about to run against the answer's budget. */
export function countTarget(name: string, call: TargetCall, screen: ScreenSteps): void {
  if (!FREE_TARGET_TOOLS.has(name)) screen.steps++;
  if (call.clicks > 0) screen.clicks = (screen.clicks ?? 0) + call.clicks;
  if (name === "open_url") screen.opens = (screen.opens ?? 0) + 1;
  if (name === "use_window" || name === "open_app") screen.switches = (screen.switches ?? 0) + 1;
}

/** One of Kiki's own tools, called by the model. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A tool call's id as Claude accepts it (letters, digits, _ and -), so a conversation can switch models. */
export function canonicalToolId(id: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : `toolu_${randomUUID().replaceAll("-", "")}`;
}

/** Kiki's tools the turn streams as it goes: proposals, reads, searches, and what works on the screen. */
export function isKikiTool(name: string): boolean {
  return isProposalTool(name) || isReadTool(name) || isOpenTool(name) || isTargetTool(name);
}

/**
 * Whether a round of `calls` uses up one of the answer's tool rounds. Scrolling, clicking and browsing take
 * many rounds, so they don't use up the ones for cards and lookups while there are screen steps left.
 */
export function usesToolRound(calls: ToolCall[], screen: ScreenSteps): boolean {
  return !(calls.every((call) => isTargetTool(call.name)) && screen.steps < MAX_SCREEN_STEPS);
}

/**
 * Answers every call to Kiki's tools: proposals become cards; reads, searches, scrolls and clicks go to the
 * app. `screen` counts the answer's scrolls, looks and clicks. A round's reads and searches run together;
 * cards and screen steps go one at a time, in order. Once `signal` aborts, the rest are answered "Cancelled."
 */
export async function runKikiTools(
  calls: ToolCall[],
  emit: (event: KikiEvent) => void,
  callTool: CallTool | undefined,
  screen: ScreenSteps,
  signal?: AbortSignal,
): Promise<Anthropic.Beta.BetaToolResultBlockParam[]> {
  const answer = (id: string, text: string, isError = false): Anthropic.Beta.BetaToolResultBlockParam => ({
    type: "tool_result",
    tool_use_id: id,
    content: text,
    ...(isError ? { is_error: true } : {}),
  });
  /** Has the app run the tool, after telling the popup. */
  const ask = (id: string, name: AppToolName, input: Record<string, unknown>) => {
    emit({ type: "tool_call", id, name, input });
    return callTool!(id, name, input);
  };

  const run = async ({ id, name, input }: ToolCall): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
    if (signal?.aborted) return answer(id, "Cancelled.", true);
    if (isProposalTool(name)) {
      const parsed = parseProposal(name, input);
      if ("error" in parsed) return answer(id, parsed.error, true);
      if (isCheckTool(name) && callTool) {
        // The app checks it against the text (or form) as it is now; an error goes back to the model to fix.
        if (name !== "propose_edit") emit({ type: "activity", activity: { kind: "lookup", label: CHECK_LABELS[name] } });
        const checked = await ask(id, name, { ...parsed.action });
        if (checked.applied) {
          // "Act without asking": the app applied it. The card shows as done, and what happened is the result.
          emit({ type: "action", action: parsed.action });
          return checked.isError ? answer(id, checked.content, true) : { type: "tool_result", tool_use_id: id, content: screenBlocks(checked) };
        }
        if (checked.isError) return answer(id, checked.content, true);
      }
      emit({ type: "action", action: parsed.action });
      return answer(id, PROPOSAL_ACK);
    }
    if (isReadTool(name) && callTool) {
      emit({ type: "activity", activity: { kind: "lookup", label: LOOKUP_LABELS[name] } });
      const result = await ask(id, name, input);
      return answer(id, result.content, result.isError);
    }
    if (isOpenTool(name) && callTool) {
      const parsed = parseSearch(input);
      if ("error" in parsed) return answer(id, parsed.error, true);
      const { search } = parsed;
      emit({ type: "activity", activity: { kind: "open", label: searchLabel(search), query: search.query } });
      const result = await ask(id, name, { ...search });
      return answer(id, result.content, result.isError);
    }
    if (isTargetTool(name) && callTool) {
      const parsed = parseTargetCall(name, input);
      if ("error" in parsed) return answer(id, parsed.error, true);
      const limit = targetLimit(name, parsed, screen);
      if (limit) return answer(id, limit, true);
      countTarget(name, parsed, screen);
      if (parsed.activity) emit({ type: "activity", activity: parsed.activity });
      const result = await ask(id, name, parsed.input);
      // A step that failed may still show the screen as it is now, so the model can go on without looking again.
      if (result.isError) return result.screen ? { type: "tool_result", tool_use_id: id, content: screenBlocks(result), is_error: true } : answer(id, result.content, true);
      return { type: "tool_result", tool_use_id: id, content: screenBlocks(result) };
    }
    return answer(id, `The tool ${name} isn't available.`, true);
  };

  const results = new Array<Anthropic.Beta.BetaToolResultBlockParam>(calls.length);
  const settle = (index: number) =>
    run(calls[index]!).then((result) => {
      results[index] = result;
    });
  let together: Promise<void>[] = [];
  for (const [index, { name }] of calls.entries()) {
    if ((isReadTool(name) || isOpenTool(name)) && callTool) {
      together.push(settle(index));
      continue;
    }
    await Promise.all(together);
    together = [];
    await settle(index);
  }
  await Promise.all(together);
  return results;
}

/** What an agent's model (Claude Code, Codex) is told when it calls Kiki's tools past the answer's limit. */
export const OUT_OF_TOOL_ROUNDS = "That's all the tool use for one answer: answer now with what you have.";

/**
 * Kiki's tool limits for an agent (Claude Code, Codex), which runs its own loop: Kiki can't take the
 * tools away for the last request, so it refuses calls past the limit instead, and the model answers.
 */
export class ToolBudget {
  /** Scrolls, looks and clicks so far, which `runKikiTools` counts and limits. */
  readonly screen: ScreenSteps = { steps: 0, clicks: 0 };
  #rounds = 0;
  #counted = false;

  /** A new response from the model: its first call to a card or lookup tool uses up a round. */
  newResponse(): void {
    this.#counted = false;
  }

  /** Null when the model may call `name` now; otherwise the error to give it. */
  check(name: string): string | null {
    // Scrolling, clicking and browsing don't use up rounds while there are screen steps left (see `usesToolRound`).
    if (isTargetTool(name) && this.screen.steps < MAX_SCREEN_STEPS) return null;
    if (this.#counted) return null;
    if (this.#rounds >= MAX_TOOL_ROUNDS) return OUT_OF_TOOL_ROUNDS;
    this.#rounds++;
    this.#counted = true;
    return null;
  }
}

/**
 * The Claude messages an agent's turn returns: each response's text and calls to Kiki's tools, then those
 * calls' results. The agent's own web tools and its thinking stay with it. Responses are kept apart until
 * the end because an agent may finish one call before it has reported another of the same response.
 */
export class TurnTranscript {
  readonly #responses: Anthropic.Beta.BetaContentBlockParam[][] = [[]];
  readonly #results = new Map<string, Anthropic.Beta.BetaToolResultBlockParam>();

  newResponse(): void {
    if (this.#responses.at(-1)!.length > 0) this.#responses.push([]);
  }

  text(text: string): void {
    if (!text) return;
    const content = this.#responses.at(-1)!;
    const last = content.at(-1);
    if (last?.type === "text") content[content.length - 1] = { type: "text", text: last.text + text };
    else content.push({ type: "text", text });
  }

  toolUse(call: ToolCall): void {
    this.#responses.at(-1)!.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
  }

  result(result: Anthropic.Beta.BetaToolResultBlockParam): void {
    this.#results.set(result.tool_use_id, result);
  }

  messages(): Anthropic.Beta.BetaMessageParam[] {
    const messages: Anthropic.Beta.BetaMessageParam[] = [];
    for (const content of this.#responses) {
      if (content.length === 0) continue;
      const last = messages.at(-1);
      // A response without Kiki's tools (text before a web search) joins the next one's message.
      if (last?.role === "assistant" && Array.isArray(last.content)) last.content.push(...content);
      else messages.push({ role: "assistant", content: [...content] });
      const calls = content.flatMap((block) => (block.type === "tool_use" ? [block.id] : []));
      if (calls.length === 0) continue;
      messages.push({
        role: "user",
        content: calls.map(
          (id) => this.#results.get(id) ?? { type: "tool_result", tool_use_id: id, content: "Cancelled.", is_error: true },
        ),
      });
    }
    return messages;
  }
}

/**
 * Answers an agent's (Claude Code's, Codex's) call to one of Kiki's tools: a refusal past the answer's
 * budget, else the tool's result. Either way the transcript keeps it.
 */
export async function runAgentTool(
  call: ToolCall,
  budget: ToolBudget,
  transcript: TurnTranscript,
  { emit, callTool, signal }: TurnOptions,
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const refusal = budget.check(call.name);
  const answer = refusal
    ? { type: "tool_result" as const, tool_use_id: call.id, content: refusal, is_error: true }
    : (await runKikiTools([call], emit, callTool, budget.screen, signal))[0]!;
  transcript.result(answer);
  return answer;
}
