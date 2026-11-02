import type Anthropic from "@anthropic-ai/sdk";
import type { KikiEvent, ToolAccess, ToolResult } from "@kiki/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_CLAUDE_CONFIG } from "../src/claude.ts";
import { NO_WEB_NOTE, rejectsTools, runCompatibleTurn, ThinkSplitter, toChatMessages } from "../src/compatible.ts";
import { classifyError, type Route } from "../src/models.ts";
import { MAX_TOOL_ROUNDS } from "../src/turn.ts";
import { fakeCompatible, type FakeResponse } from "./helpers.ts";

const QUESTION: Anthropic.Beta.BetaMessageParam = { role: "user", content: [{ type: "text", text: "<question>\nWhat is this?\n</question>" }] };
const IMAGE = { type: "base64" as const, media_type: "image/png" as const, data: "iVBORw0KGgo=" };

async function run(responses: Array<FakeResponse | { error: Error }>, tools: ToolAccess = { actions: true, screen: true }) {
  const fake = fakeCompatible(responses);
  const events: KikiEvent[] = [];
  const result = await runCompatibleTurn({
    client: fake.factory({ baseUrl: "http://localhost:11434/v1" }),
    model: "qwen3:8b",
    config: DEFAULT_CLAUDE_CONFIG,
    history: [QUESTION],
    emit: (event) => events.push(event),
    tools,
    callTool: async (id): Promise<ToolResult> => ({ id, content: "Done.", screen: { text: "On screen." } }),
  });
  return { result, events, ...fake };
}

describe("toChatMessages", () => {
  it("carries text, images, and Kiki's tool calls with their results", () => {
    const messages = toChatMessages([
      { role: "user", content: [{ type: "image", source: IMAGE }, { type: "text", text: "Q1" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Claude's own.", signature: "s" },
          { type: "text", text: "Looking." },
          { type: "tool_use", id: "toolu_1", name: "look", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "image", source: IMAGE }, { type: "text", text: "<visible_text>x</visible_text>" }] }],
      },
      { role: "assistant", content: [{ type: "text", text: "It's x." }] },
      { role: "user", content: [{ type: "text", text: "Q2" }] },
    ]);
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${IMAGE.data}` } },
          { type: "text", text: "Q1" },
        ],
      },
      { role: "assistant", content: "Looking.", tool_calls: [{ id: "toolu_1", type: "function", function: { name: "look", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "toolu_1", content: "<visible_text>x</visible_text>" },
      // The screenshot from the tool, which a tool message can't carry.
      {
        role: "user",
        content: [
          { type: "text", text: "The screen after that:" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${IMAGE.data}` } },
        ],
      },
      { role: "assistant", content: "It's x." },
      { role: "user", content: "Q2" },
    ]);
  });

  it("turns tool calls and results into text for a model without tools", () => {
    const messages = toChatMessages(
      [
        QUESTION,
        { role: "assistant", content: [{ type: "tool_use", id: "a", name: "list_tasks", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "No tasks.", is_error: false }] },
        { role: "assistant", content: [{ type: "text", text: "None." }] },
      ],
      false,
    );
    expect(messages.slice(1)).toEqual([
      { role: "assistant", content: "[I used list_tasks {}]" },
      { role: "user", content: "[list_tasks result]\nNo tasks." },
      { role: "assistant", content: "None." },
    ]);
  });
});

describe("ThinkSplitter", () => {
  it("splits a leading <think> block from the answer, across cut tags", () => {
    const splitter = new ThinkSplitter();
    const parts = ["  <thi", "nk>Pondering", " this.</th", "ink>\n\nThe answer", "."].map((chunk) => splitter.push(chunk));
    parts.push(splitter.end());
    expect(parts.map((part) => part.thinking).join("")).toBe("Pondering this.");
    expect(parts.map((part) => part.text).join("")).toBe("The answer.");
  });

  it("leaves answers without one alone", () => {
    const splitter = new ThinkSplitter();
    expect(splitter.push("<b>Bold</b>")).toEqual({ thinking: "", text: "<b>Bold</b>" });
    expect(splitter.push(" <think> later")).toEqual({ thinking: "", text: " <think> later" });
  });
});

describe("runCompatibleTurn", () => {
  it("streams reasoning and the answer, and says it can't search", async () => {
    const { result, events, requests } = await run([{ blocks: [{ type: "thinking", thinking: "Hm." }, { type: "text", text: "It's a page." }] }]);
    expect(events.filter((e) => e.type === "thinking").map((e) => e.delta).join("")).toBe("Hm.");
    expect(events.filter((e) => e.type === "text").map((e) => e.delta).join("")).toBe("It's a page.");
    expect(result).toMatchObject({ kind: "answered", stopReason: "end_turn", messages: [{ role: "assistant", content: [{ type: "text", text: "It's a page." }] }] });
    expect((requests[0]!.messages[0] as { content: string }).content).toContain(NO_WEB_NOTE);
    expect(requests[0]!.tools?.map((tool) => (tool.type === "function" ? tool.function.name : ""))).toContain("look");
  });

  it("runs Kiki's tools and continues with their results", async () => {
    const { result, events, requests } = await run([
      { stopReason: "tool_use", blocks: [{ type: "text", text: "Looking." }, { type: "tool_use", name: "look", input: {} }] },
      { blocks: [{ type: "text", text: "It says x." }] },
    ]);
    expect(events).toContainEqual({ type: "notes", chars: 8 });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call", name: "look" }));
    expect(result.kind === "answered" && result.messages.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
    const second = requests[1]!.messages;
    expect(second.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect(String((second.at(-1) as { content: string }).content)).toContain("On screen.");
  });

  it("asks again without tools when the model can't take them", async () => {
    const noTools = Object.assign(new Error('400 registry.ollama.ai/library/gemma:2b does not support tools'), { status: 400 });
    const { result, requests } = await run([{ error: noTools }, { blocks: [{ type: "text", text: "Plain." }] }]);
    expect(result.kind).toBe("answered");
    expect(requests[0]!.tools).toBeDefined();
    expect(requests[1]!.tools).toBeUndefined();
    expect(rejectsTools(noTools)).toBe(true);
    expect(rejectsTools(Object.assign(new Error("400 bad image"), { status: 400 }))).toBe(false);
  });

  it("tells the model it's out of tool rounds, and stops offering tools at the end", async () => {
    const call = { stopReason: "tool_use", blocks: [{ type: "tool_use" as const, name: "list_tasks", input: {} }] };
    const { result, requests } = await run([...Array.from({ length: MAX_TOOL_ROUNDS + 1 }, () => call), { blocks: [{ type: "text", text: "Done." }] }], {
      actions: true,
      tasksRead: true,
    });
    expect(result.kind).toBe("answered");
    expect(requests[MAX_TOOL_ROUNDS - 1]!.tool_choice).toBeUndefined();
    expect(requests[MAX_TOOL_ROUNDS]!.tool_choice).toBe("none");
    // The model ignored "none": it hears it's out of rounds.
    expect(JSON.stringify(requests.at(-1)!.messages.at(-1))).toContain("That's all the tool use");
  });

  it("treats an empty answer as an error, and a content filter as a refusal", async () => {
    await expect(run([{ blocks: [] }])).rejects.toThrow("empty answer");
    const { result } = await run([{ stopReason: "refusal", blocks: [] }]);
    expect(result.kind).toBe("refused");
  });
});

describe("errors from models the person added", () => {
  const route: Route = { kind: "compatible", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "llama9" };
  const error = (status: number, message: string) => Object.assign(new Error(message), { status });

  it("says how to get a model a local server doesn't have", () => {
    expect(classifyError(route, error(404, 'model "llama9" not found, try pulling it first'))).toMatchObject({
      code: "upstream",
      message: "Ollama doesn't have the model llama9. Get it with `ollama pull llama9`.",
    });
  });

  it("says when the model can't read images, or the conversation is too long for it", () => {
    expect(classifyError(route, error(400, "this model does not support image input"))).toMatchObject({ code: "invalid" });
    expect(classifyError(route, error(400, "context length exceeded"))).toMatchObject({ code: "limit" });
  });
});
