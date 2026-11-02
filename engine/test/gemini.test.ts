import type Anthropic from "@anthropic-ai/sdk";
import type { KikiEvent, ToolResult } from "@kiki/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_CLAUDE_CONFIG } from "../src/claude.ts";
import { runGeminiTurn, toGeminiSteps } from "../src/gemini.ts";
import { SYSTEM_PROMPT } from "../src/prompt.ts";
import { PROPOSAL_ACK } from "../src/tools.ts";
import type { TurnOptions } from "../src/turn.ts";
import { fakeGemini, type FakeResponse } from "./helpers.ts";

const QUESTION: Anthropic.Beta.BetaMessageParam = {
  role: "user",
  content: [{ type: "text", text: "<question>\nWhat is this?\n</question>" }],
};

async function run(responses: FakeResponse[], options: Partial<TurnOptions> = {}) {
  const fake = fakeGemini(responses);
  const events: KikiEvent[] = [];
  const result = await runGeminiTurn({
    client: fake.factory("AIza-test"),
    config: DEFAULT_CLAUDE_CONFIG,
    history: [QUESTION],
    emit: (event) => events.push(event),
    model: "gemini-3.8-flash",
    ...options,
  });
  return { result, events, requests: fake.requests };
}

const text = (events: KikiEvent[], type: "text" | "thinking") =>
  events.flatMap((e) => (e.type === type ? [e.delta] : [])).join("");

describe("runGeminiTurn", () => {
  it("streams thinking and an answer, and returns it as Claude messages", async () => {
    const { result, events, requests } = await run([
      { blocks: [{ type: "thinking", thinking: "Looking at the page." }, { type: "text", text: "Kiki is a word." }] },
    ]);
    expect(text(events, "thinking")).toBe("Looking at the page.");
    expect(text(events, "text")).toBe("Kiki is a word.");
    expect(events.filter((e) => e.type === "status").map((e) => e.phase)).toEqual(["thinking", "writing"]);
    expect(result).toMatchObject({
      kind: "answered",
      stopReason: "end_turn",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Kiki is a word." }] }],
      usage: { inputTokens: 60, cacheReadTokens: 40, outputTokens: 60 },
    });

    const [request] = requests;
    expect(request).toMatchObject({
      model: "gemini-3.8-flash",
      system_instruction: SYSTEM_PROMPT,
      store: false,
      tools: [{ type: "google_search" }, { type: "url_context" }],
      generation_config: { thinking_level: "low", thinking_summaries: "auto", max_output_tokens: DEFAULT_CLAUDE_CONFIG.maxTokens },
      input: [{ type: "user_input", content: [{ type: "text", text: "<question>\nWhat is this?\n</question>" }] }],
    });
    // Without Kiki's tools, Gemini picks its own tools.
    expect(request!.generation_config).not.toHaveProperty("tool_choice");
  });

  it("thinks at high for XHigh, and leaves out page reads when fetches are off", async () => {
    const { requests } = await run([{ blocks: [{ type: "text", text: "Ok." }] }], {
      effort: "xhigh",
      config: { ...DEFAULT_CLAUDE_CONFIG, maxFetches: 0 },
    });
    expect(requests[0]!.generation_config?.thinking_level).toBe("high");
    expect(requests[0]!.tools).toEqual([{ type: "google_search" }]);
  });

  it("reports Google searches, page reads and cited sources", async () => {
    const { result, events } = await run([
      {
        webSearches: 1,
        blocks: [
          { type: "server_tool_use", name: "web_search", query: "kiki release" },
          { type: "web_search_tool_result", results: [] },
          { type: "server_tool_use", name: "web_fetch", url: "https://example.com/notes" },
          { type: "web_fetch_tool_result", url: "https://example.com/notes", title: "Notes" },
          { type: "text", text: "Version 2.", citations: [{ url: "https://example.com/release", title: "Release" }] },
        ],
      },
    ]);
    expect(events).toContainEqual({ type: "status", phase: "searching", query: "kiki release" });
    expect(events).toContainEqual({ type: "activity", activity: { kind: "search", query: "kiki release" } });
    expect(events).toContainEqual({ type: "activity", activity: { kind: "read", url: "https://example.com/notes" } });
    expect(result).toMatchObject({ sources: [{ url: "https://example.com/release", title: "Release" }], usage: { webSearches: 1 } });
  });

  it("runs Kiki's tools, keeping Gemini's steps as they came for the rest of the turn", async () => {
    const { result, events, requests } = await run(
      [
        {
          stopReason: "tool_use",
          blocks: [
            { type: "thinking", thinking: "A task fits." },
            { type: "text", text: "Adding it." },
            { type: "tool_use", name: "propose_task", input: { title: "Renew passport", due: "2026-10-30" } },
          ],
        },
        { blocks: [{ type: "text", text: "Check the card." }] },
      ],
      { tools: { actions: true } },
    );
    expect(events).toContainEqual({ type: "notes", chars: "Adding it.".length });
    expect(events).toContainEqual(expect.objectContaining({ type: "action", action: expect.objectContaining({ kind: "task", title: "Renew passport" }) }));

    // Google Search alongside function calls needs validated mode.
    expect(requests[0]!.generation_config?.tool_choice).toBe("validated");
    expect(requests[0]!.tools!.map((tool) => ("name" in tool ? tool.name : tool.type))).toContain("propose_task");

    const second = requests[1]!.input as Array<Record<string, unknown>>;
    expect(second.slice(1)).toEqual([
      { type: "thought", summary: [{ type: "text", text: "A task fits." }], signature: "sig" },
      { type: "model_output", content: [{ type: "text", text: "Adding it." }] },
      { type: "function_call", id: "call_2", name: "propose_task", arguments: { title: "Renew passport", due: "2026-10-30" } },
      { type: "function_result", call_id: "call_2", name: "propose_task", result: [{ type: "text", text: PROPOSAL_ACK }] },
    ]);

    expect(result.kind === "answered" && result.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Adding it." },
          { type: "tool_use", id: "call_2", name: "propose_task", input: { title: "Renew passport", due: "2026-10-30" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_2", content: PROPOSAL_ACK }] },
      { role: "assistant", content: [{ type: "text", text: "Check the card." }] },
    ]);
  });

  it("sends the screen a scroll shows, screenshot included, back as the function's result", async () => {
    const calls: Array<{ id: string; name: string }> = [];
    const callTool = async (id: string, name: string): Promise<ToolResult> => {
      calls.push({ id, name });
      return {
        id,
        content: "Scrolled down.",
        screen: { text: "Second screen", screenshot: { mediaType: "image/jpeg", data: "abc=" } },
      };
    };
    const { requests } = await run(
      [
        { stopReason: "tool_use", blocks: [{ type: "tool_use", name: "scroll", input: { direction: "down" } }] },
        { blocks: [{ type: "text", text: "Found it." }] },
      ],
      { tools: { screen: true }, callTool },
    );
    expect(calls).toEqual([{ id: "call_0", name: "scroll" }]);
    const result = (requests[1]!.input as Array<{ type: string; result?: unknown }>).at(-1);
    expect(result).toMatchObject({
      type: "function_result",
      call_id: "call_0",
      result: [
        { type: "image", data: "abc=", mime_type: "image/jpeg" },
        { type: "text", text: expect.stringContaining("Second screen") },
      ],
    });
  });

  it("stops offering Kiki's tools after four rounds", async () => {
    const task = { stopReason: "tool_use", blocks: [{ type: "tool_use" as const, name: "propose_task", input: { title: "A" } }] };
    const { requests } = await run([task, task, task, task, { blocks: [{ type: "text", text: "Done." }] }], {
      tools: { actions: true },
    });
    expect(requests.map((r) => r.generation_config?.tool_choice)).toEqual([
      "validated",
      "validated",
      "validated",
      "validated",
      "none",
    ]);
  });

  it("reports safety blocks as refusals, and answers cut off by the token limit", async () => {
    expect((await run([{ stopReason: "refusal", blocks: [] }])).result.kind).toBe("refused");
    const cut = await run([{ stopReason: "max_tokens", blocks: [{ type: "text", text: "Part" }] }]);
    expect(cut.result).toMatchObject({ kind: "answered", stopReason: "max_tokens" });
  });

  it("throws API errors with their status", async () => {
    await expect(run([{ status: 401, errorType: "API key not valid" }])).rejects.toMatchObject({ status: 401 });
  });
});

describe("toGeminiSteps", () => {
  it("carries over the person's messages, the answers and Kiki's tools, but not Claude's own blocks", () => {
    const history: Anthropic.Beta.BetaMessageParam[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "png=" } },
          { type: "text", text: "What is this?" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Hmm.", signature: "claude-sig" },
          { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "kiki" } },
          { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] },
          { type: "text", text: "Looking." },
          { type: "tool_use", id: "toolu_1", name: "look", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "jpg=" } },
              { type: "text", text: "<visible_text>\nHello\n</visible_text>" },
            ],
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "It says hello." }] },
      { role: "user", content: "And?" },
    ];
    expect(toGeminiSteps(history)).toEqual([
      {
        type: "user_input",
        content: [
          { type: "image", data: "png=", mime_type: "image/png" },
          { type: "text", text: "What is this?" },
        ],
      },
      { type: "model_output", content: [{ type: "text", text: "Looking." }] },
      { type: "function_call", id: "toolu_1", name: "look", arguments: {} },
      {
        type: "function_result",
        call_id: "toolu_1",
        name: "look",
        result: [
          { type: "image", data: "jpg=", mime_type: "image/jpeg" },
          { type: "text", text: "<visible_text>\nHello\n</visible_text>" },
        ],
      },
      { type: "model_output", content: [{ type: "text", text: "It says hello." }] },
      { type: "user_input", content: [{ type: "text", text: "And?" }] },
    ]);
  });
});
