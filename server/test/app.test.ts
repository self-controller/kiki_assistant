import type { StartConversationRequest } from "@kiki/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { DEFAULT_CLAUDE_CONFIG } from "../src/claude.ts";
import { CodeStore } from "../src/codes.ts";
import { ConversationStore } from "../src/conversations.ts";
import { SYSTEM_PROMPT } from "../src/prompt.ts";
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

  it("starts a conversation that continues earlier turns", async () => {
    const t = setup([{ blocks: [{ type: "text", text: "Third." }] }]);
    const earlier = [
      { question: "What is this?", answer: "First." },
      { question: "And?", answer: "Second." },
    ];
    const events = await readEvents(
      await t.post("/v1/conversations", { ...START, question: "One more?", images: [IMAGE], earlier }),
    );
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    const sent = t.requests[0]!.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    // The context goes with the first question; the new one comes last, with its images.
    expect(sent[0]!.content.map((block) => block.type)).toEqual(["text"]);
    expect(sent[0]!.content[0]!.text).toContain("<nearby_text>\nSome page text about Kiki.\n</nearby_text>");
    expect(sent[0]!.content[0]!.text).toMatch(/<question>\nWhat is this\?\n<\/question>$/);
    expect(sent[1]!.content).toEqual([{ type: "text", text: "First." }]);
    expect(sent[2]!.content).toEqual([{ type: "text", text: "And?" }]);
    expect(sent[3]!.content).toEqual([{ type: "text", text: "Second." }]);
    expect(sent[4]!.content.map((block) => block.type)).toEqual(["image", "text"]);
    expect(sent[4]!.content[1]!.text).toBe("The person attached an image.\n\n<question>\nOne more?\n</question>");

    const id = (events[0] as { id: string }).id;
    expect(t.conversations.get(id, t.record.id)!.userTurns).toBe(3);
  });

  it("rejects too many earlier turns", async () => {
    const t = setup([]);
    const earlier = Array.from({ length: 11 }, () => ({ question: "Q", answer: "A" }));
    expect((await t.post("/v1/conversations", { ...START, earlier })).status).toBe(400);
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

  it("adds the person's personality to the system prompt for the whole conversation", async () => {
    const t = setup([1, 2, 3].map(() => ({ blocks: [{ type: "text" as const, text: "ok" }] })));
    await readEvents(await t.post("/v1/conversations", START));
    expect(t.requests[0]!.system).toBe(SYSTEM_PROMPT);

    const first = await readEvents(await t.post("/v1/conversations", { ...START, personality: "  Talk like a pirate.  " }));
    const id = (first[0] as { id: string }).id;
    await readEvents(await t.post(`/v1/conversations/${id}/messages`, { question: "And?" }));
    expect(t.requests[1]!.system).toBe(
      `${SYSTEM_PROMPT}\n\nThe person chose this personality for you. Adopt it; the rules above still apply.\n<personality>\nTalk like a pirate.\n</personality>`,
    );
    expect(t.requests[2]!.system).toBe(t.requests[1]!.system);
  });

  it("rejects personalities over the limit", async () => {
    const t = setup([]);
    const response = await t.post("/v1/conversations", { ...START, personality: "x".repeat(2_001) });
    expect(response.status).toBe(400);
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
      features: { voice: false, actions: true },
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

describe("Kiki's own tools", () => {
  const TOOLS = { actions: true, calendarRead: true, tasksRead: true };

  /** Reads SSE events until one of `type` arrives; returns those so far and the rest of the stream. */
  async function readUntil(response: Response, type: string) {
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    while (!text.includes(`"type":"${type}"`)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream ended before ${type}`);
      text += value;
    }
    const rest = async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += value;
      }
      return readEvents(new Response(text));
    };
    return { events: await readEvents(new Response(text)), rest };
  }

  function toolNames(request: Record<string, unknown>): string[] {
    return (request.tools as Array<{ name: string }>).map((tool) => tool.name);
  }

  it("offers proposal tools only to apps that show cards, and reads only when connected", async () => {
    const t = setup([1, 2, 3].map(() => ({ blocks: [{ type: "text" as const, text: "ok" }] })));
    await readEvents(await t.post("/v1/conversations", START));
    await readEvents(await t.post("/v1/conversations", { ...START, tools: { actions: true } }));
    await readEvents(await t.post("/v1/conversations", { ...START, tools: TOOLS }));
    expect(toolNames(t.requests[0]!)).toEqual(["web_search", "web_fetch"]);
    expect(toolNames(t.requests[1]!)).toEqual([
      "web_search",
      "web_fetch",
      "propose_calendar_event",
      "propose_task",
      "propose_email",
    ]);
    expect(toolNames(t.requests[2]!)).toContain("list_calendar_events");
    expect(toolNames(t.requests[2]!)).toContain("list_tasks");
  });

  it("turns a proposal into a card and tells Claude it isn't done yet", async () => {
    const t = setup([
      {
        blocks: [
          { type: "text", text: "Adding it." },
          {
            type: "tool_use",
            name: "propose_calendar_event",
            input: { title: "Lunch with Sam", start: "2026-10-20T13:00", location: "Café X" },
          },
        ],
        stopReason: "tool_use",
      },
      { blocks: [{ type: "text", text: "Check the card." }] },
    ]);
    const events = await readEvents(await t.post("/v1/conversations", { ...START, tools: TOOLS }));
    // What Claude wrote on its way to the card goes to the thinking feed.
    expect(events.filter((e) => e.type === "text" || e.type === "notes")).toEqual([
      { type: "text", delta: "Addin" },
      { type: "text", delta: "g it." },
      { type: "notes", chars: 10 },
      { type: "text", delta: "Check th" },
      { type: "text", delta: "e card." },
    ]);
    const action = events.find((e) => e.type === "action");
    expect(action).toMatchObject({
      action: { kind: "event", title: "Lunch with Sam", start: "2026-10-20T13:00", end: "2026-10-20T14:00", location: "Café X" },
    });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    const sent = t.requests[1]!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(sent[2]!.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
    expect(sent[2]!.content[0]!.content).toContain("Nothing has been created or sent yet");
    // Counts as one question, and the history keeps the whole exchange.
    expect(t.codes.usedToday(t.record.id)).toBe(1);
    const id = (events[0] as { id: string }).id;
    expect(t.conversations.get(id, t.record.id)!.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("returns invalid proposals to Claude as errors", async () => {
    const t = setup([
      {
        blocks: [{ type: "tool_use", name: "propose_email", input: { to: ["not an address"], subject: "Hi", body: "Hi" } }],
        stopReason: "tool_use",
      },
      { blocks: [{ type: "text", text: "Sorry." }] },
    ]);
    const events = await readEvents(await t.post("/v1/conversations", { ...START, tools: TOOLS }));
    expect(events.some((e) => e.type === "action")).toBe(false);
    const sent = t.requests[1]!.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(sent[2]!.content[0]).toMatchObject({ is_error: true });
  });

  it("asks the app to run read tools and continues with the result", async () => {
    const t = setup([
      {
        blocks: [
          {
            type: "tool_use",
            name: "list_calendar_events",
            input: { time_min: "2026-10-22T12:00", time_max: "2026-10-22T18:00" },
          },
        ],
        stopReason: "tool_use",
      },
      { blocks: [{ type: "text", text: "You're free." }] },
    ]);
    const response = await t.post("/v1/conversations", { ...START, tools: TOOLS });
    const { events, rest } = await readUntil(response, "tool_call");
    const id = (events[0] as { id: string }).id;
    expect(events).toContainEqual({ type: "activity", activity: { kind: "lookup", label: "Checking your calendar" } });
    expect(events.at(-1)).toMatchObject({ type: "tool_call", id: "toolu_0", name: "list_calendar_events" });

    const posted = await t.post(`/v1/conversations/${id}/tool-results`, {
      results: [{ id: "toolu_0", content: "No events." }],
    });
    expect(posted.status).toBe(200);
    const all = await rest();
    expect(all.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    const sent = t.requests[1]!.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(sent[2]!.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_0", content: "No events." });

    // Nothing is waiting anymore.
    const late = await t.post(`/v1/conversations/${id}/tool-results`, { results: [{ id: "toolu_0", content: "x" }] });
    expect(late.status).toBe(404);
  });

  it("gives Claude an error when the app doesn't answer in time", async () => {
    const codes = new CodeStore(":memory:");
    const { code } = codes.create("tester", 10);
    const fake = fakeClient([
      { blocks: [{ type: "tool_use", name: "list_tasks", input: {} }], stopReason: "tool_use" },
      { blocks: [{ type: "text", text: "Couldn't check." }] },
    ]);
    const app = createApp({
      codes,
      conversations: new ConversationStore(),
      client: fake.client,
      config: DEFAULT_CLAUDE_CONFIG,
      toolTimeoutMs: 10,
      log: () => {},
    });
    const response = await app.request("/v1/conversations", {
      method: "POST",
      headers: { authorization: `Bearer ${code}`, "content-type": "application/json" },
      body: JSON.stringify({ ...START, tools: TOOLS }),
    });
    const events = await readEvents(response);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    const sent = fake.requests[1]!.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(sent[2]!.content[0]).toMatchObject({ is_error: true, content: "The Kiki app didn't answer in time." });
  });

  it("offers open_search only to apps that open searches, with or without cards", async () => {
    const t = setup([1, 2, 3].map(() => ({ blocks: [{ type: "text" as const, text: "ok" }] })));
    await readEvents(await t.post("/v1/conversations", { ...START, tools: TOOLS }));
    await readEvents(await t.post("/v1/conversations", { ...START, tools: { open: true } }));
    await readEvents(await t.post("/v1/conversations", { ...START, tools: { ...TOOLS, open: true } }));
    expect(toolNames(t.requests[0]!)).not.toContain("open_search");
    expect(toolNames(t.requests[1]!)).toEqual(["web_search", "web_fetch", "open_search"]);
    expect(toolNames(t.requests[2]!).at(-1)).toBe("open_search");
  });

  it("has the app open a search, with the site cut down to its domain", async () => {
    const t = setup([
      {
        blocks: [
          { type: "text", text: "Opening it." },
          {
            type: "tool_use",
            name: "open_search",
            input: { where: "web", query: " intentionality ", site: "https://www.Substack.com/@someone" },
          },
        ],
        stopReason: "tool_use",
      },
      { blocks: [{ type: "text", text: "Opened a Substack search." }] },
    ]);
    const response = await t.post("/v1/conversations", { ...START, tools: { ...TOOLS, open: true } });
    const { events, rest } = await readUntil(response, "tool_call");
    const id = (events[0] as { id: string }).id;
    // What Claude wrote on its way to the tool goes to the thinking feed.
    expect(events).toContainEqual({ type: "notes", chars: 11 });
    expect(events).toContainEqual({
      type: "activity",
      activity: { kind: "open", label: "substack.com on Google", query: "intentionality" },
    });
    expect(events.at(-1)).toEqual({
      type: "tool_call",
      id: "toolu_1",
      name: "open_search",
      input: { where: "web", query: "intentionality", site: "substack.com" },
    });

    await t.post(`/v1/conversations/${id}/tool-results`, {
      results: [{ id: "toolu_1", content: "Opened it in a new tab of the person's browser." }],
    });
    expect((await rest()).at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    const sent = t.requests[1]!.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(sent[2]!.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "Opened it in a new tab of the person's browser.",
    });
  });

  it("returns searches Kiki can't open to Claude as errors, without asking the app", async () => {
    const bad = [
      { where: "videos", query: "puppies", site: "substack.com" },
      { where: "web", query: "puppies", site: "not a domain" },
      { where: "anywhere", query: "puppies" },
      { where: "web", query: "   " },
    ];
    const t = setup(
      bad.flatMap((input) => [
        { blocks: [{ type: "tool_use" as const, name: "open_search", input }], stopReason: "tool_use" },
        { blocks: [{ type: "text" as const, text: "Sorry." }] },
      ]),
    );
    for (let i = 0; i < bad.length; i++) {
      const events = await readEvents(await t.post("/v1/conversations", { ...START, tools: { open: true } }));
      expect(events.some((e) => e.type === "tool_call" || e.type === "activity")).toBe(false);
      const sent = t.requests[i * 2 + 1]!.messages as Array<{ content: Array<Record<string, unknown>> }>;
      expect(sent[2]!.content[0]).toMatchObject({ type: "tool_result", is_error: true });
    }
  });

  it("offers propose_edit only when the app can write at the cursor, and says where it writes", async () => {
    const t = setup([1, 2, 3].map(() => ({ blocks: [{ type: "text" as const, text: "ok" }] })));
    await readEvents(await t.post("/v1/conversations", { ...START, tools: TOOLS }));
    await readEvents(await t.post("/v1/conversations", { ...START, tools: { ...TOOLS, edit: "replace" } }));
    await readEvents(await t.post("/v1/conversations", { ...START, tools: { ...TOOLS, edit: "insert" } }));
    const firstText = (i: number) =>
      (t.requests[i]!.messages as Array<{ content: Array<{ text?: string }> }>)[0]!.content.at(-1)!.text!;
    expect(toolNames(t.requests[0]!)).not.toContain("propose_edit");
    expect(firstText(0)).not.toContain("propose_edit");
    expect(toolNames(t.requests[1]!)).toContain("propose_edit");
    expect(firstText(1)).toContain("<kiki_request>The highlighted text is editable: propose_edit replaces it.</kiki_request>");
    expect(firstText(2)).toContain("propose_edit inserts text at the cursor");
    // The tools stay the same across apps, so only the tool list differs, not the system prompt.
    expect(t.requests[1]!.system).toEqual(t.requests[0]!.system);
  });

  it("rejects edit modes the protocol doesn't have", async () => {
    const t = setup([]);
    const response = await t.post("/v1/conversations", { ...START, tools: { ...TOOLS, edit: "overwrite" } });
    expect(response.status).toBe(400);
  });

  it("turns propose_edit into an edit card, keeping its whitespace", async () => {
    const t = setup([
      {
        blocks: [{ type: "tool_use", name: "propose_edit", input: { text: "  fixed line\n" } }],
        stopReason: "tool_use",
      },
      { blocks: [{ type: "tool_use", name: "propose_edit", input: { text: "" } }], stopReason: "tool_use" },
      { blocks: [{ type: "text", text: "Fixed the typo." }] },
    ]);
    const events = await readEvents(await t.post("/v1/conversations", { ...START, tools: { ...TOOLS, edit: "replace" } }));
    const cards = events.filter((e) => e.type === "action");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ action: { kind: "edit", text: "  fixed line\n" } });
    const second = t.requests[2]!.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(second.at(-1)!.content[0]).toMatchObject({ is_error: true });
  });

  it("tells Claude what the person did with an edit card", async () => {
    const t = setup([
      { blocks: [{ type: "text", text: "ok" }] },
      { blocks: [{ type: "text", text: "Done." }] },
    ]);
    const first = await readEvents(await t.post("/v1/conversations", { ...START, tools: { ...TOOLS, edit: "replace" } }));
    const id = (first[0] as { id: string }).id;
    await readEvents(
      await t.post(`/v1/conversations/${id}/messages`, {
        question: "Shorter",
        tools: { ...TOOLS, edit: "replace" },
        actionOutcomes: [{ id: "e1", kind: "edit", outcome: "applied", summary: "Replaced in Text Editor." }],
      }),
    );
    const followUp = (t.requests[1]!.messages as Array<{ content: Array<{ text?: string }> }>)[2]!.content[0]!.text;
    expect(followUp).toContain("- edit card: the person put it into their app. Replaced in Text Editor.");
  });

  it("puts the local time and earlier card outcomes in the prompt", async () => {
    const t = setup([
      { blocks: [{ type: "text", text: "ok" }] },
      { blocks: [{ type: "text", text: "Done." }] },
    ]);
    const first = await readEvents(
      await t.post("/v1/conversations", {
        ...START,
        tools: TOOLS,
        clock: { timeZone: "America/Toronto", now: "2026-10-16T14:03:00-04:00" },
      }),
    );
    const firstText = (t.requests[0]!.messages as Array<{ content: Array<{ text?: string }> }>)[0]!.content.at(-1)!.text;
    expect(firstText).toMatch(/^Current local time: Fri 2026-10-16 14:03 \(America\/Toronto\)/);

    const id = (first[0] as { id: string }).id;
    await readEvents(
      await t.post(`/v1/conversations/${id}/messages`, {
        question: "Did it work?",
        actionOutcomes: [{ id: "a1", kind: "event", outcome: "added", summary: "Lunch, Tue 13:00." }],
      }),
    );
    const followUp = (t.requests[1]!.messages as Array<{ content: Array<{ text?: string }> }>)[2]!.content[0]!.text;
    expect(followUp).toContain("- event card: the person added it. Lunch, Tue 13:00.");
    expect(followUp).toContain("<question>\nDid it work?\n</question>");
  });

  const FORM: StartConversationRequest["context"] = {
    ...START.context,
    editable: { text: "teh cat sat on teh mat" },
    fields: [
      { id: "f1", label: "Full name", kind: "text", value: "" },
      { id: "f2", label: "Agree", kind: "checkbox", checked: false },
    ],
  };

  it("offers propose_changes and propose_fill only when the app can apply them, with the text and fields", async () => {
    const t = setup([1, 2, 3].map(() => ({ blocks: [{ type: "text" as const, text: "ok" }] })));
    await readEvents(await t.post("/v1/conversations", { ...START, context: FORM, tools: TOOLS }));
    await readEvents(
      await t.post("/v1/conversations", { ...START, context: FORM, tools: { ...TOOLS, changes: "text", fill: true } }),
    );
    await readEvents(await t.post("/v1/conversations", { ...START, tools: { ...TOOLS, changes: "docs" } }));
    const firstText = (i: number) =>
      (t.requests[i]!.messages as Array<{ content: Array<{ text?: string }> }>)[0]!.content.at(-1)!.text!;
    expect(toolNames(t.requests[0]!)).not.toContain("propose_changes");
    expect(toolNames(t.requests[0]!)).not.toContain("propose_fill");
    expect(toolNames(t.requests[1]!)).toEqual(expect.arrayContaining(["propose_changes", "propose_fill"]));
    expect(firstText(1)).toContain("<editable_text>\nteh cat sat on teh mat\n</editable_text>");
    expect(firstText(1)).toContain('<form_fields>\nf1 text "Full name": ""\nf2 checkbox "Agree": unchecked\n</form_fields>');
    expect(firstText(1)).toContain("propose_changes changes the text the cursor is in, all of it in <editable_text>.");
    expect(firstText(2)).toContain("This is a Google Doc.");
    expect(firstText(2)).toContain("ask them to press the camera button");
    expect(toolNames(t.requests[2]!)).not.toContain("propose_fill");
  });

  it("rejects malformed form fields and changes modes", async () => {
    const t = setup([]);
    const badField = { ...FORM, fields: [{ id: "name", label: "Full name", kind: "text" }] };
    expect((await t.post("/v1/conversations", { ...START, context: badField })).status).toBe(400);
    expect((await t.post("/v1/conversations", { ...START, tools: { ...TOOLS, changes: "all" } })).status).toBe(400);
  });

  /** Reads the whole stream, answering each tool_call with the next of `answers` as it arrives. */
  async function answeringToolCalls(
    t: ReturnType<typeof setup>,
    response: Response,
    answers: Array<{ content: string; isError?: boolean }>,
  ) {
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    let answered = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += value;
      // Only whole events: a chunk can end in the middle of one.
      const events = await readEvents(new Response(text.slice(0, text.lastIndexOf("\n\n") + 2)));
      const calls = events.filter((e) => e.type === "tool_call") as Array<{ id: string }>;
      const id = (events[0] as { id: string }).id;
      while (answered < calls.length) {
        const answer = answers[answered]!;
        await t.post(`/v1/conversations/${id}/tool-results`, { results: [{ id: calls[answered]!.id, ...answer }] });
        answered++;
      }
    }
    return readEvents(new Response(text));
  }

  it("checks proposed changes with the app first, and returns what doesn't fit to Claude", async () => {
    const t = setup([
      {
        blocks: [{ type: "tool_use", name: "propose_changes", input: { changes: [{ find: "teh", replace: "the" }] } }],
        stopReason: "tool_use",
      },
      {
        blocks: [
          {
            type: "tool_use",
            name: "propose_changes",
            input: { changes: [{ find: "teh cat", replace: "the cat" }, { find: "teh mat", replace: "the mat" }] },
          },
        ],
        stopReason: "tool_use",
      },
      { blocks: [{ type: "text", text: "Fixed both." }] },
    ]);
    const response = await t.post("/v1/conversations", { ...START, context: FORM, tools: { ...TOOLS, changes: "text" } });
    const events = await answeringToolCalls(t, response, [
      { content: 'Change 1: "teh" appears 2 times in the text.', isError: true },
      { content: "All changes fit." },
    ]);
    expect(events).toContainEqual({
      type: "activity",
      activity: { kind: "lookup", label: "Checking the changes against your text" },
    });
    const calls = events.filter((e) => e.type === "tool_call");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ name: "propose_changes", input: { kind: "changes", changes: [{ find: "teh", replace: "the" }] } });
    // Only the change set the app accepted becomes a card.
    const cards = events.filter((e) => e.type === "action");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ action: { kind: "changes", changes: [{ find: "teh cat" }, { find: "teh mat" }] } });
    const second = t.requests[1]!.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(second.at(-1)!.content[0]).toMatchObject({ is_error: true, content: 'Change 1: "teh" appears 2 times in the text.' });
    const third = t.requests[2]!.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(third.at(-1)!.content[0]!.content).toContain("Nothing has been created or sent yet");
  });

  it("checks a fill's shape before asking the app", async () => {
    const t = setup([
      {
        blocks: [
          {
            type: "tool_use",
            name: "propose_fill",
            input: { fields: [{ field: "f1", value: "Ada" }, { field: "f1", value: "Ada L." }] },
          },
        ],
        stopReason: "tool_use",
      },
      {
        blocks: [{ type: "tool_use", name: "propose_changes", input: { changes: [{ find: "same", replace: "same" }] } }],
        stopReason: "tool_use",
      },
      { blocks: [{ type: "text", text: "ok" }] },
    ]);
    const events = await readEvents(
      await t.post("/v1/conversations", { ...START, context: FORM, tools: { ...TOOLS, changes: "text", fill: true } }),
    );
    // Neither reached the app.
    expect(events.some((e) => e.type === "tool_call" || e.type === "action")).toBe(false);
    const second = t.requests[1]!.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(second.at(-1)!.content[0]).toMatchObject({ is_error: true });
    expect(String(second.at(-1)!.content[0]!.content)).toContain("f1 is listed twice");
    const third = t.requests[2]!.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(String(third.at(-1)!.content[0]!.content)).toContain("replace is the same as find");
  });
});
