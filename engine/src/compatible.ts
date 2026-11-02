// Models the person added themselves: another service's (OpenRouter, Groq, DeepSeek, xAI, Mistral, Together…)
// on their own key, or a local one (Ollama, LM Studio), through the OpenAI-compatible Chat Completions API
// those all speak. These have no web search; Kiki's own tools go along as function tools, and a model that
// can't take tools answers without them.
import type Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionFunctionTool,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { blocksOf, systemPrompt } from "./prompt.ts";
import { toolsFor } from "./tools.ts";
import {
  canonicalToolId,
  dataUrl,
  emptyUsage,
  isKikiTool,
  MAX_SCREEN_STEPS,
  MAX_TOOL_ROUNDS,
  OUT_OF_TOOL_ROUNDS,
  parseArguments,
  resultParts,
  runKikiTools,
  TurnFeed,
  usesToolRound,
  type ToolCall,
  type TurnOptions,
  type TurnResult,
  type UsageDelta,
} from "./turn.ts";

export type CompatibleStreamParams = Omit<ChatCompletionCreateParamsStreaming, "stream">;

/** The part of an OpenAI-compatible client Kiki uses, so tests can stand in for it. */
export interface CompatibleClient {
  stream(params: CompatibleStreamParams, signal?: AbortSignal): Promise<AsyncIterable<ChatCompletionChunk>>;
}

/** Where a custom model is served: the service's base URL (ending in /v1 for most), and the person's key. */
export interface CompatibleEndpoint {
  baseUrl: string;
  apiKey?: string;
}

export function compatibleClient(endpoint: CompatibleEndpoint): CompatibleClient {
  // Local servers take no key, but the client wants one.
  const client = new OpenAI({ apiKey: endpoint.apiKey || "none", baseURL: endpoint.baseUrl, maxRetries: 1 });
  return { stream: async (params, signal) => client.chat.completions.create({ ...params, stream: true }, { signal }) };
}

/** The model finished without writing anything. */
export class EmptyAnswerError extends Error {
  constructor() {
    super("The model returned an empty answer.");
    this.name = "EmptyAnswerError";
  }
}

/** Added to the system prompt: these models can't search, so the prompt's search advice doesn't apply. */
export const NO_WEB_NOTE =
  "In this conversation you can't search the web or read pages. Answer from what you know and what's on screen, and say so when something may have changed since your training.";

/** Requests per answer at most, whatever the model does with `tool_choice`. */
const MAX_REQUESTS = MAX_TOOL_ROUNDS + MAX_SCREEN_STEPS + 3;

function imagePart(source: Anthropic.Beta.BetaBase64ImageSource): ChatCompletionContentPart {
  return { type: "image_url", image_url: { url: dataUrl(source) } };
}

/** A tool result's text, and the screenshots a scroll or look brought back (which a tool message can't carry). */
function splitResult(result: Anthropic.Beta.BetaToolResultBlockParam): { text: string; images: ChatCompletionContentPart[] } {
  const parts = resultParts(result.content ?? "");
  const texts = parts.flatMap((part) => (part.type === "text" ? [part.text] : []));
  const images = parts.flatMap((part) => (part.type === "image" ? [imagePart(part.source)] : []));
  return { text: `${result.is_error ? "Error: " : ""}${texts.join("\n")}`, images };
}

/** User content as a plain string when it's only text: some local servers take nothing else. */
function userContent(parts: ChatCompletionContentPart[]): string | ChatCompletionContentPart[] {
  return parts.every((part) => part.type === "text") ? parts.map((part) => (part.type === "text" ? part.text : "")).join("\n\n") : parts;
}

/**
 * The conversation so far as chat messages. Claude's thinking and web search results stay with Claude; what
 * the person asked, the answers, and Kiki's tool calls and results carry over. Screenshots from tools go in a
 * user message after the results, since tool messages only take text. With `tools` off (a model that can't
 * take them), calls and results become plain text.
 */
export function toChatMessages(history: Anthropic.Beta.BetaMessageParam[], tools = true): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];
  const names = new Map<string, string>();
  for (const message of history) {
    const blocks = blocksOf(message);
    if (message.role === "assistant") {
      let text = "";
      const calls: ChatCompletionMessageFunctionToolCall[] = [];
      for (const block of blocks) {
        if (block.type === "text") text += block.text;
        else if (block.type === "tool_use") {
          names.set(block.id, block.name);
          const args = JSON.stringify(block.input ?? {});
          if (tools) calls.push({ id: block.id, type: "function", function: { name: block.name, arguments: args } });
          else text += `${text ? "\n\n" : ""}[I used ${block.name} ${args}]`;
        }
      }
      if (calls.length > 0) messages.push({ role: "assistant", content: text || null, tool_calls: calls });
      else if (text) messages.push({ role: "assistant", content: text });
      continue;
    }
    const parts: ChatCompletionContentPart[] = [];
    const screenshots: ChatCompletionContentPart[] = [];
    for (const block of blocks) {
      if (block.type === "text") parts.push({ type: "text", text: block.text });
      else if (block.type === "image" && block.source.type === "base64") parts.push(imagePart(block.source));
      else if (block.type === "tool_result") {
        const { text, images } = splitResult(block);
        if (tools) messages.push({ role: "tool", tool_call_id: block.tool_use_id, content: text });
        else parts.push({ type: "text", text: `[${names.get(block.tool_use_id) ?? "Tool"} result]\n${text}` });
        screenshots.push(...images);
      }
    }
    const content = screenshots.length > 0 ? [{ type: "text" as const, text: "The screen after that:" }, ...screenshots, ...parts] : parts;
    if (content.length > 0) messages.push({ role: "user", content: userContent(content) });
  }
  return messages;
}

/**
 * Splits a leading <think>…</think> (how some local models stream their reasoning) from the answer, across
 * chunks that may cut a tag in two.
 */
export class ThinkSplitter {
  #mode: "start" | "think" | "text" = "start";
  #buffer = "";

  push(chunk: string): { thinking: string; text: string } {
    this.#buffer += chunk;
    let thinking = "";
    let text = "";
    if (this.#mode === "start") {
      const lead = this.#buffer.trimStart();
      if (lead.length < "<think>".length && "<think>".startsWith(lead)) return { thinking, text };
      if (lead.startsWith("<think>")) {
        this.#mode = "think";
        this.#buffer = lead.slice("<think>".length);
      } else {
        this.#mode = "text";
      }
    }
    if (this.#mode === "think") {
      const end = this.#buffer.indexOf("</think>");
      if (end === -1) {
        // Hold back what could be the start of "</think>".
        const keep = partialTagLength(this.#buffer, "</think>");
        thinking = this.#buffer.slice(0, this.#buffer.length - keep);
        this.#buffer = this.#buffer.slice(this.#buffer.length - keep);
        return { thinking, text };
      }
      thinking = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + "</think>".length).trimStart();
      this.#mode = "text";
    }
    text = this.#buffer;
    this.#buffer = "";
    return { thinking, text };
  }

  /** What's left once the stream ends. */
  end(): { thinking: string; text: string } {
    const rest = this.#buffer;
    this.#buffer = "";
    return this.#mode === "think" ? { thinking: rest, text: "" } : { thinking: "", text: rest };
  }
}

/** How many characters at the end of `text` could begin `tag`. */
function partialTagLength(text: string, tag: string): number {
  for (let length = Math.min(tag.length - 1, text.length); length > 0; length--) {
    if (tag.startsWith(text.slice(-length))) return length;
  }
  return 0;
}

function addUsage(total: UsageDelta, usage: ChatCompletionChunk["usage"]): void {
  if (!usage) return;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  total.inputTokens += Math.max(0, usage.prompt_tokens - cached);
  total.cacheReadTokens += cached;
  total.outputTokens += usage.completion_tokens;
}

/** The HTTP status and message of a failed request, if it has them. */
function failure(error: unknown): { status?: number; message: string } {
  if (typeof error !== "object" || error === null) return { message: String(error) };
  const { status, message } = error as { status?: unknown; message?: unknown };
  return { ...(typeof status === "number" ? { status } : {}), message: typeof message === "string" ? message : "" };
}

/** The service turned the request down because the model can't take tools (Ollama: "… does not support tools"). */
export function rejectsTools(error: unknown): boolean {
  const { status, message } = failure(error);
  return (status === 400 || status === 404 || status === 422 || status === 500) && /tool|function/i.test(message);
}

/** Where a model's reasoning streams: `reasoning_content` (DeepSeek, LM Studio, vLLM) or `reasoning` (OpenRouter, Ollama). */
function reasoningOf(delta: ChatCompletionChunk.Choice.Delta | undefined): string {
  const extra = delta as { reasoning_content?: unknown; reasoning?: unknown } | undefined;
  const value = extra?.reasoning_content ?? extra?.reasoning;
  return typeof value === "string" ? value : "";
}

/**
 * Runs one user turn against an OpenAI-compatible service's `model`, streaming Kiki events through `emit`.
 * `history` must already end with the new user message; it is not modified. Throws on API errors (see
 * `classifyError` in models.ts).
 */
export async function runCompatibleTurn(options: TurnOptions & { client: CompatibleClient }): Promise<TurnResult> {
  const { client, history, emit, signal, model } = options;
  const system = `${systemPrompt(options.personality)}\n\n${NO_WEB_NOTE}`;
  const kikiTools: ChatCompletionFunctionTool[] = toolsFor(options.tools).map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description ?? "", parameters: tool.input_schema as Record<string, unknown> },
  }));
  let useTools = kikiTools.length > 0;
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  /** The conversation as chat messages, converted once for each way of offering tools; this turn's go on the end. */
  let chat: ChatCompletionMessageParam[] = [];
  let chatOffer: boolean | undefined;
  let toolRounds = 0;
  let requests = 0;
  const screen = { steps: 0 };
  const usage = emptyUsage();
  const feed = new TurnFeed(emit);

  for (;;) {
    requests++;
    // Out of rounds: the model answers with what it has. Past every limit, it gets no tools at all.
    const lastRequest = requests >= MAX_REQUESTS;
    const offer = useTools && !lastRequest;
    const outOfRounds = toolRounds >= MAX_TOOL_ROUNDS;
    if (offer !== chatOffer) {
      chatOffer = offer;
      chat = toChatMessages([...history, ...messages], offer);
    }
    feed.startResponse();
    let events: AsyncIterable<ChatCompletionChunk>;
    try {
      events = await client.stream(
        {
          model,
          messages: [{ role: "system", content: system }, ...chat],
          ...(offer ? { tools: kikiTools, ...(outOfRounds ? { tool_choice: "none" as const } : {}) } : {}),
          stream_options: { include_usage: true },
        },
        signal,
      );
    } catch (error) {
      if (useTools && rejectsTools(error)) {
        useTools = false;
        requests--;
        continue;
      }
      throw error;
    }

    const splitter = new ThinkSplitter();
    let text = "";
    let reasoning = false;
    let finish: string | null = null;
    const calls = new Map<number, { id: string; name: string; arguments: string; announced: boolean }>();
    const write = (part: { thinking: string; text: string }) => {
      if (part.thinking) {
        if (!reasoning) feed.thinkingBlock();
        reasoning = true;
        feed.thinking(part.thinking);
      }
      if (part.text) {
        feed.phase("writing");
        feed.text(part.text);
        text += part.text;
      }
    };

    for await (const chunk of events) {
      addUsage(usage, chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const thought = reasoningOf(choice.delta);
      if (thought) write({ thinking: thought, text: "" });
      if (choice.delta?.content) write(splitter.push(choice.delta.content));
      for (const delta of choice.delta?.tool_calls ?? []) {
        const call = calls.get(delta.index) ?? { id: "", name: "", arguments: "", announced: false };
        if (delta.id) call.id = delta.id;
        if (delta.function?.name) call.name += delta.function.name;
        if (delta.function?.arguments) call.arguments += delta.function.arguments;
        if (!call.announced && call.name && isKikiTool(call.name)) {
          call.announced = true;
          feed.toolStarting();
        }
        calls.set(delta.index, call);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    write(splitter.end());

    if (finish === "content_filter" && !text) return { kind: "refused", usage };

    // Claude's view of this response: its text and its calls to Kiki's tools.
    const toolCalls: ToolCall[] = [...calls.values()]
      .filter((call) => call.name)
      .map((call) => ({ id: canonicalToolId(call.id), name: call.name, input: parseArguments(call.arguments) }));
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (text) content.push({ type: "text", text });
    for (const call of toolCalls) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });

    if (toolCalls.length > 0 && !lastRequest) {
      // A model that ignores `tool_choice: "none"` hears it's out of rounds, and answers next time.
      const results = outOfRounds
        ? toolCalls.map((call) => ({ type: "tool_result" as const, tool_use_id: call.id, content: OUT_OF_TOOL_ROUNDS, is_error: true }))
        : await runKikiTools(toolCalls, emit, options.callTool, screen, signal);
      if (!outOfRounds && usesToolRound(toolCalls, screen)) toolRounds++;
      const round: Anthropic.Beta.BetaMessageParam[] = [{ role: "assistant", content }, { role: "user", content: results }];
      messages.push(...round);
      chat.push(...toChatMessages(round, offer));
      continue;
    }

    if (!text) throw new EmptyAnswerError();
    messages.push({ role: "assistant", content: [{ type: "text", text }] });
    return {
      kind: "answered",
      messages,
      stopReason: finish === "length" ? "max_tokens" : "end_turn",
      sources: [],
      usage,
    };
  }
}
