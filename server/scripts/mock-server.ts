// Runs the real Kiki server with a fake Claude, for working on the desktop app
// without an API key. Answers stream slowly and echo back what context arrived.
//   npm run mock -w server
// Every answer "thinks" first; questions mentioning "latest" or "search" (or sent with the Search toggle)
// get a fake web search and page read. Voice questions get a canned transcript.
import Anthropic from "@anthropic-ai/sdk";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.ts";
import { DEFAULT_CLAUDE_CONFIG } from "../src/claude.ts";
import { CodeStore, hashCode } from "../src/codes.ts";
import { ConversationStore } from "../src/conversations.ts";
import { sseEvents, type FakeTurn } from "../test/helpers.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function lastUserText(body: { messages: Array<{ role: string; content: unknown }> }): string {
  const user = body.messages.filter((m) => m.role === "user").at(-1);
  const blocks = Array.isArray(user?.content) ? (user.content as Array<{ type: string; text?: string }>) : [];
  return blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
}

function imageCount(body: { messages: Array<{ content: unknown }> }): number {
  return body.messages
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string }>) : []))
    .filter((b) => b.type === "image").length;
}

function tag(text: string, name: string): string | undefined {
  return new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(text)?.[1];
}

function answerFor(body: {
  messages: Array<{ role: string; content: unknown }>;
  output_config?: { effort?: string };
}): FakeTurn {
  const text = lastUserText(body);
  const question = tag(text, "question") ?? text;
  const turns = body.messages.filter((m) => m.role === "user").length;
  const report =
    turns === 1
      ? [
          `**Mock answer** to “${question}”.`,
          "",
          `- Highlighted: ${tag(text, "highlighted") ? `“${tag(text, "highlighted")!.slice(0, 80)}”` : "nothing"}`,
          `- App: ${tag(text, "app") ?? "unknown"}`,
          `- Window: ${tag(text, "window_title") ?? "unknown"}`,
          `- Nearby text: ${tag(text, "nearby_text")?.length ?? 0} chars`,
          `- Images: ${imageCount(body)}`,
          `- Effort: ${body.output_config?.effort ?? "default"}`,
        ].join("\n")
      : `**Mock follow-up** (turn ${turns}): “${question}”. Earlier turns: ${body.messages.length - 1} messages, effort ${body.output_config?.effort ?? "default"}.`;

  const thought: FakeTurn["blocks"][number] = {
    type: "thinking",
    thinking: `**Working out what “${question.slice(0, 30)}” refers to.** The highlighted text and the window title narrow it down, so I'll check the nearby text before answering.`,
  };
  if (/latest|search/i.test(question) || text.includes("<kiki_request>")) {
    return {
      webSearches: 1,
      blocks: [
        thought,
        { type: "server_tool_use", name: "web_search", query: `${question.slice(0, 40)} (mock)` },
        {
          type: "web_search_tool_result",
          results: [
            { url: "https://example.com/release-notes", title: "Release notes" },
            { url: "https://arxiv.org/abs/2401.00001", title: "A paper on quantization" },
            { url: "https://example.org/news", title: "News" },
          ],
        },
        { type: "thinking", thinking: "Reading the paper on quantization to confirm the version numbers." },
        { type: "server_tool_use", name: "web_fetch", url: "https://arxiv.org/abs/2401.00001" },
        { type: "web_fetch_tool_result", url: "https://arxiv.org/abs/2401.00001", title: "A paper on quantization" },
        {
          type: "text",
          text: `${report}\n\nAccording to the (mock) release notes, version 2 is current.`,
          citations: [{ url: "https://example.com/release-notes", title: "Release notes" }],
        },
      ],
    };
  }
  return { blocks: [thought, { type: "text", text: report }] };
}

let call = 0;
const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const body = JSON.parse(String(init?.body));
  const events = sseEvents(answerFor(body), `msg_mock_${++call}`, 6);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      await sleep(600); // "thinking"
      for (const event of events) {
        const type = (event as { type: string }).type;
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`));
        await sleep(type === "content_block_start" ? 400 : 25);
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
};

const codes = new CodeStore(":memory:");
// MOCK_ACCESS_CODE (starting with kiki_) keeps the same code across restarts.
let code = process.env.MOCK_ACCESS_CODE ?? "";
if (code) {
  codes.db
    .prepare("INSERT INTO codes (name, code_hash, daily_limit, created_at) VALUES (?, ?, ?, ?)")
    .run("mock", hashCode(code), 1000, new Date().toISOString());
} else {
  code = codes.create("mock", 1000).code;
}
const app = createApp({
  codes,
  conversations: new ConversationStore(),
  client: new Anthropic({ apiKey: "mock", fetch, maxRetries: 0 }),
  config: DEFAULT_CLAUDE_CONFIG,
  stt: { url: "http://mock-stt.invalid/v1", model: "mock-whisper" },
  sttFetch: (async () => {
    await sleep(700);
    return Response.json({ text: "What does this mean, in simple terms?" });
  }) as unknown as typeof fetch,
});

const port = Number(process.env.PORT) || 8787;
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`Mock Kiki server on http://127.0.0.1:${port}`);
  console.log(`Access code: ${code}`);
});
