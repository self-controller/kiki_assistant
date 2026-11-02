import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import type { KikiEvent, ToolResult } from "@kiki/shared";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CLAUDE_CONFIG } from "../src/claude.ts";
import { CodexAppServer, configuredMcpServers, runCodexTurn } from "../src/codex.ts";
import { PlanError } from "../src/accounts.ts";
import { SYSTEM_PROMPT } from "../src/prompt.ts";
import type { AgentSession, TurnOptions } from "../src/turn.ts";

const FAKE = fileURLToPath(new URL("./fakeCodex.mjs", import.meta.url));

const QUESTION: Anthropic.Beta.BetaMessageParam = {
  role: "user",
  content: [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    { type: "text", text: "<question>\nWhat is this?\n</question>" },
  ],
};

type Step = Record<string, unknown>;

const servers: CodexAppServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A Codex app server that plays `turns`, with a config.toml naming two MCP servers. */
function fakeServer(turns: Step[][], extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kiki-codex-test-"));
  const logFile = join(dir, "log.jsonl");
  writeFileSync(join(dir, "config.toml"), '[mcp_servers.rea]\ncommand = "npx"\n\n[mcp_servers."node-repl"]\ncommand = "x"\n[mcp_servers."node-repl".env]\nA = "1"\n');
  const server = new CodexAppServer({ command: process.execPath, args: [FAKE, JSON.stringify({ logFile, turns, ...extra })], codexHome: dir });
  servers.push(server);
  const log = () =>
    readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, any>);
  const requests = (method: string) => log().flatMap((entry) => (entry["received"]?.method === method ? [entry["received"].params] : []));
  return { server, log, requests };
}

async function run(server: CodexAppServer, options: Partial<TurnOptions> = {}) {
  const events: KikiEvent[] = [];
  const result = await runCodexTurn({
    codex: server,
    config: DEFAULT_CLAUDE_CONFIG,
    history: [QUESTION],
    emit: (event) => events.push(event),
    model: "gpt-6-luna",
    callTool: async (id, name): Promise<ToolResult> =>
      name === "scroll"
        ? { id, content: "Scrolled down.", screen: { text: "More.", screenshot: { mediaType: "image/png", data: "AAAA" } } }
        : { id, content: "Opened." },
    ...options,
  });
  return { result, events };
}

const text = (events: KikiEvent[], type: "text" | "thinking") =>
  events.flatMap((e) => (e.type === type ? [e.delta] : [])).join("");

const ANSWER: Step[] = [
  { notify: "item/started", params: { item: { type: "reasoning", id: "rs_1", summary: [], content: [] } } },
  { notify: "item/reasoning/summaryTextDelta", params: { itemId: "rs_1", summaryIndex: 0, delta: "Looking." } },
  { notify: "item/reasoning/summaryTextDelta", params: { itemId: "rs_1", summaryIndex: 1, delta: "It's a word." } },
  { notify: "item/started", params: { item: { type: "agentMessage", id: "msg_1", text: "" } } },
  { notify: "item/agentMessage/delta", params: { itemId: "msg_1", delta: "Kiki is " } },
  { notify: "item/agentMessage/delta", params: { itemId: "msg_1", delta: "a word." } },
  { notify: "item/completed", params: { item: { type: "agentMessage", id: "msg_1", text: "Kiki is a word." } } },
  {
    notify: "thread/tokenUsage/updated",
    params: { tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 0, outputTokens: 50 } } },
  },
  { complete: "completed" },
];

describe("CodexAppServer and runCodexTurn", () => {
  it("starts Codex without its tools, the person's MCP servers or API keys, and streams an answer", async () => {
    process.env.OPENAI_API_KEY = "sk-person";
    const fake = fakeServer([ANSWER]);
    try {
      const { result, events } = await run(fake.server, { effort: "medium", tools: { open: true } });
      expect(text(events, "thinking")).toBe("Looking.\n\nIt's a word.");
      expect(text(events, "text")).toBe("Kiki is a word.");
      expect(result).toEqual({
        kind: "answered",
        messages: [{ role: "assistant", content: [{ type: "text", text: "Kiki is a word." }] }],
        stopReason: "end_turn",
        sources: [],
        usage: { inputTokens: 60, outputTokens: 50, cacheReadTokens: 40, cacheWriteTokens: 0, webSearches: 0 },
        agent: { provider: "openai", id: "thread-1", key: expect.any(String) },
      });
    } finally {
      delete process.env.OPENAI_API_KEY;
    }

    const [start] = fake.log();
    expect(start!["env"]).toEqual({ OPENAI_API_KEY: false, ANTHROPIC_API_KEY: false });
    expect(start!["argv"]).toEqual(expect.arrayContaining(["app-server", "-c", "features.shell_tool=false", "features.unified_exec=false"]));
    expect(fake.requests("initialize")[0]).toMatchObject({ capabilities: { experimentalApi: true } });
    expect(fake.requests("thread/start")[0]).toMatchObject({
      model: "gpt-6-luna",
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: SYSTEM_PROMPT,
      ephemeral: true,
      dynamicTools: [{ type: "function", name: "open_search", inputSchema: expect.objectContaining({ type: "object" }) }],
      config: { web_search: "live", "mcp_servers.rea.enabled": false, "mcp_servers.node-repl.enabled": false },
    });
    expect(fake.requests("turn/start")[0]).toEqual({
      threadId: "thread-1",
      input: [
        { type: "image", url: "data:image/png;base64,iVBORw0KGgo=" },
        { type: "text", text: "<question>\nWhat is this?\n</question>", text_elements: [] },
      ],
      model: "gpt-6-luna",
      effort: "medium",
      summary: "auto",
    });
  });

  it("won't run when Codex isn't signed in", async () => {
    const fake = fakeServer([ANSWER], { account: null });
    const error = await run(fake.server).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlanError);
    expect(error).toMatchObject({ code: "unauthorized", message: expect.stringContaining("Run `codex login`") });
    expect(fake.requests("thread/start")).toEqual([]);
  });

  it("runs when the person's Codex is signed in with an API key: that's their account too", async () => {
    const fake = fakeServer([ANSWER], { account: { type: "apiKey" } });
    const { result } = await run(fake.server);
    expect(result.kind).toBe("answered");
  });

  it("runs Kiki's tools for Codex, screenshots included, and keeps them in the history", async () => {
    const fake = fakeServer([
      [
        { notify: "item/started", params: { item: { type: "agentMessage", id: "msg_0", text: "" } } },
        { notify: "item/agentMessage/delta", params: { delta: "Scrolling." } },
        { notify: "item/completed", params: { item: { type: "agentMessage", id: "msg_0", text: "Scrolling." } } },
        { notify: "item/started", params: { item: { type: "dynamicToolCall", id: "call_1", tool: "scroll", arguments: {} } } },
        { toolCall: { callId: "call_1", tool: "scroll", arguments: { direction: "down" } } },
        { notify: "thread/tokenUsage/updated", params: { tokenUsage: { last: { inputTokens: 10, outputTokens: 5 } } } },
        { notify: "item/started", params: { item: { type: "agentMessage", id: "msg_1", text: "" } } },
        { notify: "item/agentMessage/delta", params: { delta: "More below." } },
        { notify: "item/completed", params: { item: { type: "agentMessage", id: "msg_1", text: "More below." } } },
        { complete: "completed" },
      ],
    ]);
    const { result, events } = await run(fake.server, { tools: { screen: true } });
    expect(events).toContainEqual({ type: "notes", chars: "Scrolling.".length });
    expect(events).toContainEqual({ type: "tool_call", id: "call_1", name: "scroll", input: { direction: "down" } });
    const [response] = fake.log().flatMap((entry) => (entry["toolResponse"] ? [entry["toolResponse"]] : []));
    expect(response.result).toEqual({
      contentItems: [
        { type: "inputImage", imageUrl: "data:image/png;base64,AAAA" },
        { type: "inputText", text: expect.stringContaining("More.") },
      ],
      success: true,
    });
    expect(result).toMatchObject({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "Scrolling." }, { type: "tool_use", id: "call_1", name: "scroll" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1" }] },
        { role: "assistant", content: [{ type: "text", text: "More below." }] },
      ],
    });
  });

  it("reports web searches and their results as sources", async () => {
    const fake = fakeServer([
      [
        { notify: "item/started", params: { item: { type: "webSearch", id: "ws_1", query: "", action: null, results: null } } },
        {
          notify: "item/completed",
          params: {
            item: {
              type: "webSearch",
              id: "ws_1",
              query: "kiki release",
              action: { type: "search", query: "kiki release", queries: null },
              results: [{ type: "text_result", url: "https://example.com/release", title: "Release" }],
            },
          },
        },
        ...ANSWER,
      ],
    ]);
    const { result, events } = await run(fake.server);
    expect(events).toContainEqual({ type: "status", phase: "searching", query: "kiki release" });
    expect(events).toContainEqual({ type: "activity", activity: { kind: "search", query: "kiki release" } });
    expect(events).toContainEqual({ type: "activity", activity: { kind: "results", sources: [{ url: "https://example.com/release", title: "Release" }] } });
    expect(result).toMatchObject({ sources: [{ url: "https://example.com/release", title: "Release" }], usage: { webSearches: 1 } });
  });

  it("says when the plan's limit is used up, and when it resets", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const fake = fakeServer([
      [
        { notify: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 100, resetsAt }, secondary: { usedPercent: 40, resetsAt: resetsAt + 9999 } } } },
        { complete: "failed", error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" } },
      ],
    ]);
    const error = await run(fake.server).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlanError);
    expect(error).toMatchObject({ code: "limit", message: expect.stringMatching(/Codex limit for now \(it resets at .+\)\.$/) });
  });

  it("continues the conversation's thread, and starts a new one with the earlier turns when it's gone", async () => {
    const fake = fakeServer([ANSWER, ANSWER, ANSWER]);
    const first = await run(fake.server);
    const agent = first.result.kind === "answered" ? first.result.agent! : ({} as AgentSession);
    const history: Anthropic.Beta.BetaMessageParam[] = [
      QUESTION,
      { role: "assistant", content: [{ type: "text", text: "Kiki is a word." }] },
      { role: "user", content: [{ type: "text", text: "And then?" }] },
    ];
    const second = await run(fake.server, { history, agent });
    expect(second.result).toMatchObject({ agent: { id: "thread-1" } });
    expect(fake.requests("thread/start")).toHaveLength(1);
    expect(fake.requests("turn/start")[1]).toMatchObject({ threadId: "thread-1", input: [{ type: "text", text: "And then?" }] });

    // A thread the app server doesn't know (it restarted): a new thread gets the conversation so far.
    const third = await run(fake.server, { history, agent: { ...agent, id: "thread-gone" } });
    expect(third.result).toMatchObject({ agent: { id: "thread-2" } });
    const input = fake.requests("turn/start").at(-1).input as Array<{ type: string; text?: string }>;
    expect(input.map((item) => item.type)).toEqual(["image", "text"]);
    expect(input[1]!.text).toMatch(/^<earlier_turns>[\s\S]*You: Kiki is a word\.\n<\/earlier_turns>\n\nAnd then\?$/);
  });

  it("interrupts the turn when the question is cancelled", async () => {
    const thinking = { notify: "item/reasoning/summaryTextDelta", params: { itemId: "rs_1", summaryIndex: 0, delta: "Hm." } };
    const fake = fakeServer([[thinking, { waitInterrupt: true }]]);
    const controller = new AbortController();
    const running = run(fake.server, {
      signal: controller.signal,
      emit: (event) => {
        if (event.type === "thinking") controller.abort();
      },
    });
    await expect(running).rejects.toThrow("Request cancelled.");
    expect(fake.requests("turn/interrupt")).toEqual([{ threadId: "thread-1", turnId: "turn-1" }]);
  });

  it("doesn't start a turn for a question cancelled before it began", async () => {
    const fake = fakeServer([ANSWER]);
    await run(fake.server);
    const controller = new AbortController();
    controller.abort();
    await expect(run(fake.server, { signal: controller.signal })).rejects.toThrow("Request cancelled.");
    expect(fake.requests("turn/start")).toHaveLength(1);
  });
});

describe("configuredMcpServers", () => {
  it("finds the MCP servers in Codex's config.toml, not their sub-tables", () => {
    const toml = '[mcp_servers.rea]\ncommand = "npx"\n[mcp_servers.rea.env]\nA = "1"\n[mcp_servers."node-repl"]\n[profiles.x]\n';
    expect(configuredMcpServers(toml)).toEqual(["rea", "node-repl"]);
  });
});
