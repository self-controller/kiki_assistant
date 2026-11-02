import { describe, expect, it } from "vitest";
import { ConversationStore } from "../src/conversations.ts";
import {
  agentEnv,
  claudeCodeStatus,
  codexStatus,
  findExecutable,
  parseClaudeStatus,
  parseCodexStatus,
  resetNote,
  versionOf,
} from "../src/accounts.ts";
import { MAX_TOOL_ROUNDS, OUT_OF_TOOL_ROUNDS, ToolBudget, TurnTranscript } from "../src/turn.ts";

describe("the person's Claude Code and Codex", () => {
  it("reads how Claude Code is signed in, without anything else from its status", () => {
    expect(parseClaudeStatus('{"loggedIn": true, "authMethod": "claude.ai", "email": "a@b.c", "subscriptionType": "pro"}')).toEqual({
      signedIn: true,
      account: "Claude Pro",
    });
    expect(parseClaudeStatus('{"loggedIn": true, "authMethod": "claude.ai"}')).toEqual({ signedIn: true, account: "a Claude account" });
    expect(parseClaudeStatus('{"loggedIn": true, "authMethod": "api_key"}')).toEqual({ signedIn: true, account: "an API key" });
    expect(parseClaudeStatus('{"loggedIn": false, "authMethod": "none"}')).toEqual({ signedIn: false });
    expect(parseClaudeStatus("error: unknown command")).toEqual({ signedIn: false });
  });

  it("reads how Codex is signed in", () => {
    expect(parseCodexStatus("Logged in using ChatGPT\n")).toEqual({ signedIn: true, account: "ChatGPT" });
    expect(parseCodexStatus("Logged in using an API key - sk-proj-***\n")).toEqual({ signedIn: true, account: "an API key" });
    expect(parseCodexStatus("Not logged in\n")).toEqual({ signedIn: false });
  });

  it("reads versions from either tool", () => {
    expect(versionOf("2.1.308 (Claude Code)")).toBe("2.1.308");
    expect(versionOf("codex-cli 0.163.0")).toBe("0.163.0");
    expect(versionOf("")).toBeUndefined();
  });

  it("puts the status together, or says it isn't installed", async () => {
    const run = async (_command: string, args: string[]) =>
      args[0] === "--version" ? "2.1.308 (Claude Code)\n" : '{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max"}';
    expect(await claudeCodeStatus(run, "/bin/claude")).toEqual({ path: "/bin/claude", version: "2.1.308", signedIn: true, account: "Claude Max" });
    expect(await claudeCodeStatus(run, null)).toEqual({ path: null, signedIn: false });
    expect(await codexStatus(async () => "Not logged in", "/bin/codex")).toEqual({ path: "/bin/codex", signedIn: false });
  });

  it("finds tools on PATH, or where they install themselves when PATH leaves that out", () => {
    expect(findExecutable("sh", { PATH: "/usr/bin:/bin" })).toMatch(/\/sh$/);
    expect(findExecutable("kiki-no-such-tool", { PATH: "/usr/bin" }, "/nonexistent")).toBeNull();
  });

  it("runs the agents without API keys or a parent Claude Code session's variables", () => {
    expect(
      agentEnv({
        PATH: "/usr/bin",
        HOME: "/home/x",
        ANTHROPIC_API_KEY: "sk-ant",
        ANTHROPIC_AUTH_TOKEN: "t",
        OPENAI_API_KEY: "sk",
        CODEX_API_KEY: "sk",
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "s",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/home/x", CLAUDE_CODE_OAUTH_TOKEN: "oauth" });
  });

  it("says when a limit resets, with the day when it's further out", () => {
    const now = Date.UTC(2026, 9, 22, 12);
    expect(resetNote(undefined, now)).toBe("");
    expect(resetNote(now / 1000 + 3600, now)).toMatch(/^ \(it resets at \d{1,2}:\d{2}/);
    expect(resetNote(now / 1000 + 3 * 86400, now)).toMatch(/^ \(it resets \w+ at /);
  });
});

describe("ToolBudget", () => {
  it("counts one round per response, and refuses calls past the last round", () => {
    const budget = new ToolBudget();
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      budget.newResponse();
      expect(budget.check("open_search")).toBeNull();
      expect(budget.check("propose_task")).toBeNull();
    }
    budget.newResponse();
    // Scrolling doesn't use up rounds while there are screen steps left.
    expect(budget.check("scroll")).toBeNull();
    expect(budget.check("open_search")).toBe(OUT_OF_TOOL_ROUNDS);
  });
});

describe("TurnTranscript", () => {
  it("pairs each response's calls with their results, whatever order they finish in", () => {
    const transcript = new TurnTranscript();
    transcript.text("Looking.");
    transcript.toolUse({ id: "a", name: "look", input: {} });
    transcript.result({ type: "tool_result", tool_use_id: "a", content: "Screen." });
    transcript.toolUse({ id: "b", name: "open_search", input: { where: "web", query: "x" } });
    transcript.newResponse();
    // Text before a web search, then the answer: one message.
    transcript.text("Searching.");
    transcript.newResponse();
    transcript.text("Done.");
    expect(transcript.messages()).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking." },
          { type: "tool_use", id: "a", name: "look", input: {} },
          { type: "tool_use", id: "b", name: "open_search", input: { where: "web", query: "x" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "Screen." },
          { type: "tool_result", tool_use_id: "b", content: "Cancelled.", is_error: true },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Searching." }, { type: "text", text: "Done." }] },
    ]);
  });
});

describe("ConversationStore removal", () => {
  it("lets go of a conversation's agent session when it's deleted or expires", () => {
    let now = 0;
    const removed: string[] = [];
    const store = new ConversationStore({ ttlMs: 10, now: () => now, onRemove: (c) => removed.push(c.id) });
    const deleted = store.create();
    const expired = store.create();
    store.delete(deleted.id);
    now = 100;
    store.sweep();
    expect(removed).toEqual([deleted.id, expired.id]);
  });
});
