import Anthropic from "@anthropic-ai/sdk";
import type { KikiEvent } from "@kiki/shared";

/** A content block to stream back, described the way the API sends it. */
export type FakeBlock =
  | { type: "text"; text: string; citations?: Array<{ url: string; title: string }> }
  | { type: "thinking"; thinking: string }
  | { type: "server_tool_use"; name: "web_search"; query: string }
  | { type: "server_tool_use"; name: "web_fetch"; url: string }
  | { type: "web_search_tool_result"; results: Array<{ url: string; title: string }> }
  | { type: "web_fetch_tool_result"; url: string; title: string }
  /** A client tool call (Kiki's own tools); its id is `toolu_<index>`. */
  | { type: "tool_use"; name: string; input: Record<string, unknown> };

export interface FakeTurn {
  blocks: FakeBlock[];
  stopReason?: string;
  webSearches?: number;
}

export function sseEvents(turn: FakeTurn, id: string, chunkChars?: number): object[] {
  const events: object[] = [
    {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 40, cache_creation_input_tokens: 0 },
      },
    },
  ];
  turn.blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const citation of block.citations ?? []) {
        events.push({
          type: "content_block_delta",
          index,
          delta: {
            type: "citations_delta",
            citation: {
              type: "web_search_result_location",
              url: citation.url,
              title: citation.title,
              cited_text: "…",
              encrypted_index: "enc",
            },
          },
        });
      }
      // Several deltas (two by default) to exercise streaming.
      const size = chunkChars ?? Math.ceil(block.text.length / 2);
      for (let start = 0; start < block.text.length; start += size) {
        const piece = block.text.slice(start, start + size);
        events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: piece } });
      }
    } else if (block.type === "thinking") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      const size = chunkChars ?? Math.ceil(block.thinking.length / 2);
      for (let start = 0; start < block.thinking.length; start += size) {
        const piece = block.thinking.slice(start, start + size);
        events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: piece } });
      }
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } });
    } else if (block.type === "server_tool_use") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "server_tool_use", id: `srvtoolu_${index}`, name: block.name, input: {} },
      });
      const input = block.name === "web_search" ? { query: block.query } : { url: block.url };
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
      });
    } else if (block.type === "tool_use") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: `toolu_${index}`, name: block.name, input: {} },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    } else if (block.type === "web_fetch_tool_result") {
      events.push({
        type: "content_block_start",
        index,
        content_block: {
          type: "web_fetch_tool_result",
          tool_use_id: `srvtoolu_${index - 1}`,
          content: {
            type: "web_fetch_result",
            url: block.url,
            retrieved_at: null,
            content: {
              type: "document",
              title: block.title,
              citations: null,
              source: { type: "text", media_type: "text/plain", data: "Page text." },
            },
          },
        },
      });
    } else {
      events.push({
        type: "content_block_start",
        index,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: `srvtoolu_${index - 1}`,
          content: block.results.map((r) => ({
            type: "web_search_result",
            url: r.url,
            title: r.title,
            encrypted_content: "enc",
            page_age: null,
          })),
        },
      });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({
    type: "message_delta",
    delta: { stop_reason: turn.stopReason ?? "end_turn", stop_sequence: null },
    usage: {
      output_tokens: 50,
      server_tool_use: { web_search_requests: turn.webSearches ?? 0, web_fetch_requests: 0 },
    },
  });
  events.push({ type: "message_stop" });
  return events;
}

export function sseBody(turn: FakeTurn, id = "msg_test"): string {
  return sseEvents(turn, id)
    .map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

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

/** Parses an SSE response body from the Kiki server into events. */
export async function readEvents(response: Response): Promise<KikiEvent[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .flatMap((chunk) => chunk.split("\n").filter((line) => line.startsWith("data: ")))
    .map((line) => JSON.parse(line.slice("data: ".length)) as KikiEvent);
}
