// Runs the real Kiki server with a fake Claude, for working on the desktop app
// without an API key. Answers stream slowly and echo back what context arrived.
//   npm run mock -w server
// Every answer "thinks" first; questions mentioning "latest" or "search" (or sent with the Search toggle)
// get a fake web search and page read. Voice questions get a canned transcript. Questions about the
// calendar, reminders or email get action cards; "am I free" checks the calendar through the app. "typos"
// proposes changes to the text at the cursor (upper-casing a few words), and "fill" fills the form. "scroll"
// scrolls down three screens, then back to what it saw on the second; "like" or "press" looks at the screen and
// proposes pressing its first button.
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

/** A tool result's text: a string, or the text blocks of a scroll's result (next to its screenshot). */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return String(content ?? "");
  return (content as Array<{ type: string; text?: string }>).flatMap((b) => (b.type === "text" ? [b.text ?? ""] : [])).join("\n");
}

/** The tool results the app (or the server, for cards) sent back, if the last message is one. */
function toolResults(body: { messages: Array<{ role: string; content: unknown }> }): string[] {
  const last = body.messages.at(-1);
  const blocks = Array.isArray(last?.content) ? (last.content as Array<{ type: string; content?: unknown }>) : [];
  return blocks.filter((b) => b.type === "tool_result").map((b) => resultText(b.content));
}

/** The tools Claude called since the person's last question, oldest first. */
function turnToolCalls(body: { messages: Array<{ role: string; content: unknown }> }): Array<{ name: string; input: Record<string, unknown> }> {
  const asked = body.messages.findLastIndex(
    (m) => m.role === "user" && !(Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((b) => b.type === "tool_result")),
  );
  return body.messages.slice(asked + 1).flatMap((m) =>
    m.role === "assistant" && Array.isArray(m.content)
      ? (m.content as Array<{ type: string; name?: string; input?: Record<string, unknown> }>)
          .filter((b) => b.type === "tool_use")
          .map((b) => ({ name: b.name ?? "", input: b.input ?? {} }))
      : [],
  );
}

/** The question this turn answers, from the person's last message. */
function turnQuestion(body: { messages: Array<{ role: string; content: unknown }> }): string {
  const asked = body.messages.findLast(
    (m) => m.role === "user" && !(Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((b) => b.type === "tool_result")),
  );
  const text = asked ? lastUserText({ messages: [asked] }) : "";
  return tag(text, "question") ?? text;
}

/**
 * Scrolls through the window: three screens down, then back to a line from the second screen, then the answer.
 * Presses: a look, then a card for the first button on screen. Null once the question needs neither.
 */
function screenTurn(body: Parameters<typeof answerFor>[0], tools: string[]): FakeTurn | null {
  const question = turnQuestion(body);
  const calls = turnToolCalls(body);
  const seen = toolResults(body).join("\n");
  const use = (name: string, input: Record<string, unknown>): FakeTurn => ({
    stopReason: "tool_use",
    blocks: [
      { type: "text", text: name === "scroll" ? "Let me scroll a bit further." : "Let me look at the screen." },
      { type: "tool_use", name, input },
    ],
  });
  if (/like|press/i.test(question) && tools.includes("look") && tools.includes("propose_press")) {
    if (calls.length === 0) return use("look", {});
    const button = /⟦(b\d+)/.exec(seen)?.[1];
    if (calls.length === 1 && button) return use("propose_press", { presses: [{ control: button }] });
    return null;
  }
  if (!/scroll|further down|go through/i.test(question) || !tools.includes("scroll")) return null;
  const scrolls = calls.filter((call) => call.name === "scroll").length;
  if (scrolls < 3) return use("scroll", { direction: "down" });
  if (scrolls === 3) {
    // A line from the second screen, which the third scroll moved past.
    const screens = body.messages.flatMap((m) =>
      m.role === "user" && Array.isArray(m.content)
        ? (m.content as Array<{ type: string; content?: unknown }>).filter((b) => b.type === "tool_result").map((b) => resultText(b.content))
        : [],
    );
    const line = tag(screens.at(-2) ?? "", "visible_text")
      ?.split("\n")
      .map((l) => l.replace(/⟦[^⟧]*⟧/g, "").trim())
      .find((l) => l.length > 12);
    if (line) return use("scroll", { to: line.slice(0, 60) });
  }
  return null;
}

/** A few changes to `text`: up to three words that appear once in it, upper-cased. */
function mockChanges(text: string | undefined): Array<{ find: string; replace: string }> {
  const words = [...new Set((text ?? "teh").match(/\p{L}{3,}/gu) ?? [])];
  const once = words.filter((word) => text === undefined || text.split(word).length === 2).slice(0, 3);
  return (once.length ? once : ["teh"]).map((word) => ({ find: word, replace: word.toUpperCase() }));
}

/** Values for each field in <form_fields>: "Mock <label>" in text fields, check boxes checked. */
function mockFill(fields: string | undefined): Array<{ field: string; value: string | boolean }> {
  return (fields ?? "").split("\n").flatMap((line) => {
    const match = /^(f\d+) (\w+) ("(?:[^"\\]|\\.)*")/.exec(line);
    if (!match) return [];
    const [, id, kind, label] = match;
    return [{ field: id!, value: kind === "checkbox" || kind === "radio" ? true : `Mock ${JSON.parse(label!) as string}` }];
  });
}

/** Cards, calendar checks and opened searches, when the question asks for them and the app handles them. */
function actionTurn(question: string, tools: string[], text: string): FakeTurn | null {
  const highlighted = tag(text, "highlighted");
  const note: FakeTurn["blocks"][number] = { type: "text", text: "Next Tuesday is Oct 20, so I'll use that." };
  if (/google images|youtube|open .*search/i.test(question) && tools.includes("open_search")) {
    const where = /youtube/i.test(question) ? "videos" : /images/i.test(question) ? "images" : "web";
    return {
      stopReason: "tool_use",
      blocks: [{ type: "tool_use", name: "open_search", input: { where, query: "cute puppies" } }],
    };
  }
  if (/typo|changes|everywhere/i.test(question) && tools.includes("propose_changes")) {
    const changes = mockChanges(tag(text, "editable_text") ?? tag(text, "nearby_text"));
    return { stopReason: "tool_use", blocks: [{ type: "tool_use", name: "propose_changes", input: { changes } }] };
  }
  if (/fill|form/i.test(question) && tools.includes("propose_fill")) {
    const fields = mockFill(tag(text, "form_fields"));
    if (fields.length) return { stopReason: "tool_use", blocks: [{ type: "tool_use", name: "propose_fill", input: { fields } }] };
  }
  if (/free|busy/i.test(question) && tools.includes("list_calendar_events")) {
    return {
      stopReason: "tool_use",
      blocks: [
        note,
        { type: "tool_use", name: "list_calendar_events", input: { time_min: "2026-10-22T12:00", time_max: "2026-10-22T18:00" } },
      ],
    };
  }
  if (/rewrite|fix|edit|write|translate/i.test(question) && tools.includes("propose_edit")) {
    return {
      stopReason: "tool_use",
      blocks: [
        {
          type: "tool_use",
          name: "propose_edit",
          input: { text: highlighted ? `${highlighted.trim()} (edited by the mock server)` : "Written by the mock server." },
        },
      ],
    };
  }
  if (!tools.includes("propose_calendar_event")) return null;
  if (/calendar|schedule/i.test(question)) {
    return {
      stopReason: "tool_use",
      blocks: [
        note,
        {
          type: "tool_use",
          name: "propose_calendar_event",
          input: { title: "Lunch with Sam", start: "2026-10-20T13:00", location: "Café Olimpico", attendees: ["sam@example.com"] },
        },
      ],
    };
  }
  if (/remind|task|todo/i.test(question)) {
    return {
      stopReason: "tool_use",
      blocks: [{ type: "tool_use", name: "propose_task", input: { title: "Renew passport", due: "2026-10-30", notes: "Deadline Nov 1." } }],
    };
  }
  if (/email|reply|send/i.test(question)) {
    return {
      stopReason: "tool_use",
      blocks: [
        {
          type: "tool_use",
          name: "propose_email",
          input: {
            to: ["sam@example.com"],
            subject: "Re: Lunch?",
            body: "Hi Sam,\n\nSounds great, see you Tuesday at 1pm.\n\nThanks",
            send: /send/i.test(question),
          },
        },
      ],
    };
  }
  return null;
}

function answerFor(body: {
  messages: Array<{ role: string; content: unknown }>;
  output_config?: { effort?: string };
  tools?: Array<{ name: string }>;
}): FakeTurn {
  const screen = screenTurn(body, (body.tools ?? []).map((tool) => tool.name));
  if (screen) return screen;
  const results = toolResults(body);
  if (results.length > 0) {
    return { blocks: [{ type: "text", text: `**Mock answer** after Kiki's tools.\n\n> ${results.join("\n> ").slice(0, 400)}` }] };
  }
  const text = lastUserText(body);
  const question = tag(text, "question") ?? text;
  const turns = body.messages.filter((m) => m.role === "user").length;
  const action = actionTurn(question, (body.tools ?? []).map((tool) => tool.name), text);
  if (action) return action;
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
