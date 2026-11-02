import Anthropic from "@anthropic-ai/sdk";
import type { ErrorCode } from "@kiki/shared";
import { systemPrompt } from "./prompt.ts";
import { toolsFor } from "./tools.ts";
import {
  emptyUsage,
  isKikiTool,
  MAX_TOOL_ROUNDS,
  runKikiTools,
  SourceCollector,
  TurnFeed,
  usesToolRound,
  type TurnOptions,
  type TurnResult,
  type UsageDelta,
} from "./turn.ts";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeConfig {
  /** The model for questions that don't pick one. */
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

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_PAUSE_RESUMES = 3;
// Keeps a fetched page to roughly the size of the nearby text we already send.
const FETCH_CONTENT_TOKENS = 8_000;

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
export function hasAdaptiveThinking(model: string): boolean {
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

/**
 * Runs one user turn against Claude, streaming Kiki events through `emit`.
 * `history` must already end with the new user message; it is not modified.
 * Throws on API errors (see `classifyAnthropicError`).
 */
export async function runTurn(options: TurnOptions & { client: Anthropic }): Promise<TurnResult> {
  const { client, config, history, emit, signal, model } = options;
  const effort = options.effort ?? config.effort;
  const thinking = hasAdaptiveThinking(model);
  const useFallbacks = config.fallbacks && !isHaiku(model);
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  const tools = [...webTools(model, config), ...toolsFor(options.tools)];
  const system = systemPrompt(options.personality);
  let pauses = 0;
  let toolRounds = 0;
  const screen = { steps: 0 };
  const sources = new SourceCollector();
  const usage = emptyUsage();
  const feed = new TurnFeed(emit);

  for (;;) {
    feed.startResponse();
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
        if (block.name !== "web_fetch") feed.phase("searching");
      } else if (block.type === "thinking") {
        feed.thinkingBlock();
      } else if (block.type === "text") {
        feed.phase("writing");
      } else if (block.type === "tool_use" && isKikiTool(block.name)) {
        feed.toolStarting();
      }
    });
    stream.on("thinking", (delta) => feed.thinking(delta));
    stream.on("contentBlock", (block) => {
      if (block.type === "server_tool_use" && block.name === "web_search") {
        const query = block.input["query"];
        if (typeof query === "string" && query) feed.search(query);
      } else if (block.type === "server_tool_use" && block.name === "web_fetch") {
        const url = block.input["url"];
        if (typeof url === "string") feed.read(url);
      } else if (block.type === "web_search_tool_result") {
        if (Array.isArray(block.content)) feed.results(block.content, sources);
        feed.phase("thinking");
      } else if (block.type === "web_fetch_tool_result") {
        if (block.content.type === "web_fetch_result") {
          const title = block.content.content.title ?? undefined;
          sources.addSearched(block.content.url, title);
          feed.read(block.content.url, title);
        }
        feed.phase("thinking");
      }
    });
    stream.on("citation", (citation) => {
      if (citation.type === "web_search_result_location") {
        sources.addCited(citation.url, citation.title);
      }
    });
    stream.on("text", (delta) => feed.text(delta));

    const message = await stream.finalMessage();
    addUsage(usage, message.usage);

    if (message.stop_reason === "refusal") {
      return { kind: "refused", usage };
    }
    messages.push({ role: "assistant", content: message.content });
    // A long server-side search loop pauses; resend the turn as-is to let it continue.
    if (message.stop_reason === "pause_turn" && pauses++ < MAX_PAUSE_RESUMES) continue;
    if (message.stop_reason === "tool_use") {
      const calls = message.content
        .filter((block) => block.type === "tool_use")
        .map((block) => ({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> }));
      if (usesToolRound(calls, screen)) toolRounds++;
      messages.push({ role: "user", content: await runKikiTools(calls, emit, options.callTool, screen, signal) });
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

export interface ClassifiedError {
  code: ErrorCode;
  message: string;
  aborted: boolean;
  /** Something worth a line in Kiki's log. */
  log: boolean;
}

/** A failed question on the person's own Anthropic API key, in words for them. */
export function classifyAnthropicError(error: unknown): ClassifiedError {
  const base = { aborted: false, log: false };
  if (error instanceof Anthropic.APIUserAbortError) {
    return { ...base, code: "internal", message: "Request cancelled.", aborted: true };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { ...base, code: "busy", message: "Your Anthropic API key hit its rate limit. Try again in a moment." };
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return { ...base, code: "unauthorized", message: "Anthropic didn't accept your API key. Check it in Kiki's Settings › Models." };
  }
  if (error instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(error.message)) {
      return { ...base, code: "limit", message: "Your Anthropic account is out of API credits. Add some at platform.claude.com." };
    }
    return { ...base, code: "upstream", message: "Claude could not process this request.", log: true };
  }
  if (error instanceof Anthropic.InternalServerError) {
    return { ...base, code: "upstream", message: "Claude is temporarily unavailable. Try again shortly." };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { ...base, code: "upstream", message: "Kiki couldn't reach Claude. Check your connection." };
  }
  if (error instanceof Anthropic.APIError) {
    return { ...base, code: "upstream", message: "Claude returned an error. Try again.", log: true };
  }
  return { ...base, code: "internal", message: "Something went wrong in Kiki.", log: true };
}
