// OpenAI's models, through the Responses API, on the person's own OpenAI API key. Nothing is stored with
// OpenAI (`store: false`), so every request carries the whole conversation, and the reasoning between tool
// calls comes back encrypted for the next request of the turn.
import type Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseFunctionCallOutputItemList,
  ResponseInputItem,
  ResponseInputMessageContentList,
  ResponseOutputItem,
  ResponseStreamEvent,
  ResponseUsage,
  Tool,
} from "openai/resources/responses/responses";
import { blocksOf, systemPrompt } from "./prompt.ts";
import { toolsFor } from "./tools.ts";
import {
  canonicalToolId,
  dataUrl,
  emptyUsage,
  isKikiTool,
  MAX_TOOL_ROUNDS,
  parseArguments,
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

export type OpenAIStreamParams = Omit<ResponseCreateParamsStreaming, "stream">;

/** The part of OpenAI's client Kiki uses, so tests can stand in for it. */
export interface OpenAIClient {
  stream(params: OpenAIStreamParams, signal?: AbortSignal): Promise<AsyncIterable<ResponseStreamEvent>>;
}

export function openaiClient(apiKey: string): OpenAIClient {
  const client = new OpenAI({ apiKey });
  return { stream: async (params, signal) => client.responses.create({ ...params, stream: true }, { signal }) };
}

/** A response that ended in an error, with what OpenAI said. */
export class OpenAITurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAITurnError";
  }
}

function addUsage(total: UsageDelta, usage: ResponseUsage | null | undefined): void {
  if (!usage) return;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  total.inputTokens += Math.max(0, usage.input_tokens - cached);
  total.outputTokens += usage.output_tokens;
  total.cacheReadTokens += cached;
  total.cacheWriteTokens += usage.input_tokens_details?.cache_write_tokens ?? 0;
}

/**
 * A tool result's content (text, and screenshots from scrolls) as OpenAI reads it. OpenAI's outputs have no
 * error flag, so an error says so in its text.
 */
function callOutput(result: Anthropic.Beta.BetaToolResultBlockParam): string | ResponseFunctionCallOutputItemList {
  const { content } = result;
  if (typeof content === "string" || content === undefined) return result.is_error ? `Error: ${content ?? ""}` : (content ?? "");
  return resultParts(content).map((part) =>
    part.type === "text"
      ? { type: "input_text" as const, text: part.text }
      : { type: "input_image" as const, image_url: dataUrl(part.source), detail: "auto" as const },
  );
}

/**
 * The conversation so far as OpenAI input. Claude's thinking and web search results stay with Claude; what
 * the person asked, the answers, and Kiki's tool calls and their results carry over.
 */
export function toOpenAIInput(history: Anthropic.Beta.BetaMessageParam[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];
  for (const message of history) {
    const blocks = blocksOf(message);
    let content: ResponseInputMessageContentList = [];
    let text = "";
    const flush = () => {
      if (message.role === "user" && content.length > 0) items.push({ role: "user", content });
      if (message.role === "assistant" && text) items.push({ role: "assistant", content: text });
      content = [];
      text = "";
    };
    for (const block of blocks) {
      if (block.type === "text") {
        if (message.role === "user") content.push({ type: "input_text", text: block.text });
        else text += block.text;
      } else if (block.type === "image" && block.source.type === "base64" && message.role === "user") {
        content.push({ type: "input_image", image_url: dataUrl(block.source), detail: "auto" });
      } else if (block.type === "tool_use") {
        flush();
        items.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
      } else if (block.type === "tool_result") {
        flush();
        items.push({ type: "function_call_output", call_id: block.tool_use_id, output: callOutput(block) });
      }
    }
    flush();
  }
  return items;
}

/**
 * Runs one user turn against an OpenAI model, streaming Kiki events through `emit`.
 * `history` must already end with the new user message; it is not modified.
 * Throws on API errors (see `classifyError` in models.ts).
 */
export async function runOpenAITurn(options: TurnOptions & { client: OpenAIClient }): Promise<TurnResult> {
  const { client, config, history, emit, signal, model } = options;
  const effort = options.effort ?? config.effort;
  const tools: Tool[] = [
    { type: "web_search" },
    ...toolsFor(options.tools).map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description ?? null,
      parameters: tool.input_schema as Record<string, unknown>,
      strict: false,
    })),
  ];
  const input = toOpenAIInput(history);
  /** This turn's output items, exactly as OpenAI sent them (encrypted reasoning included), and Kiki's results. */
  const turnItems: ResponseInputItem[] = [];
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  let toolRounds = 0;
  const screen = { steps: 0 };
  const sources = new SourceCollector();
  const usage = emptyUsage();
  const feed = new TurnFeed(emit);

  for (;;) {
    feed.startResponse();
    const events = await client.stream(
      {
        model,
        instructions: systemPrompt(options.personality),
        input: [...input, ...turnItems],
        tools,
        // Out of tool rounds: the model answers with what it has.
        ...(toolRounds >= MAX_TOOL_ROUNDS ? { tool_choice: "none" as const } : {}),
        reasoning: { effort, summary: "auto" },
        max_output_tokens: config.maxTokens,
        store: false,
        include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
        ...(options.conversationId ? { prompt_cache_key: options.conversationId } : {}),
      },
      signal,
    );

    let output: ResponseOutputItem[] = [];
    let status = "in_progress";
    let incomplete: string | undefined;
    let refused = false;

    for await (const event of events) {
      if (event.type === "response.output_item.added") {
        const { item } = event;
        if (item.type === "message") feed.phase("writing");
        else if (item.type === "web_search_call") feed.phase("searching");
        else if (item.type === "function_call" && isKikiTool(item.name)) feed.toolStarting();
      } else if (event.type === "response.reasoning_summary_part.added") {
        feed.thinkingBlock();
      } else if (event.type === "response.reasoning_summary_text.delta") {
        feed.thinking(event.delta);
      } else if (event.type === "response.output_text.delta") {
        feed.phase("writing");
        feed.text(event.delta);
      } else if (event.type === "response.output_text.annotation.added") {
        const annotation = event.annotation;
        if (annotation?.type === "url_citation") sources.addCited(annotation.url, annotation.title);
      } else if (event.type === "response.refusal.delta") {
        refused = true;
      } else if (event.type === "response.output_item.done" && event.item.type === "web_search_call") {
        const { action } = event.item;
        if (action.type === "search") {
          const queries = action.queries?.length ? action.queries : action.query ? [action.query] : [];
          for (const query of queries) feed.search(query);
          feed.results(action.sources ?? [], sources);
          usage.webSearches += 1;
        } else if (action.type === "open_page" && action.url) {
          feed.read(action.url);
        }
        feed.phase("thinking");
      } else if (
        event.type === "response.completed" ||
        event.type === "response.incomplete" ||
        event.type === "response.failed"
      ) {
        const { response } = event;
        output = response.output;
        status = response.status ?? status;
        incomplete = response.incomplete_details?.reason ?? undefined;
        addUsage(usage, response.usage);
        if (response.error) throw new OpenAITurnError(`OpenAI: ${response.error.message}`);
      } else if (event.type === "error") {
        throw new OpenAITurnError(`OpenAI: ${event.message}`);
      }
    }

    if (
      refused ||
      incomplete === "content_filter" ||
      output.some((item) => item.type === "message" && item.content.some((part) => part.type === "refusal"))
    ) {
      return { kind: "refused", usage };
    }
    if (status === "failed") throw new OpenAITurnError("OpenAI: the response failed.");

    turnItems.push(...(output as ResponseInputItem[]));

    // Claude's view of this response: its text and its calls to Kiki's tools.
    const ids = new Map<string, string>();
    const calls: ToolCall[] = [];
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const item of output) {
      if (item.type === "message") {
        const text = item.content.map((part) => (part.type === "output_text" ? part.text : "")).join("");
        if (text) content.push({ type: "text", text });
      } else if (item.type === "function_call") {
        const id = canonicalToolId(item.call_id);
        const callInput = parseArguments(item.arguments);
        ids.set(id, item.call_id);
        calls.push({ id, name: item.name, input: callInput });
        content.push({ type: "tool_use", id, name: item.name, input: callInput });
      }
    }
    if (content.length > 0) messages.push({ role: "assistant", content });

    if (calls.length > 0) {
      if (usesToolRound(calls, screen)) toolRounds++;
      const results = await runKikiTools(calls, emit, options.callTool, screen, signal);
      messages.push({ role: "user", content: results });
      for (const result of results) {
        turnItems.push({
          type: "function_call_output",
          call_id: ids.get(result.tool_use_id) ?? result.tool_use_id,
          output: callOutput(result),
        });
      }
      continue;
    }

    return {
      kind: "answered",
      messages,
      stopReason: incomplete === "max_output_tokens" ? "max_tokens" : "end_turn",
      sources: sources.result(),
      usage,
    };
  }
}
