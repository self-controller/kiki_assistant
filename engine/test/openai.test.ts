import type Anthropic from "@anthropic-ai/sdk";
import type { KikiEvent, ToolResult } from "@kiki/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_CLAUDE_CONFIG } from "../src/claude.ts";
import { runOpenAITurn, toOpenAIInput } from "../src/openai.ts";
import { SYSTEM_PROMPT } from "../src/prompt.ts";
import { PROPOSAL_ACK } from "../src/tools.ts";
import type { TurnOptions } from "../src/turn.ts";
import { fakeOpenAI, type FakeResponse } from "./helpers.ts";

const QUESTION: Anthropic.Beta.BetaMessageParam = {
  role: "user",
  content: [{ type: "text", text: "<question>\nWhat is this?\n</question>" }],
};

async function run(responses: FakeResponse[], options: Partial<TurnOptions> = {}) {
  const fake = fakeOpenAI(responses);
  const events: KikiEvent[] = [];
  const result = await runOpenAITurn({
    client: fake.factory("sk-test"),
    config: DEFAULT_CLAUDE_CONFIG,
    history: [QUESTION],
    emit: (event) => events.push(event),
    model: "gpt-6.1-sol",
    conversationId: "conv-1",
    ...options,
  });
  return { result, events, requests: fake.requests };
}

const text = (events: KikiEvent[], type: "text" | "thinking") =>
  events.flatMap((e) => (e.type === type ? [e.delta] : [])).join("");

describe("runOpenAITurn", () => {
  it("streams reasoning summaries and an answer, and returns it as Claude messages", async () => {
    const { result, events, requests } = await run([
      {
        blocks: [
          { type: "thinking", thinking: "Looking at the page." },
          { type: "thinking", thinking: "It's a word." },
          { type: "text", text: "Kiki is a word." },
        ],
      },
    ]);
    expect(text(events, "thinking")).toBe("Looking at the page.\n\nIt's a word.");
    expect(text(events, "text")).toBe("Kiki is a word.");
    expect(result).toMatchObject({
      kind: "answered",
      stopReason: "end_turn",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Kiki is a word." }] }],
      usage: { inputTokens: 60, cacheReadTokens: 40, outputTokens: 50 },
    });
    expect(requests[0]).toEqual({
      model: "gpt-6.1-sol",
      instructions: SYSTEM_PROMPT,
      input: [{ role: "user", content: [{ type: "input_text", text: "<question>\nWhat is this?\n</question>" }] }],
      tools: [{ type: "web_search" }],
      reasoning: { effort: "low", summary: "auto" },
      max_output_tokens: DEFAULT_CLAUDE_CONFIG.maxTokens,
      store: false,
      include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
      prompt_cache_key: "conv-1",
    });
  });

  it("reports web searches, their results, page reads and cited sources", async () => {
    const { result, events } = await run([
      {
        blocks: [
          { type: "server_tool_use", name: "web_search", query: "kiki release" },
          { type: "web_search_tool_result", results: [{ url: "https://example.com/release", title: "Release" }] },
          { type: "server_tool_use", name: "web_fetch", url: "https://example.com/notes" },
          { type: "text", text: "Version 2.", citations: [{ url: "https://example.com/release", title: "Release notes" }] },
        ],
      },
    ]);
    expect(events).toContainEqual({ type: "status", phase: "searching", query: "kiki release" });
    expect(events).toContainEqual({ type: "activity", activity: { kind: "search", query: "kiki release" } });
    expect(events).toContainEqual({
      type: "activity",
      activity: { kind: "results", sources: [{ url: "https://example.com/release", title: "https://example.com/release" }] },
    });
    expect(events).toContainEqual({ type: "activity", activity: { kind: "read", url: "https://example.com/notes" } });
    expect(result).toMatchObject({ sources: [{ url: "https://example.com/release", title: "Release notes" }], usage: { webSearches: 1 } });
  });

  it("runs Kiki's tools, keeping OpenAI's items (and encrypted reasoning) for the rest of the turn", async () => {
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
    expect(events).toContainEqual(expect.objectContaining({ type: "action", action: expect.objectContaining({ kind: "task" }) }));
    expect(requests[0]!.tools).toContainEqual(expect.objectContaining({ type: "function", name: "propose_task", strict: false }));

    const second = requests[1]!.input as unknown[];
    expect(second.slice(1)).toEqual([
      expect.objectContaining({ type: "reasoning", encrypted_content: "enc" }),
      expect.objectContaining({ type: "message", id: "msg_1" }),
      expect.objectContaining({ type: "function_call", call_id: "call_2", name: "propose_task" }),
      { type: "function_call_output", call_id: "call_2", output: PROPOSAL_ACK },
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

  it("sends the screen a scroll shows, screenshot included, back as the call's output", async () => {
    const callTool = async (id: string): Promise<ToolResult> => ({
      id,
      content: "Scrolled down.",
      screen: { text: "Second screen", screenshot: { mediaType: "image/jpeg", data: "abc=" } },
    });
    const { requests } = await run(
      [
        { stopReason: "tool_use", blocks: [{ type: "tool_use", name: "scroll", input: { direction: "down" } }] },
        { blocks: [{ type: "text", text: "Found it." }] },
      ],
      { tools: { screen: true }, callTool },
    );
    expect((requests[1]!.input as unknown[]).at(-1)).toMatchObject({
      type: "function_call_output",
      call_id: "call_0",
      output: [
        { type: "input_image", image_url: "data:image/jpeg;base64,abc=" },
        { type: "input_text", text: expect.stringContaining("Second screen") },
      ],
    });
  });

  it("stops offering Kiki's tools after four rounds", async () => {
    const task = { stopReason: "tool_use", blocks: [{ type: "tool_use" as const, name: "propose_task", input: { title: "A" } }] };
    const { requests } = await run([task, task, task, task, { blocks: [{ type: "text", text: "Done." }] }], {
      tools: { actions: true },
    });
    expect(requests.map((r) => r.tool_choice)).toEqual([undefined, undefined, undefined, undefined, "none"]);
  });

  it("reports refusals, and answers cut off by the token limit", async () => {
    expect((await run([{ stopReason: "refusal", blocks: [] }])).result.kind).toBe("refused");
    const cut = await run([{ stopReason: "max_tokens", blocks: [{ type: "text", text: "Part" }] }]);
    expect(cut.result).toMatchObject({ kind: "answered", stopReason: "max_tokens" });
  });

  it("throws API errors with their status", async () => {
    await expect(run([{ status: 429, errorType: "quota" }])).rejects.toMatchObject({ status: 429 });
  });
});

describe("toOpenAIInput", () => {
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
          { type: "text", text: "Looking." },
          { type: "tool_use", id: "toolu_1", name: "look", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Nothing on screen.", is_error: true }],
      },
      { role: "assistant", content: [{ type: "text", text: "It's empty." }] },
      { role: "user", content: "And?" },
    ];
    expect(toOpenAIInput(history)).toEqual([
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,png=", detail: "auto" },
          { type: "input_text", text: "What is this?" },
        ],
      },
      { role: "assistant", content: "Looking." },
      { type: "function_call", call_id: "toolu_1", name: "look", arguments: "{}" },
      { type: "function_call_output", call_id: "toolu_1", output: "Error: Nothing on screen." },
      { role: "assistant", content: "It's empty." },
      { role: "user", content: [{ type: "input_text", text: "And?" }] },
    ]);
  });
});
