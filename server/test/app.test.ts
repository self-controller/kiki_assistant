import type { StartConversationRequest } from "@kiki/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { DEFAULT_CLAUDE_CONFIG } from "../src/claude.ts";
import { CodeStore } from "../src/codes.ts";
import { ConversationStore } from "../src/conversations.ts";
import type { SttConfig } from "../src/stt.ts";
import { fakeClient, readEvents, type FakeResponse } from "./helpers.ts";

const START: StartConversationRequest = {
  question: "What is this?",
  selection: "Kiki",
  context: { appName: "Zen", windowTitle: "Example page", text: "Some page text about Kiki." },
};

const IMAGE = { mediaType: "image/png" as const, data: "iVBORw0KGgo=" };

function setup(
  responses: FakeResponse[],
  dailyLimit = 10,
  extra: { stt?: SttConfig; sttFetch?: typeof fetch } = {},
) {
  const codes = new CodeStore(":memory:");
  const { code, record } = codes.create("tester", dailyLimit);
  const conversations = new ConversationStore();
  const fake = fakeClient(responses);
  const app = createApp({
    codes,
    conversations,
    client: fake.client,
    config: DEFAULT_CLAUDE_CONFIG,
    log: () => {},
    ...extra,
  });
  const post = (path: string, body: unknown, token = code) =>
    app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, codes, record, code, conversations, post, ...fake };
}

describe("POST /v1/conversations", () => {
  it("streams a plain answer and stores the turn", async () => {
    const t = setup([{ blocks: [{ type: "text", text: "Kiki is a word." }] }]);
    const response = await t.post("/v1/conversations", START);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = await readEvents(response);

    expect(events.map((e) => e.type)).toEqual(["conversation", "status", "status", "text", "text", "done"]);
    expect(events.filter((e) => e.type === "text").map((e) => e.delta).join("")).toBe("Kiki is a word.");
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });

    const id = (events[0] as { id: string }).id;
    const conversation = t.conversations.get(id, t.record.id)!;
    expect(conversation.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(t.codes.usedToday(t.record.id)).toBe(1);
  });

  it("sends the expected request to Claude", async () => {
    const t = setup([{ blocks: [{ type: "text", text: "ok" }] }]);
    await readEvents(await t.post("/v1/conversations", START));
    const request = t.requests[0]!;
    expect(request.model).toBe("claude-opus-5-5");
    expect(request.output_config).toEqual({ effort: "low" });
    expect(request.cache_control).toEqual({ type: "ephemeral" });
    expect(request.fallbacks).toBe("default");
    expect(request.tools).toEqual([
      { type: "web_search_20260209", name: "web_search", max_uses: 3 },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 2, max_content_tokens: 8000 },
    ]);
    expect(request.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(t.headers[0]!["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
  });

  it("reports web searches and cited sources", async () => {
    const t = setup([
      {
        webSearches: 1,
        blocks: [
          { type: "server_tool_use", name: "web_search", query: "kiki latest release" },
          {
            type: "web_search_tool_result",
            results: [
              { url: "https://example.com/a", title: "A" },
              { url: "https://example.com/b", title: "B" },
            ],
          },
          { type: "text", text: "Version 2 is out.", citations: [{ url: "https://example.com/b", title: "B" }] },
        ],
      },
    ]);
    const events = await readEvents(await t.post("/v1/conversations", START));
    expect(events).toContainEqual({ type: "status", phase: "searching", query: "kiki latest release" });
    expect(events).toContainEqual({ type: "sources", items: [{ url: "https://example.com/b", title: "B" }] });
    expect(t.codes.usage(1)[0]!.webSearches).toBe(1);
  });

  it("streams thinking summaries and what Kiki searches and reads", async () => {
    const t = setup([
      {
        blocks: [
          { type: "thinking", thinking: "**Checking versions.** I'll search." },
          { type: "server_tool_use", name: "web_search", query: "kiki release" },
          {
            type: "web_search_tool_result",
            results: [
              { url: "https://example.com/a", title: "A" },
              { url: "https://example.org/b", title: "B" },
            ],
          },
          { type: "thinking", thinking: "Reading the release notes." },
          { type: "server_tool_use", name: "web_fetch", url: "https://example.com/a" },
          { type: "web_fetch_tool_result", url: "https://example.com/a", title: "Release notes" },
          { type: "text", text: "Version 2." },
        ],
      },
    ]);
    const events = await readEvents(await t.post("/v1/conversations", START));
    const thinking = events.flatMap((e) => (e.type === "thinking" ? [e.delta] : [])).join("");
    expect(thinking).toBe("**Checking versions.** I'll search.\n\nReading the release notes.");
    expect(events.flatMap((e) => (e.type === "activity" ? [e.activity] : []))).toEqual([
      { kind: "search", query: "kiki release" },
      {
        kind: "results",
        sources: [
          { url: "https://example.com/a", title: "A" },
          { url: "https://example.org/b", title: "B" },
        ],
      },
      { kind: "read", url: "https://example.com/a" },
      { kind: "read", url: "https://example.com/a", title: "Release notes" },
    ]);
    // Thinking blocks stay in the stored history unchanged.
    const id = (events[0] as { id: string }).id;
    const stored = t.conversations.get(id, t.record.id)!.messages[1]!.content as Array<{ type: string }>;
    expect(stored.filter((block) => block.type === "thinking")).toHaveLength(2);
  });

  it("applies the Search and Think toggles and attaches images", async () => {
    const t = setup([{ blocks: [{ type: "text", text: "ok" }] }]);
    await readEvents(
      await t.post("/v1/conversations", { ...START, images: [IMAGE], options: { search: true, think: true } }),
    );
    const request = t.requests[0]!;
    expect(request.output_config).toEqual({ effort: "high" });
    const content = (request.messages as Array<{ content: Array<{ type: string; text?: string }> }>)[0]!.content;
    expect(content.map((block) => block.type)).toEqual(["image", "text"]);
    expect(content[1]!.text).toContain("The person attached an image.");
    expect(content[1]!.text).toMatch(/<\/question>\n\n<kiki_request>Search the web before answering.<\/kiki_request>$/);
  });

  it("uses the model and effort picked in the composer", async () => {
    const t = setup([{ blocks: [{ type: "text", text: "ok" }] }]);
    await readEvents(
      await t.post("/v1/conversations", { ...START, options: { model: "sonnet", effort: "xhigh", think: false } }),
    );
    const request = t.requests[0]!;
    expect(request.model).toBe("claude-sonnet-5-5");
    expect(request.output_config).toEqual({ effort: "xhigh" });
    expect(request.fallbacks).toBe("default");
  });

  it("gives Haiku the basic web tools and no fallbacks", async () => {
    const t = setup([{ blocks: [{ type: "text", text: "ok" }] }]);
    await readEvents(await t.post("/v1/conversations", { ...START, options: { model: "haiku", effort: "medium" } }));
    const request = t.requests[0]!;
    expect(request.model).toBe("claude-haiku-5-5");
    expect(request.output_config).toEqual({ effort: "medium" });
    expect((request.tools as Array<{ type: string }>).map((tool) => tool.type)).toEqual([
      "web_search_20250305",
      "web_fetch_20250910",
    ]);
    expect(request.fallbacks).toBeUndefined();
    expect(request.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("rejects models and effort levels the composer doesn't offer", async () => {
    const t = setup([]);
    expect((await t.post("/v1/conversations", { ...START, options: { model: "gpt" } })).status).toBe(400);
    expect((await t.post("/v1/conversations", { ...START, options: { effort: "max" } })).status).toBe(400);
  });

  it("rejects too many images", async () => {
    const t = setup([]);
    const response = await t.post("/v1/conversations", { ...START, images: [IMAGE, IMAGE, IMAGE, IMAGE] });
    expect(response.status).toBe(400);
  });

  it("falls back to search results when nothing is cited", async () => {
    const t = setup([
      {
        blocks: [
          { type: "server_tool_use", name: "web_search", query: "q" },
          { type: "web_search_tool_result", results: [{ url: "https://example.com/a", title: "A" }] },
          { type: "text", text: "Answer." },
        ],
      },
    ]);
    const events = await readEvents(await t.post("/v1/conversations", START));
    expect(events).toContainEqual({ type: "sources", items: [{ url: "https://example.com/a", title: "A" }] });
  });

  it("resumes after pause_turn by resending the paused assistant turn", async () => {
    const t = setup([
      { stopReason: "pause_turn", blocks: [{ type: "server_tool_use", name: "web_search", query: "q" }] },
      { blocks: [{ type: "text", text: "Done." }] },
    ]);
    const events = await readEvents(await t.post("/v1/conversations", START));
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });

    const second = t.requests[1]!.messages as Array<{ role: string }>;
    expect(second.map((m) => m.role)).toEqual(["user", "assistant"]);
    const id = (events[0] as { id: string }).id;
    expect(t.conversations.get(id, t.record.id)!.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);
  });

  it("reports refusals and discards the conversation", async () => {
    const t = setup([{ stopReason: "refusal", blocks: [] }]);
    const events = await readEvents(await t.post("/v1/conversations", START));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "refused" });
    expect(t.conversations.size).toBe(0);
  });

  it("maps Claude overload to an upstream error and refunds the request", async () => {
    const t = setup([{ status: 529, errorType: "overloaded_error" }]);
    const events = await readEvents(await t.post("/v1/conversations", START));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "upstream" });
    expect(t.codes.usedToday(t.record.id)).toBe(0);
  });

  it("rejects bad codes, invalid bodies, and requests over the daily limit", async () => {
    const t = setup([{ blocks: [{ type: "text", text: "ok" }] }], 1);
    expect((await t.post("/v1/conversations", START, "kiki_wrong")).status).toBe(401);
    expect((await t.post("/v1/conversations", { question: "" })).status).toBe(400);

    await readEvents(await t.post("/v1/conversations", START));
    const limited = await t.post("/v1/conversations", START);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: "limit" } });

    t.codes.revoke("tester");
    expect((await t.post("/v1/conversations", START)).status).toBe(401);
  });

  it("rejects oversized screenshots", async () => {
    const t = setup([]);
    const response = await t.post("/v1/conversations", {
      ...START,
      context: { screenshot: { mediaType: "image/jpeg", data: "A".repeat(4_000_004) } },
    });
    expect(response.status).toBe(400);
  });
});

describe("follow-ups", () => {
  it("continues the conversation with full history", async () => {
    const t = setup([
      { blocks: [{ type: "text", text: "First." }] },
      { blocks: [{ type: "text", text: "Second." }] },
    ]);
    const first = await readEvents(await t.post("/v1/conversations", START));
    const id = (first[0] as { id: string }).id;
    const second = await readEvents(await t.post(`/v1/conversations/${id}/messages`, { question: "And?" }));
    expect(second.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    const sent = t.requests[1]!.messages as Array<{ role: string; content: unknown }>;
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(sent[2]!.content).toEqual([{ type: "text", text: "And?" }]);
    expect(t.requests[1]!.output_config).toEqual({ effort: "low" });
  });

  it("carries images and toggles on follow-ups", async () => {
    const t = setup([
      { blocks: [{ type: "text", text: "First." }] },
      { blocks: [{ type: "text", text: "Second." }] },
    ]);
    const first = await readEvents(await t.post("/v1/conversations", START));
    const id = (first[0] as { id: string }).id;
    await readEvents(
      await t.post(`/v1/conversations/${id}/messages`, {
        question: "And this?",
        images: [IMAGE, IMAGE],
        options: { think: true },
      }),
    );
    const sent = t.requests[1]!.messages as Array<{ content: Array<{ type: string; text?: string }> }>;
    const last = sent.at(-1)!.content;
    expect(last.map((block) => block.type)).toEqual(["image", "image", "text"]);
    expect(last[2]!.text).toBe("The person attached 2 images.\n\n<question>\nAnd this?\n</question>");
    expect(t.requests[1]!.output_config).toEqual({ effort: "high" });
  });

  it("can switch models between turns", async () => {
    const t = setup([
      { blocks: [{ type: "text", text: "First." }] },
      { blocks: [{ type: "text", text: "Second." }] },
    ]);
    const first = await readEvents(await t.post("/v1/conversations", { ...START, options: { model: "opus" } }));
    const id = (first[0] as { id: string }).id;
    await readEvents(
      await t.post(`/v1/conversations/${id}/messages`, { question: "And?", options: { model: "haiku", effort: "low" } }),
    );
    expect(t.requests.map((request) => request.model)).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
    // The history goes along unchanged, assistant turn included.
    expect((t.requests[1]!.messages as unknown[]).length).toBe(3);
  });

  it("returns 404 for unknown conversations and 409 while busy", async () => {
    const t = setup([]);
    const missing = await t.post("/v1/conversations/nope/messages", { question: "Hi" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "expired" } });

    const conversation = t.conversations.create(t.record.id);
    conversation.busy = true;
    const busy = await t.post(`/v1/conversations/${conversation.id}/messages`, { question: "Hi" });
    expect(busy.status).toBe(409);
  });
});

describe("GET /v1/me", () => {
  it("returns the code's name, usage, and features", async () => {
    const t = setup([]);
    const response = await t.app.request("/v1/me", { headers: { authorization: `Bearer ${t.code}` } });
    expect(await response.json()).toEqual({
      name: "tester",
      usedToday: 0,
      dailyLimit: 10,
      features: { voice: false },
    });
  });
});

describe("POST /v1/transcribe", () => {
  const STT: SttConfig = { url: "https://stt.example/v1", key: "stt-key", model: "whisper-test" };
  const audio = new Uint8Array([1, 2, 3, 4]);

  function sendAudio(t: ReturnType<typeof setup>, body: Uint8Array, type = "audio/webm;codecs=opus") {
    return t.app.request("/v1/transcribe", {
      method: "POST",
      headers: { authorization: `Bearer ${t.code}`, "content-type": type },
      body,
    });
  }

  it("is off unless the server has speech-to-text set up", async () => {
    const t = setup([]);
    const response = await sendAudio(t, audio);
    expect(response.status).toBe(501);
  });

  it("forwards the recording to the transcription endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const sttFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return Response.json({ text: " what is this? " });
    }) as typeof fetch;
    const t = setup([], 10, { stt: STT, sttFetch });

    const me = await t.app.request("/v1/me", { headers: { authorization: `Bearer ${t.code}` } });
    expect(await me.json()).toMatchObject({ features: { voice: true } });

    const response = await sendAudio(t, audio);
    expect(await response.json()).toEqual({ text: "what is this?" });
    expect(calls[0]!.url).toBe("https://stt.example/v1/audio/transcriptions");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer stt-key");
    const form = calls[0]!.init.body as FormData;
    expect(form.get("model")).toBe("whisper-test");
    const file = form.get("file") as File;
    expect(file.name).toBe("question.webm");
    expect(file.size).toBe(4);
    // Voice doesn't use up questions.
    expect(t.codes.usedToday(t.record.id)).toBe(0);
  });

  it("rejects other formats, oversized recordings, and upstream failures", async () => {
    const sttFetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const t = setup([], 10, { stt: STT, sttFetch });
    expect((await sendAudio(t, audio, "text/plain")).status).toBe(415);
    expect((await sendAudio(t, new Uint8Array(2 * 1024 * 1024 + 1))).status).toBe(413);
    const failed = await sendAudio(t, audio);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: { code: "upstream" } });
  });
});
