// Model replies described once (as Claude content blocks) and streamed the way each API would send them:
// for tests, and for the app's mock mode (KIKI_MOCK=1), which answers without any model.
import type { Interactions } from "@google/genai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";

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

/** `text` in pieces, two by default, to exercise streaming. */
function pieces(text: string, chunkChars?: number): string[] {
  const size = chunkChars ?? (Math.ceil(text.length / 2) || 1);
  const result: string[] = [];
  for (let start = 0; start < text.length; start += size) result.push(text.slice(start, start + size));
  return result;
}

/**
 * The events of a Gemini interaction for `turn`, described the way Claude's are: thinking becomes thought
 * summaries, web searches become Google Search steps, page reads URL context steps, and Kiki's tools function
 * calls (with ids `call_<index>`). A "refusal" stop is a safety error.
 */
export function geminiEvents(turn: FakeTurn, id: string, chunkChars?: number): Interactions.InteractionSSEEvent[] {
  const events: object[] = [{ event_type: "interaction.created", interaction: { id, status: "in_progress" } }];
  let index = 0;
  const step = (start: object, deltas: object[]) => {
    events.push({ event_type: "step.start", index, step: start });
    for (const delta of deltas) events.push({ event_type: "step.delta", index, delta });
    events.push({ event_type: "step.stop", index });
    index++;
  };
  for (const block of turn.blocks) {
    if (block.type === "thinking") {
      step({ type: "thought" }, [
        ...pieces(block.thinking, chunkChars).map((text) => ({ type: "thought_summary", content: { type: "text", text } })),
        { type: "thought_signature", signature: "sig" },
      ]);
    } else if (block.type === "text") {
      const annotations = (block.citations ?? []).map((c) => ({ type: "url_citation", url: c.url, title: c.title }));
      step({ type: "model_output", content: [] }, [
        ...pieces(block.text, chunkChars).map((text) => ({ type: "text", text })),
        ...(annotations.length ? [{ type: "text_annotation_delta", annotations }] : []),
      ]);
    } else if (block.type === "server_tool_use" && block.name === "web_search") {
      step({ type: "google_search_call", id: `search_${index}`, arguments: {} }, [
        { type: "google_search_call", arguments: { queries: [block.query] }, signature: "sig" },
      ]);
    } else if (block.type === "web_search_tool_result") {
      step({ type: "google_search_result", call_id: `search_${index - 1}`, result: [] }, [
        { type: "google_search_result", result: [{ search_suggestions: "<div>suggestions</div>" }], signature: "sig" },
      ]);
    } else if (block.type === "server_tool_use") {
      step({ type: "url_context_call", id: `url_${index}`, arguments: {} }, [{ type: "url_context_call", arguments: { urls: [block.url] } }]);
    } else if (block.type === "web_fetch_tool_result") {
      step({ type: "url_context_result", call_id: `url_${index - 1}`, result: [] }, [
        { type: "url_context_result", result: [{ url: block.url, status: "success" }] },
      ]);
    } else {
      step({ type: "function_call", id: `call_${index}`, name: block.name, arguments: {} }, [
        { type: "arguments_delta", arguments: JSON.stringify(block.input) },
      ]);
    }
  }
  const refused = turn.stopReason === "refusal";
  const status = refused
    ? "failed"
    : turn.stopReason === "tool_use"
      ? "requires_action"
      : turn.stopReason === "max_tokens"
        ? "incomplete"
        : "completed";
  if (refused) events.push({ event_type: "error", error: { code: "SAFETY", message: "The response was blocked for safety." } });
  else events.push({ event_type: "interaction.status_update", interaction_id: id, status });
  const usage = {
    total_input_tokens: 100,
    total_cached_tokens: 40,
    total_output_tokens: 50,
    total_thought_tokens: 10,
    grounding_tool_count: turn.webSearches ? [{ type: "google_search", count: turn.webSearches }] : [],
  };
  events.push({ event_type: "interaction.completed", interaction: { id, status, usage } });
  return events as Interactions.InteractionSSEEvent[];
}

/**
 * The events of an OpenAI response for `turn`, described the way Claude's are: thinking becomes reasoning
 * summaries, a web search (with the results after it) a web search call, a page read an open_page action, and
 * Kiki's tools function calls (with call ids `call_<index>`). A "refusal" stop is a refusal message.
 */
export function openaiEvents(turn: FakeTurn, id: string, chunkChars?: number): ResponseStreamEvent[] {
  const events: object[] = [];
  const output: Array<Record<string, unknown>> = [];
  const add = (item: Record<string, unknown>, started: Record<string, unknown>, deltas: object[]) => {
    const output_index = output.length;
    output.push(item);
    events.push({ type: "response.output_item.added", output_index, item: started });
    for (const delta of deltas) events.push({ ...delta, output_index, item_id: item["id"] });
    events.push({ type: "response.output_item.done", output_index, item });
  };
  const blocks = [...turn.blocks];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!;
    if (block.type === "thinking") {
      const item = { type: "reasoning", id: `rs_${index}`, summary: [{ type: "summary_text", text: block.thinking }], encrypted_content: "enc" };
      add(item, { ...item, summary: [] }, [
        { type: "response.reasoning_summary_part.added", summary_index: 0, part: { type: "summary_text", text: "" } },
        ...pieces(block.thinking, chunkChars).map((delta) => ({ type: "response.reasoning_summary_text.delta", summary_index: 0, delta })),
      ]);
    } else if (block.type === "text") {
      const annotations = (block.citations ?? []).map((c) => ({ type: "url_citation", url: c.url, title: c.title, start_index: 0, end_index: block.text.length }));
      const item = {
        type: "message",
        id: `msg_${index}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: block.text, annotations }],
      };
      add(item, { ...item, status: "in_progress", content: [] }, [
        ...pieces(block.text, chunkChars).map((delta) => ({ type: "response.output_text.delta", content_index: 0, delta })),
        ...annotations.map((annotation, annotation_index) => ({
          type: "response.output_text.annotation.added",
          content_index: 0,
          annotation_index,
          annotation,
        })),
      ]);
    } else if (block.type === "server_tool_use" && block.name === "web_search") {
      const next = blocks[index + 1];
      const sources = next?.type === "web_search_tool_result" ? next.results.map((r) => ({ type: "url", url: r.url })) : [];
      const item = { type: "web_search_call", id: `ws_${index}`, status: "completed", action: { type: "search", query: block.query, sources } };
      add(item, { ...item, status: "in_progress", action: { type: "search" } }, []);
    } else if (block.type === "server_tool_use") {
      const item = { type: "web_search_call", id: `ws_${index}`, status: "completed", action: { type: "open_page", url: block.url } };
      add(item, { ...item, status: "in_progress" }, []);
    } else if (block.type === "tool_use") {
      const item = { type: "function_call", id: `fc_${index}`, call_id: `call_${index}`, name: block.name, arguments: JSON.stringify(block.input), status: "completed" };
      add(item, { ...item, arguments: "", status: "in_progress" }, [
        { type: "response.function_call_arguments.delta", delta: item.arguments },
      ]);
    }
  }
  if (turn.stopReason === "refusal") {
    const refusal = "I can't help with that.";
    const item = { type: "message", id: "msg_refusal", role: "assistant", status: "completed", content: [{ type: "refusal", refusal }] };
    add(item, { ...item, status: "in_progress", content: [] }, [{ type: "response.refusal.delta", content_index: 0, delta: refusal }]);
  }
  const incomplete = turn.stopReason === "max_tokens";
  events.push({
    type: incomplete ? "response.incomplete" : "response.completed",
    response: {
      id,
      object: "response",
      status: incomplete ? "incomplete" : "completed",
      output,
      error: null,
      incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 },
        output_tokens: 50,
        output_tokens_details: { reasoning_tokens: 10 },
        total_tokens: 150,
      },
    },
  });
  return events.map((event, sequence_number) => ({ ...event, sequence_number })) as ResponseStreamEvent[];
}

/**
 * The chunks of an OpenAI-compatible chat completion for `turn`, described the way Claude's are: thinking
 * becomes `reasoning_content`, and Kiki's tools tool calls (with ids `call_<index>`). These services have no
 * web search, so search blocks are left out. A "refusal" stop is a content filter.
 */
export function chatEvents(turn: FakeTurn, id: string, chunkChars?: number): ChatCompletionChunk[] {
  const chunks: object[] = [];
  const chunk = (delta: object, finish_reason: string | null = null) =>
    chunks.push({ id, object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason }] });
  let calls = 0;
  turn.blocks.forEach((block, index) => {
    if (block.type === "thinking") {
      for (const piece of pieces(block.thinking, chunkChars)) chunk({ reasoning_content: piece });
    } else if (block.type === "text") {
      for (const piece of pieces(block.text, chunkChars)) chunk({ content: piece });
    } else if (block.type === "tool_use") {
      const call = calls++;
      chunk({ tool_calls: [{ index: call, id: `call_${index}`, type: "function", function: { name: block.name, arguments: "" } }] });
      chunk({ tool_calls: [{ index: call, function: { arguments: JSON.stringify(block.input) } }] });
    }
  });
  const finish =
    turn.stopReason === "tool_use" ? "tool_calls" : turn.stopReason === "max_tokens" ? "length" : turn.stopReason === "refusal" ? "content_filter" : "stop";
  chunk({}, finish);
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model: "mock",
    choices: [],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 40 } },
  });
  return chunks as ChatCompletionChunk[];
}
