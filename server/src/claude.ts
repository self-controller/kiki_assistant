import Anthropic from "@anthropic-ai/sdk";
import type { Activity, ErrorCode, KikiEvent, ModelChoice, Source, StatusPhase } from "@kiki/shared";
import type { UsageDelta } from "./codes.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";

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
const MAX_UNCITED_SOURCES = 5;
const MAX_RESULTS_SHOWN = 5;
// Keeps a fetched page to roughly the size of the nearby text we already send.
const FETCH_CONTENT_TOKENS = 8_000;

export type TurnResult =
  | {
      kind: "answered";
      /** Append these to the conversation unchanged. */
      assistantMessages: Anthropic.Beta.BetaMessageParam[];
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
}): Promise<TurnResult> {
  const { client, config, history, emit, signal } = options;
  const model = options.model ?? config.model;
  const effort = options.effort ?? config.effort;
  const thinking = hasAdaptiveThinking(model);
  const useFallbacks = config.fallbacks && !isHaiku(model);
  const assistantMessages: Anthropic.Beta.BetaMessageParam[] = [];
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

  for (let attempt = 0; ; attempt++) {
    setPhase("thinking");
    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: config.maxTokens,
        system: SYSTEM_PROMPT,
        messages: [...history, ...assistantMessages],
        tools: webTools(model, config),
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
    stream.on("text", (delta) => emit({ type: "text", delta }));

    const message = await stream.finalMessage();
    addUsage(usage, message.usage);

    if (message.stop_reason === "refusal") {
      return { kind: "refused", usage };
    }
    assistantMessages.push({ role: "assistant", content: message.content });
    // A long server-side search loop pauses; resend the turn as-is to let it continue.
    if (message.stop_reason === "pause_turn" && attempt < MAX_PAUSE_RESUMES) continue;

    return {
      kind: "answered",
      assistantMessages,
      stopReason: message.stop_reason ?? "end_turn",
      sources: sources.result(),
      usage,
    };
  }
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
