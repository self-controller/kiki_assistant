import type { HookCallback, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ClaudeCodeQuery, ClaudeCodeStartup } from "../src/claudeCode.ts";
import type { CompatibleClient, CompatibleEndpoint, CompatibleStreamParams } from "../src/compatible.ts";
import type { GeminiClient, GeminiStreamParams } from "../src/gemini.ts";
import type { OpenAIClient, OpenAIStreamParams } from "../src/openai.ts";
import { chatEvents, geminiEvents, openaiEvents, sseBody, sseEvents, type FakeBlock, type FakeTurn } from "../src/mock/fakeEvents.ts";

export * from "../src/mock/fakeEvents.ts";

export type FakeResponse = FakeTurn | { status: number; errorType: string };

/**
 * An Anthropic client whose HTTP calls are answered from `responses` in order.
 * `requests` collects every request body so tests can inspect what was sent.
 */
export function fakeClient(responses: FakeResponse[]) {
  const requests: Array<Record<string, unknown>> = [];
  const headers: Array<Record<string, string>> = [];
  let call = 0;
  const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push(JSON.parse(String(init?.body)));
    headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
    const next = responses[call++];
    if (!next) throw new Error(`Unexpected Claude request #${call}`);
    if ("status" in next) {
      return new Response(
        JSON.stringify({ type: "error", error: { type: next.errorType, message: next.errorType } }),
        { status: next.status, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(sseBody(next, `msg_${call}`), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const client = new Anthropic({ apiKey: "test-key", fetch, maxRetries: 0 });
  return { client, requests, headers };
}

async function* streamOf<T>(events: T[]): AsyncGenerator<T> {
  yield* events;
}

/** An API error as Google's and OpenAI's clients throw it. */
function apiError(status: number, message: string): Error {
  return Object.assign(new Error(`${status} ${message}`), { status });
}

/**
 * Gemini clients (one per key) whose requests are answered from `responses` in order. `requests` collects
 * every request and `keys` the key each was made with.
 */
export function fakeGemini(responses: FakeResponse[]) {
  const requests: GeminiStreamParams[] = [];
  const keys: string[] = [];
  let call = 0;
  const factory = (apiKey: string): GeminiClient => ({
    async stream(params) {
      requests.push(structuredClone(params));
      keys.push(apiKey);
      const next = responses[call++];
      if (!next) throw new Error(`Unexpected Gemini request #${call}`);
      if ("status" in next) throw apiError(next.status, next.errorType);
      return streamOf(geminiEvents(next, `int_${call}`));
    },
  });
  return { factory, requests, keys };
}

/** Like `fakeGemini`, for OpenAI. */
export function fakeOpenAI(responses: FakeResponse[]) {
  const requests: OpenAIStreamParams[] = [];
  const keys: string[] = [];
  let call = 0;
  const factory = (apiKey: string): OpenAIClient => ({
    async stream(params) {
      requests.push(structuredClone(params));
      keys.push(apiKey);
      const next = responses[call++];
      if (!next) throw new Error(`Unexpected OpenAI request #${call}`);
      if ("status" in next) throw apiError(next.status, next.errorType);
      return streamOf(openaiEvents(next, `resp_${call}`));
    },
  });
  return { factory, requests, keys };
}

/**
 * OpenAI-compatible clients (one per service) whose requests are answered from `responses` in order; an
 * `error` entry throws it, as when nothing listens at the address. `endpoints` collects where each went.
 */
export function fakeCompatible(responses: Array<FakeResponse | { error: Error }>) {
  const requests: CompatibleStreamParams[] = [];
  const endpoints: CompatibleEndpoint[] = [];
  let call = 0;
  const factory = (endpoint: CompatibleEndpoint): CompatibleClient => ({
    async stream(params) {
      requests.push(structuredClone(params));
      endpoints.push(endpoint);
      const next = responses[call++];
      if (!next) throw new Error(`Unexpected chat request #${call}`);
      if ("error" in next) throw next.error;
      if ("status" in next) throw apiError(next.status, next.errorType);
      return streamOf(chatEvents(next, `chat_${call}`));
    },
  });
  return { factory, requests, endpoints };
}

/** One response in a fake Claude Code turn. Its tool calls run: Kiki's through Kiki's real MCP server. */
export interface FakeClaudeResponse {
  /** Text, thinking, and tool calls by Claude Code's names ("WebSearch", "mcp__kiki__open_search"). */
  blocks: FakeBlock[];
  /** What the response's web searches find. */
  searchResults?: Array<{ url: string; title: string }>;
  stopReason?: string;
}

export interface FakeClaudeQuery {
  responses: FakeClaudeResponse[];
  /** How Claude Code says it's signed in; "none" (the plan's login) by default. */
  apiKeySource?: string;
  /** The turn fails with this error, as Claude Code reports one on an assistant message. */
  error?: string;
  rateLimit?: Record<string, unknown>;
}

/** A content block as Claude Code's assistant messages carry it, with the ids `sseEvents` gives. */
function completeBlock(block: FakeBlock, index: number): object {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "thinking") return { type: "thinking", thinking: block.thinking, signature: "sig" };
  if (block.type === "tool_use") return { type: "tool_use", id: `toolu_${index}`, name: block.name, input: block.input };
  throw new Error(`Claude Code doesn't send ${block.type} blocks`);
}

/**
 * A stand-in for the Agent SDK's `query` and `startup`, answering each question from `queries` in order.
 * `calls` collects the options and the message each query got, and whether a process started ahead took it
 * (`warm`); `starts` the options of each process started ahead, and whether it was closed without a question;
 * `toolOutputs` what Kiki's tools returned to Claude Code, and `gate` how Kiki's hook ruled on each web search
 * and fetch.
 */
export function fakeClaudeCode(queries: FakeClaudeQuery[]) {
  const calls: Array<{ options: Options; message: SDKUserMessage["message"]; warm: boolean }> = [];
  const starts: Array<{ options: Options; closed: boolean }> = [];
  const toolOutputs: CallToolResult[] = [];
  const gate: Array<{ tool: string; allowed: boolean; reason?: string }> = [];
  let call = 0;
  const run = (prompt: AsyncIterable<SDKUserMessage>, options: Options, warm: boolean) =>
    (async function* (): AsyncGenerator<SDKMessage> {
      const script = queries[call++];
      if (!script) throw new Error(`Unexpected Claude Code query #${call}`);
      let message: SDKUserMessage["message"] | undefined;
      for await (const user of prompt) {
        message = user.message;
        break;
      }
      calls.push({ options, message: message!, warm });
      const session_id = options.resume ?? `session-${call}`;
      const base = { uuid: "00000000-0000-0000-0000-000000000000", session_id, parent_tool_use_id: null };
      yield { type: "system", subtype: "init", apiKeySource: script.apiKeySource ?? "none", ...base } as unknown as SDKMessage;
      if (script.rateLimit) yield { type: "rate_limit_event", rate_limit_info: script.rateLimit, ...base } as unknown as SDKMessage;

      let client: Client | undefined;
      const kiki = options.mcpServers?.["kiki"];
      if (kiki?.type === "sdk") {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await kiki.instance.connect(serverSide);
        client = new Client({ name: "fake-claude-code", version: "0.0.0" });
        await client.connect(clientSide);
      }
      const hook = options.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback | undefined;
      let searches = 0;

      for (const [r, response] of script.responses.entries()) {
        const id = `msg_${call}_${r}`;
        for (const event of sseEvents(response, id)) yield { type: "stream_event", event, ...base } as unknown as SDKMessage;
        // Like Claude Code, one assistant message per content block.
        for (const [index, block] of response.blocks.entries()) {
          yield { type: "assistant", message: { id, content: [completeBlock(block, index)] }, ...base } as unknown as SDKMessage;
        }
        for (const [index, block] of response.blocks.entries()) {
          if (block.type !== "tool_use") continue;
          const tool_use_id = `toolu_${index}`;
          if (block.name.startsWith("mcp__kiki__")) {
            const output = (await client!.callTool({
              name: block.name.slice("mcp__kiki__".length),
              arguments: block.input,
              _meta: { "claudecode/toolUseId": tool_use_id },
            })) as CallToolResult;
            toolOutputs.push(output);
            yield {
              type: "user",
              message: { role: "user", content: [{ type: "tool_result", tool_use_id, content: output.content }] },
              tool_use_result: output,
              ...base,
            } as unknown as SDKMessage;
            continue;
          }
          const decision = await hook!(
            { hook_event_name: "PreToolUse", tool_name: block.name, tool_input: block.input, tool_use_id, session_id, transcript_path: "", cwd: "" },
            tool_use_id,
            { signal: new AbortController().signal },
          );
          const output = (decision as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
          const allowed = output?.permissionDecision !== "deny";
          gate.push({ tool: block.name, allowed, ...(output?.permissionDecisionReason ? { reason: output.permissionDecisionReason } : {}) });
          if (allowed && block.name === "WebSearch") searches++;
          const result = !allowed
            ? undefined
            : block.name === "WebSearch"
              ? { query: block.input["query"], results: [{ tool_use_id: "srvtoolu_1", content: response.searchResults ?? [] }, "Links above."], durationSeconds: 1 }
              : { url: block.input["url"], code: 200, codeText: "OK", result: "The page.", bytes: 9, durationMs: 1 };
          yield {
            type: "user",
            message: { role: "user", content: [{ type: "tool_result", tool_use_id, content: allowed ? "Done." : output?.permissionDecisionReason, ...(allowed ? {} : { is_error: true }) }] },
            ...(result ? { tool_use_result: result } : {}),
            ...base,
          } as unknown as SDKMessage;
        }
      }
      await client?.close();
      if (script.error) {
        yield { type: "assistant", message: { id: "msg_error", content: [{ type: "text", text: "API Error" }] }, error: script.error, ...base } as unknown as SDKMessage;
      }
      yield {
        type: "result",
        subtype: "success",
        is_error: Boolean(script.error),
        result: "",
        stop_reason: script.responses.at(-1)?.stopReason ?? "end_turn",
        modelUsage: {
          "claude-opus-5-5": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 40, cacheCreationInputTokens: 10, webSearchRequests: searches, costUSD: 0 },
        },
        ...base,
      } as unknown as SDKMessage;
    })();
  const query: ClaudeCodeQuery = ({ prompt, options }) => run(prompt, options, false);
  const startup: ClaudeCodeStartup = async ({ options }) => {
    const started = { options, closed: false };
    starts.push(started);
    return {
      query: (prompt) => run(prompt, options, true),
      close: () => {
        started.closed = true;
      },
    };
  };
  return { query, startup, calls, starts, toolOutputs, gate };
}
