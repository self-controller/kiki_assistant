// Gemini, through Google's Interactions API: the API that lets Google Search run alongside Kiki's own tools.
// It runs on the person's own Gemini API key, and nothing is stored with Google (`store: false`), so every
// request carries the whole conversation.
import type Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, type Interactions } from "@google/genai";
import type { Effort } from "./claude.ts";
import { blocksOf, systemPrompt } from "./prompt.ts";
import { toolsFor } from "./tools.ts";
import {
  canonicalToolId,
  emptyUsage,
  isKikiTool,
  MAX_TOOL_ROUNDS,
  resultParts,
  runKikiTools,
  SourceCollector,
  TurnFeed,
  usesToolRound,
  type ToolCall,
  type TurnOptions,
  type TurnResult,
  type UsageDelta,
} from "./turn.ts";

type Step = Interactions.Step;
type Content = Interactions.Content;
export type GeminiStreamParams = Omit<Interactions.CreateModelInteractionParamsStreaming, "stream">;

/** The part of Google's client Kiki uses, so tests can stand in for it. */
export interface GeminiClient {
  stream(params: GeminiStreamParams, signal?: AbortSignal): Promise<AsyncIterable<Interactions.InteractionSSEEvent>>;
}

export function geminiClient(apiKey: string): GeminiClient {
  const client = new GoogleGenAI({ apiKey });
  return {
    stream: (params, signal) => client.interactions.create({ ...params, stream: true }, { fetchOptions: { signal } }),
  };
}

/** An interaction that ended in an error, with what Google said. */
export class GeminiTurnError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GeminiTurnError";
    this.status = status;
  }
}

/** Gemini thinks at low, medium or high; XHigh and Max become high. */
export function geminiThinkingLevel(effort: Effort): "low" | "medium" | "high" {
  return effort === "low" || effort === "medium" ? effort : "high";
}

const BLOCKED = /safety|blocked|prohibited|recitation|harm/i;

function addUsage(total: UsageDelta, usage: Interactions.Usage | undefined): void {
  if (!usage) return;
  const cached = usage.total_cached_tokens ?? 0;
  total.inputTokens += Math.max(0, (usage.total_input_tokens ?? 0) - cached);
  total.outputTokens += (usage.total_output_tokens ?? 0) + (usage.total_thought_tokens ?? 0);
  total.cacheReadTokens += cached;
  for (const tool of usage.grounding_tool_count ?? []) {
    if (tool.type === "google_search") total.webSearches += tool.count ?? 0;
  }
}

/** A tool result's content (text, and screenshots from scrolls) as Gemini reads it. */
function resultContent(content: Anthropic.Beta.BetaToolResultBlockParam["content"]): Interactions.FunctionResultStep["result"] {
  const items: Content[] = resultParts(content ?? "").map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : { type: "image" as const, data: part.source.data, mime_type: part.source.media_type },
  );
  return items as Interactions.FunctionResultStep["result"];
}

/**
 * The conversation so far as Gemini input. Claude's thinking and web search results stay with Claude; what
 * the person asked, the answers, and Kiki's tool calls and their results carry over.
 */
export function toGeminiSteps(history: Anthropic.Beta.BetaMessageParam[]): Step[] {
  const steps: Step[] = [];
  const names = new Map<string, string>();
  for (const message of history) {
    const blocks = blocksOf(message);
    let content: Content[] = [];
    const flush = () => {
      if (content.length === 0) return;
      steps.push(message.role === "user" ? { type: "user_input", content } : { type: "model_output", content });
      content = [];
    };
    for (const block of blocks) {
      if (block.type === "text") {
        if (block.text) content.push({ type: "text", text: block.text });
      } else if (block.type === "image" && block.source.type === "base64") {
        content.push({ type: "image", data: block.source.data, mime_type: block.source.media_type });
      } else if (block.type === "tool_use") {
        flush();
        names.set(block.id, block.name);
        steps.push({ type: "function_call", id: block.id, name: block.name, arguments: (block.input ?? {}) as Record<string, unknown> });
      } else if (block.type === "tool_result") {
        flush();
        const name = names.get(block.tool_use_id);
        steps.push({
          type: "function_result",
          call_id: block.tool_use_id,
          ...(name ? { name } : {}),
          result: resultContent(block.content),
          ...(block.is_error ? { is_error: true } : {}),
        });
      }
    }
    flush();
  }
  return steps;
}

/** Builds each step of an interaction from its start and the deltas that follow. */
class StepBuilder {
  readonly steps: Step[] = [];
  readonly #arguments = new Map<number, string>();

  start(index: number, step: Step): void {
    this.steps[index] = structuredClone(step);
  }

  delta(index: number, delta: Interactions.StepDelta["delta"]): void {
    const step = this.steps[index];
    if (!step) return;
    if (delta.type === "text" && step.type === "model_output") {
      const content = (step.content ??= []);
      const last = content.at(-1);
      if (last?.type === "text") last.text += delta.text;
      else content.push({ type: "text", text: delta.text });
    } else if (delta.type === "text_annotation_delta" && step.type === "model_output") {
      const last = step.content?.findLast((item) => item.type === "text");
      if (last?.type === "text") (last.annotations ??= []).push(...(delta.annotations ?? []));
    } else if (delta.type === "thought_summary" && step.type === "thought" && delta.content) {
      const summary = (step.summary ??= []);
      const last = summary.at(-1);
      if (delta.content.type === "text" && last?.type === "text") last.text += delta.content.text;
      else if (delta.content.type === "text" || delta.content.type === "image") summary.push(delta.content);
    } else if (delta.type === "thought_signature" && step.type === "thought") {
      if (delta.signature) step.signature = delta.signature;
    } else if (delta.type === "arguments_delta" && step.type === "function_call") {
      this.#arguments.set(index, (this.#arguments.get(index) ?? "") + (delta.arguments ?? ""));
    } else if (
      (delta.type === "google_search_call" && step.type === "google_search_call") ||
      (delta.type === "url_context_call" && step.type === "url_context_call")
    ) {
      Object.assign(step, { arguments: delta.arguments }, delta.signature ? { signature: delta.signature } : {});
    } else if (
      (delta.type === "google_search_result" && step.type === "google_search_result") ||
      (delta.type === "url_context_result" && step.type === "url_context_result")
    ) {
      Object.assign(
        step,
        { result: delta.result },
        delta.signature ? { signature: delta.signature } : {},
        delta.is_error ? { is_error: true } : {},
      );
    }
  }

  stop(index: number): Step | undefined {
    const step = this.steps[index];
    const streamed = this.#arguments.get(index);
    if (step?.type === "function_call" && streamed) {
      try {
        step.arguments = JSON.parse(streamed) as Record<string, unknown>;
      } catch {
        // Left as it started; Kiki's check of the input tells Gemini what's wrong.
      }
    }
    return step;
  }
}

/**
 * Runs one user turn against Gemini, streaming Kiki events through `emit`.
 * `history` must already end with the new user message; it is not modified.
 * Throws on API errors (see `classifyError` in models.ts).
 */
export async function runGeminiTurn(options: TurnOptions & { client: GeminiClient }): Promise<TurnResult> {
  const { client, config, history, emit, signal, model } = options;
  const effort = options.effort ?? config.effort;
  const kikiTools: Interactions.Tool[] = toolsFor(options.tools).map((tool) => ({
    type: "function",
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.input_schema,
  }));
  const tools: Interactions.Tool[] = [
    { type: "google_search" },
    ...(config.maxFetches > 0 ? [{ type: "url_context" as const }] : []),
    ...kikiTools,
  ];
  const input = toGeminiSteps(history);
  /** This turn's steps, exactly as Gemini sent them (thought signatures included), and Kiki's results. */
  const turnSteps: Step[] = [];
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  let toolRounds = 0;
  const screen = { steps: 0 };
  const sources = new SourceCollector();
  const usage = emptyUsage();
  const feed = new TurnFeed(emit);

  for (;;) {
    feed.startResponse();
    const outOfRounds = toolRounds >= MAX_TOOL_ROUNDS;
    // Google Search alongside function calls needs "validated" mode; out of rounds, Gemini answers with what it has.
    const toolChoice = outOfRounds ? "none" : kikiTools.length > 0 ? "validated" : undefined;
    const events = await client.stream(
      {
        model,
        system_instruction: systemPrompt(options.personality),
        input: [...input, ...turnSteps],
        tools,
        generation_config: {
          thinking_level: geminiThinkingLevel(effort),
          thinking_summaries: "auto",
          max_output_tokens: config.maxTokens,
          ...(toolChoice ? { tool_choice: toolChoice } : {}),
        },
        store: false,
      },
      signal,
    );

    const builder = new StepBuilder();
    let status = "in_progress";
    let finalSteps: Step[] | undefined;
    let turnUsage: Interactions.Usage | undefined;
    let failure: { code?: string | undefined; message?: string | undefined } | undefined;

    for await (const event of events) {
      if (event.event_type === "step.start") {
        builder.start(event.index, event.step);
        const { step } = event;
        if (step.type === "thought") feed.thinkingBlock();
        else if (step.type === "model_output") feed.phase("writing");
        else if (step.type === "function_call" && isKikiTool(step.name)) feed.toolStarting();
        else if (step.type === "google_search_call") feed.phase("searching");
      } else if (event.event_type === "step.delta") {
        builder.delta(event.index, event.delta);
        const { delta } = event;
        if (delta.type === "text") {
          feed.phase("writing");
          feed.text(delta.text);
        } else if (delta.type === "thought_summary" && delta.content?.type === "text") {
          feed.thinking(delta.content.text);
        } else if (delta.type === "text_annotation_delta") {
          for (const annotation of delta.annotations ?? []) {
            if (annotation.type === "url_citation" && annotation.url) sources.addCited(annotation.url, annotation.title);
          }
        }
        if (event.metadata?.total_usage) turnUsage = event.metadata.total_usage;
      } else if (event.event_type === "step.stop") {
        const step = builder.stop(event.index);
        if (step?.type === "google_search_call") {
          // Guarded: a step that stops without its arguments' delta has none.
          for (const query of step.arguments?.queries ?? []) feed.search(query);
        } else if (step?.type === "url_context_call") {
          for (const url of step.arguments?.urls ?? []) feed.read(url);
        } else if (step?.type === "url_context_result") {
          for (const result of step.result ?? []) if (result.url && result.status === "success") sources.addSearched(result.url, null);
          feed.phase("thinking");
        } else if (step?.type === "google_search_result") {
          feed.phase("thinking");
        }
        if (event.usage) turnUsage = event.usage;
      } else if (event.event_type === "interaction.status_update") {
        status = event.status;
        if (event.usage) turnUsage = event.usage;
      } else if (event.event_type === "interaction.completed") {
        status = event.interaction.status;
        if (event.interaction.steps?.length) finalSteps = event.interaction.steps;
        if (event.interaction.usage) turnUsage = event.interaction.usage;
      } else if (event.event_type === "error") {
        failure = event.error ?? {};
      }
    }
    addUsage(usage, turnUsage);

    if (failure || status === "failed" || status === "cancelled") {
      const message = failure?.message ?? `The interaction ${status}.`;
      if (BLOCKED.test(`${failure?.code ?? ""} ${message}`)) return { kind: "refused", usage };
      throw new GeminiTurnError(`Gemini: ${message}`, Number(failure?.code) || undefined);
    }

    const steps = (finalSteps ?? builder.steps).filter((step): step is Step => step !== undefined);
    turnSteps.push(...steps);

    // Claude's view of this response: its text and its calls to Kiki's tools.
    const ids = new Map<string, string>();
    const calls: ToolCall[] = [];
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const step of steps) {
      if (step.type === "model_output") {
        const text = (step.content ?? []).map((item) => (item.type === "text" ? item.text : "")).join("");
        if (text) content.push({ type: "text", text });
      } else if (step.type === "function_call") {
        const id = canonicalToolId(step.id);
        ids.set(id, step.id);
        calls.push({ id, name: step.name, input: step.arguments ?? {} });
        content.push({ type: "tool_use", id, name: step.name, input: step.arguments ?? {} });
      }
    }
    if (content.length > 0) messages.push({ role: "assistant", content });

    if (calls.length > 0) {
      if (usesToolRound(calls, screen)) toolRounds++;
      const results = await runKikiTools(calls, emit, options.callTool, screen, signal);
      messages.push({ role: "user", content: results });
      for (const result of results) {
        const call = calls.find((item) => item.id === result.tool_use_id);
        turnSteps.push({
          type: "function_result",
          call_id: ids.get(result.tool_use_id) ?? result.tool_use_id,
          ...(call ? { name: call.name } : {}),
          result: resultContent(result.content),
          ...(result.is_error ? { is_error: true } : {}),
        });
      }
      continue;
    }

    return {
      kind: "answered",
      messages,
      stopReason: status === "incomplete" || status === "budget_exceeded" ? "max_tokens" : "end_turn",
      sources: sources.result(),
      usage,
    };
  }
}
