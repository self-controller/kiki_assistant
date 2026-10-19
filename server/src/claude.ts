import Anthropic from "@anthropic-ai/sdk";
import type {
  Activity,
  ErrorCode,
  KikiEvent,
  ModelChoice,
  AppToolName,
  Source,
  StatusPhase,
  ToolAccess,
  ToolResult,
} from "@kiki/shared";
import type { UsageDelta } from "./codes.ts";
import { screenBlocks, systemPrompt } from "./prompt.ts";
import {
  CHECK_LABELS,
  isCheckTool,
  isOpenTool,
  isProposalTool,
  isReadTool,
  isScreenTool,
  LOOKUP_LABELS,
  parseClick,
  parseProposal,
  parseScroll,
  parseSearch,
  PROPOSAL_ACK,
  scrollLabel,
  searchLabel,
  toolsFor,
} from "./tools.ts";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeConfig {
  /** The model for questions that don't pick one (older apps). */
  model: string;
  effort: Effort;
  /** Effort for questions asked with the Think toggle on. */
  thinkEffort: Effort;
  maxTokens: number;
  maxSearches: number;
  /** Pages Claude may fetch and read per answer; 0 turns web fetch off. */
  maxFetches: number;
  /** Server-side refusal fallback (`fallbacks: "default"`). Ignored for Haiku, which has none. */
  fallbacks: boolean;
}

export const DEFAULT_CLAUDE_CONFIG: ClaudeConfig = {
  model: "claude-opus-5-5",
  effort: "low",
  thinkEffort: "high",
  // Room for XHigh effort's thinking plus the answer; it's a cap, not a cost.
  maxTokens: 32_000,
  maxSearches: 3,
  maxFetches: 2,
  fallbacks: true,
};

/** The Claude model behind each choice in the composer's model picker. */
export const MODEL_IDS: Record<ModelChoice, string> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_PAUSE_RESUMES = 3;
/** Rounds of Kiki's own tools (cards and lookups) per answer; after that Claude must answer. */
const MAX_TOOL_ROUNDS = 4;
/** Scrolls, looks and clicks per answer. Rounds of only those don't count as tool rounds, while there are steps left. */
export const MAX_SCREEN_STEPS = 15;
const MAX_UNCITED_SOURCES = 5;
const MAX_RESULTS_SHOWN = 5;
// Keeps a fetched page to roughly the size of the nearby text we already send.
const FETCH_CONTENT_TOKENS = 8_000;

export type TurnResult =
  | {
      kind: "answered";
      /** Append these to the conversation unchanged: Claude's replies, and the results of Kiki's tools. */
      messages: Anthropic.Beta.BetaMessageParam[];
      stopReason: string;
      sources: Source[];
      usage: UsageDelta;
    }
  | { kind: "refused"; usage: UsageDelta };

export function emptyUsage(): UsageDelta {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 };
}

function addUsage(total: UsageDelta, usage: Anthropic.Beta.BetaUsage): void {
  total.inputTokens += usage.input_tokens;
  total.outputTokens += usage.output_tokens;
  total.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  total.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
  total.webSearches += usage.server_tool_use?.web_search_requests ?? 0;
}

function isHaiku(model: string): boolean {
  return model.startsWith("claude-haiku");
}

/** Adaptive thinking needs a Claude 5 model or Opus/Sonnet 4.6+; older models (Haiku 4.5) run without it. */
function hasAdaptiveThinking(model: string): boolean {
  const match = /^claude-[a-z]+-(\d+)(?:-(\d+))?/.exec(model);
  if (!match) return true;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major >= 5 || (major === 4 && minor >= 6 && !isHaiku(model));
}

function webTools(model: string, config: ClaudeConfig): Anthropic.Beta.BetaToolUnion[] {
  // The dynamic-filtering web tools need Opus/Sonnet 4.6 or newer; Haiku gets the basic ones.
  const basic = isHaiku(model);
  const tools: Anthropic.Beta.BetaToolUnion[] = [
    basic
      ? { type: "web_search_20250305", name: "web_search", max_uses: config.maxSearches }
      : { type: "web_search_20260209", name: "web_search", max_uses: config.maxSearches },
  ];
  if (config.maxFetches > 0) {
    const fetch = { max_uses: config.maxFetches, max_content_tokens: FETCH_CONTENT_TOKENS };
    tools.push(
      basic
        ? { type: "web_fetch_20250910", name: "web_fetch", ...fetch }
        : { type: "web_fetch_20260209", name: "web_fetch", ...fetch },
    );
  }
  return tools;
}

class SourceCollector {
  readonly #cited = new Map<string, string>();
  readonly #searched = new Map<string, string>();

  addCited(url: string, title: string | null): void {
    if (isWebUrl(url) && !this.#cited.has(url)) this.#cited.set(url, title || url);
  }

  addSearched(url: string, title: string | null): void {
    if (isWebUrl(url) && !this.#searched.has(url)) this.#searched.set(url, title || url);
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

function isWebUrl(url: string): boolean {
  return url.startsWith("https://") || url.startsWith("http://");
}

/**
 * Runs one user turn against Claude, streaming Kiki events through `emit`.
 * `history` must already end with the new user message; it is not modified.
 * Throws on API errors (see `classifyError`).
 */
export async function runTurn(options: {
  client: Anthropic;
  config: ClaudeConfig;
  history: Anthropic.Beta.BetaMessageParam[];
  emit: (event: KikiEvent) => void;
  signal?: AbortSignal;
  /** Overrides `config.model` for this turn (the model picker). */
  model?: string;
  /** Overrides `config.effort` for this turn (the effort button). */
  effort?: Effort;
  /** Which of Kiki's own tools the app handles. */
  tools?: ToolAccess;
  /** The personality the person chose, added to the end of the system prompt. */
  personality?: string;
  /** Runs a read tool in the app and waits for its result. */
  callTool?: (id: string, name: AppToolName, input: Record<string, unknown>) => Promise<ToolResult>;
}): Promise<TurnResult> {
  const { client, config, history, emit, signal } = options;
  const model = options.model ?? config.model;
  const effort = options.effort ?? config.effort;
  const thinking = hasAdaptiveThinking(model);
  const useFallbacks = config.fallbacks && !isHaiku(model);
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  const tools = [...webTools(model, config), ...toolsFor(options.tools)];
  const system = systemPrompt(options.personality);
  let pauses = 0;
  let toolRounds = 0;
  const screen = { steps: 0 };
  /** Answer text the current response has streamed. */
  let responseChars = 0;
  const sources = new SourceCollector();
  const usage = emptyUsage();
  let phase: StatusPhase | null = null;
  let thoughtBlocks = 0;

  const setPhase = (next: StatusPhase, query?: string) => {
    if (next === phase && query === undefined) return;
    phase = next;
    emit(query === undefined ? { type: "status", phase: next } : { type: "status", phase: next, query });
  };
  const activity = (item: Activity) => emit({ type: "activity", activity: item });
  const text = (delta: string) => {
    responseChars += delta.length;
    emit({ type: "text", delta });
  };

  for (;;) {
    setPhase("thinking");
    responseChars = 0;
    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: config.maxTokens,
        system,
        messages: [...history, ...messages],
        tools,
        // Out of tool rounds: Claude answers with what it has.
        ...(toolRounds >= MAX_TOOL_ROUNDS ? { tool_choice: { type: "none" as const } } : {}),
        // Summaries of the reasoning (and the notes between tool calls) feed the popup's thinking feed.
        ...(thinking ? { thinking: { type: "adaptive" as const, display: "summarized" as const } } : {}),
        output_config: { effort },
        // Caches the conversation so far; follow-ups reread the page context from cache.
        cache_control: { type: "ephemeral" },
        ...(useFallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      },
      { signal },
    );

    stream.on("streamEvent", (event) => {
      if (event.type !== "content_block_start") return;
      const block = event.content_block;
      if (block.type === "server_tool_use") {
        // web_search, plus the code execution it uses under the hood to filter results.
        if (block.name !== "web_fetch") setPhase("searching");
      } else if (block.type === "thinking") {
        // A blank line between summary blocks, so the popup can tell them apart.
        if (thoughtBlocks++ > 0) emit({ type: "thinking", delta: "\n\n" });
      } else if (block.type === "text") {
        setPhase("writing");
      } else if (
        block.type === "tool_use" &&
        (isProposalTool(block.name) || isReadTool(block.name) || isOpenTool(block.name) || isScreenTool(block.name))
      ) {
        // What Claude wrote before using a tool was notes on its way there, not the answer.
        if (responseChars > 0) {
          emit({ type: "notes", chars: responseChars });
          responseChars = 0;
        }
        setPhase("thinking");
      }
    });
    stream.on("thinking", (delta) => {
      if (delta) emit({ type: "thinking", delta });
    });
    stream.on("contentBlock", (block) => {
      if (block.type === "server_tool_use" && block.name === "web_search") {
        const query = block.input["query"];
        if (typeof query === "string" && query) {
          setPhase("searching", query);
          activity({ kind: "search", query });
        }
      } else if (block.type === "server_tool_use" && block.name === "web_fetch") {
        const url = block.input["url"];
        if (typeof url === "string" && isWebUrl(url)) activity({ kind: "read", url });
      } else if (block.type === "web_search_tool_result") {
        if (Array.isArray(block.content)) {
          const found: Source[] = [];
          for (const result of block.content) {
            sources.addSearched(result.url, result.title);
            if (isWebUrl(result.url)) found.push({ url: result.url, title: result.title || result.url });
          }
          if (found.length > 0) activity({ kind: "results", sources: found.slice(0, MAX_RESULTS_SHOWN) });
        }
        setPhase("thinking");
      } else if (block.type === "web_fetch_tool_result") {
        if (block.content.type === "web_fetch_result" && isWebUrl(block.content.url)) {
          const title = block.content.content.title ?? undefined;
          sources.addSearched(block.content.url, title ?? null);
          activity(title ? { kind: "read", url: block.content.url, title } : { kind: "read", url: block.content.url });
        }
        setPhase("thinking");
      }
    });
    stream.on("citation", (citation) => {
      if (citation.type === "web_search_result_location") {
        sources.addCited(citation.url, citation.title);
      }
    });
    stream.on("text", (delta) => text(delta));

    const message = await stream.finalMessage();
    addUsage(usage, message.usage);

    if (message.stop_reason === "refusal") {
      return { kind: "refused", usage };
    }
    messages.push({ role: "assistant", content: message.content });
    // A long server-side search loop pauses; resend the turn as-is to let it continue.
    if (message.stop_reason === "pause_turn" && pauses++ < MAX_PAUSE_RESUMES) continue;
    if (message.stop_reason === "tool_use") {
      // Scrolling and clicking through a window takes many rounds; they don't use up the ones for cards and lookups.
      const uses = message.content.filter((block) => block.type === "tool_use");
      if (!(uses.every((block) => isScreenTool(block.name)) && screen.steps < MAX_SCREEN_STEPS)) toolRounds++;
      messages.push({ role: "user", content: await runKikiTools(message.content, emit, options.callTool, screen) });
      continue;
    }

    return {
      kind: "answered",
      messages,
      stopReason: message.stop_reason ?? "end_turn",
      sources: sources.result(),
      usage,
    };
  }
}

/**
 * Answers every client tool call in `content`: proposals become cards; reads, searches, scrolls and clicks go
 * to the app. `screen` counts the answer's scrolls, looks and clicks.
 */
async function runKikiTools(
  content: Anthropic.Beta.BetaContentBlock[],
  emit: (event: KikiEvent) => void,
  callTool: Parameters<typeof runTurn>[0]["callTool"],
  screen: { steps: number },
): Promise<Anthropic.Beta.BetaToolResultBlockParam[]> {
  const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
  const answer = (id: string, text: string, isError = false) =>
    results.push({ type: "tool_result", tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) });

  for (const block of content) {
    if (block.type !== "tool_use") continue;
    const input = (block.input ?? {}) as Record<string, unknown>;
    if (isProposalTool(block.name)) {
      const parsed = parseProposal(block.name, input);
      if ("error" in parsed) {
        answer(block.id, parsed.error, true);
        continue;
      }
      if (isCheckTool(block.name) && callTool) {
        // The app checks it against the text (or form) as it is now; an error goes back to Claude to fix.
        emit({ type: "activity", activity: { kind: "lookup", label: CHECK_LABELS[block.name] } });
        emit({ type: "tool_call", id: block.id, name: block.name, input: { ...parsed.action } });
        const checked = await callTool(block.id, block.name, { ...parsed.action });
        if (checked.isError) {
          answer(block.id, checked.content, true);
          continue;
        }
      }
      emit({ type: "action", action: parsed.action });
      answer(block.id, PROPOSAL_ACK);
    } else if (isReadTool(block.name) && callTool) {
      emit({ type: "activity", activity: { kind: "lookup", label: LOOKUP_LABELS[block.name] } });
      emit({ type: "tool_call", id: block.id, name: block.name, input });
      const result = await callTool(block.id, block.name, input);
      answer(block.id, result.content, result.isError);
    } else if (isOpenTool(block.name) && callTool) {
      const parsed = parseSearch(input);
      if ("error" in parsed) {
        answer(block.id, parsed.error, true);
        continue;
      }
      const { search } = parsed;
      emit({ type: "activity", activity: { kind: "open", label: searchLabel(search), query: search.query } });
      emit({ type: "tool_call", id: block.id, name: block.name, input: { ...search } });
      const result = await callTool(block.id, block.name, { ...search });
      answer(block.id, result.content, result.isError);
    } else if (isScreenTool(block.name) && callTool) {
      const parsed = block.name === "click" ? parseClick(input) : block.name === "scroll" ? parseScroll(input) : { scroll: null };
      if ("error" in parsed) {
        answer(block.id, parsed.error, true);
        continue;
      }
      if (screen.steps >= MAX_SCREEN_STEPS) {
        answer(block.id, `That's as far as Kiki scrolls and clicks for one answer: answer with what you've seen, or use another tool.`, true);
        continue;
      }
      screen.steps++;
      const call = "click" in parsed ? { ...parsed.click } : parsed.scroll ? { ...parsed.scroll } : {};
      // The app says what a click presses itself, from what it read on the control, not Claude's id for it.
      if (!("click" in parsed)) emit({ type: "activity", activity: { kind: "scroll", label: scrollLabel(parsed.scroll) } });
      emit({ type: "tool_call", id: block.id, name: block.name, input: call });
      const result = await callTool(block.id, block.name, call);
      if (result.isError) answer(block.id, result.content, true);
      else results.push({ type: "tool_result", tool_use_id: block.id, content: screenBlocks(result) });
    } else {
      answer(block.id, `The tool ${block.name} isn't available.`, true);
    }
  }
  return results;
}

export interface ClassifiedError {
  code: ErrorCode;
  message: string;
  /** The request never produced billable output, so don't count it against the daily limit. */
  refundable: boolean;
  aborted: boolean;
  /** Something the server operator should see in the logs. */
  log: boolean;
}

export function classifyError(error: unknown): ClassifiedError {
  const base = { refundable: true, aborted: false, log: false };
  if (error instanceof Anthropic.APIUserAbortError) {
    return { ...base, code: "internal", message: "Request cancelled.", aborted: true };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { ...base, code: "busy", message: "Kiki is getting a lot of requests right now. Try again in a moment." };
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return { ...base, code: "upstream", message: "Kiki's server is not set up correctly. Let the person who runs it know.", log: true };
  }
  if (error instanceof Anthropic.BadRequestError) {
    return { ...base, code: "upstream", message: "Claude could not process this request.", log: true };
  }
  if (error instanceof Anthropic.InternalServerError) {
    return { ...base, code: "upstream", message: "Claude is temporarily unavailable. Try again shortly." };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { ...base, code: "upstream", message: "Kiki's server could not reach Claude. Try again." };
  }
  if (error instanceof Anthropic.APIError) {
    return { ...base, code: "upstream", message: "Claude returned an error. Try again.", log: true };
  }
  return { ...base, code: "internal", message: "Something went wrong on Kiki's server.", log: true };
}
