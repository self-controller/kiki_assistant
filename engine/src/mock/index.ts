// Kiki's mock mode (KIKI_MOCK=1): every model answers from here, without any account or key, for working on
// the app. Answers stream slowly and echo back what context arrived; every model answers the same way.
// Every answer "thinks" first; questions mentioning "latest" or "search" (or sent with the Search toggle)
// get a fake web search and page read. Questions about the calendar, reminders or email get action cards;
// "am I free" checks the calendar through the app. "typos" proposes changes to the text at the cursor
// (upper-casing a few words), and "fill" fills the form. "scroll" scrolls down three screens, then back to
// what it saw on the second; "like" or "press" looks at the screen and proposes pressing its first button.
// "take me to", "go to" or "open the" looks at the screen and clicks the control whose label shares a word
// with the question (or the first one). "code" or "math" answers with a highlighted code block and LaTeX
// formulas. Attached files are listed by name. "browse <url>" opens the page in Kiki's browser (with "show" it
// shows it; with "search" it then types into the first field, presses Enter and reads). "windows" lists the
// windows and switches to the second; "launch <name>" starts that app.
import Anthropic from "@anthropic-ai/sdk";
import type { Interactions } from "@google/genai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { CompatibleClient } from "../compatible.ts";
import type { GeminiClient, GeminiStreamParams } from "../gemini.ts";
import type { Clients } from "../models.ts";
import type { OpenAIClient, OpenAIStreamParams } from "../openai.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { chatEvents, geminiEvents, openaiEvents, sseEvents, type FakeTurn } from "./fakeEvents.ts";

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

/** The names of the files attached to the person's last message. */
function fileNames(text: string): string[] {
  return [...text.matchAll(/<attached_file name="([^"]*)">/g)].map((match) => match[1]!);
}

/** An answer with a code block and formulas, inline and on their own lines. */
const CODE_AND_MATH = [
  "The quadratic formula solves $ax^2 + bx + c = 0$ for $x$, as long as \\(a \\neq 0\\):",
  "",
  "$$",
  "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
  "$$",
  "",
  "In Python:",
  "",
  "```python",
  "import math",
  "",
  "def roots(a: float, b: float, c: float) -> tuple[float, float]:",
  '    """Both roots of ax^2 + bx + c, assuming they\'re real."""',
  "    d = math.sqrt(b**2 - 4 * a * c)  # the discriminant's root",
  "    return (-b + d) / (2 * a), (-b - d) / (2 * a)",
  "```",
  "",
  "So `roots(1, -3, 2)` gives $(2, 1)$, and it costs $0 to run, not $5.",
].join("\n");

function tag(text: string, name: string): string | undefined {
  return new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(text)?.[1];
}

/** A tool result's text: a string, or the text blocks of a scroll's result (next to its screenshot). */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return String(content ?? "");
  return (content as Array<{ type: string; text?: string }>).flatMap((b) => (b.type === "text" ? [b.text ?? ""] : [])).join("\n");
}

/** The tool results the app (or the engine, for cards) sent back, if the last message is one. */
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
 * Presses: a look, then a card for the first button on screen. Going somewhere: a look, then a click on the
 * control that best fits the question. Null once the question needs none of these.
 */
function screenTurn(body: Parameters<typeof answerFor>[0], tools: string[]): FakeTurn | null {
  const question = turnQuestion(body);
  const calls = turnToolCalls(body);
  const seen = toolResults(body).join("\n");
  const browse = browseTurn(question, calls, seen, tools);
  if (browse !== undefined) return browse;
  const use = (name: string, input: Record<string, unknown>): FakeTurn => ({
    stopReason: "tool_use",
    blocks: [
      {
        type: "text",
        text: name === "scroll" ? "Let me scroll a bit further." : name === "click" ? "Let me click it." : "Let me look at the screen.",
      },
      { type: "tool_use", name, input },
    ],
  });
  if (/take me|go to|open the/i.test(question) && tools.includes("look") && tools.includes("click")) {
    if (calls.length === 0) return use("look", {});
    if (calls.length > 1) return null;
    const controls = [...seen.matchAll(/⟦(b\d+) ([^⟧]*)⟧/g)].map(([, id, label]) => ({ id: id!, label: label!.toLowerCase() }));
    const words = question.toLowerCase().match(/\p{L}{3,}/gu) ?? [];
    const control = controls.find((c) => words.some((word) => c.label.includes(word))) ?? controls[0];
    return control ? use("click", { control: control.id }) : null;
  }
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

/**
 * Kiki's browser and the other windows: "browse <url>" opens the page (shown when the question says "show"),
 * then, with "search", types the question's last word into the first field, presses Enter and reads; "windows"
 * lists the windows and switches to the second; "launch <name>" starts that app. Undefined when the question
 * asks for none of these; null once their steps are done.
 */
function browseTurn(question: string, calls: Array<{ name: string; input: Record<string, unknown> }>, seen: string, tools: string[]): FakeTurn | null | undefined {
  const use = (name: string, input: Record<string, unknown>, text: string): FakeTurn => ({
    stopReason: "tool_use",
    blocks: [{ type: "text", text }, { type: "tool_use", name, input }],
  });
  const url = /browse\s+(\S+)/i.exec(question)?.[1];
  if (url && tools.includes("open_url")) {
    if (calls.length === 0) return use("open_url", { url, ...(/show/i.test(question) ? { show: true } : {}) }, "Opening the page.");
    if (/search/i.test(question) && calls.length === 1 && tools.includes("act")) {
      const field = /⟦(f\d+)/.exec(seen)?.[1];
      const words = question.match(/\p{L}{3,}/gu) ?? [];
      if (field) return use("act", { actions: [{ type: { field, text: words.at(-1) ?? "kiki" } }, { key: "enter" }] }, "Searching there.");
    }
    if (/keep/i.test(question) && !calls.some((call) => call.name === "browser")) return use("browser", { keep: true }, "Keeping the page.");
    return null;
  }
  if (/launch\s+(\S+)/i.test(question) && tools.includes("open_app")) {
    if (calls.length === 0) return use("open_app", { name: /launch\s+(\S+)/i.exec(question)![1]! }, "Starting it.");
    return null;
  }
  if (/windows/i.test(question) && tools.includes("list_windows")) {
    if (calls.length === 0) return use("list_windows", {}, "Let me see the windows.");
    if (calls.length === 1 && tools.includes("use_window")) {
      const ids = [...seen.matchAll(/^(w\d+)\b/gm)].map((match) => match[1]!);
      const second = ids[1] ?? ids[0];
      if (second) return use("use_window", { window: second }, "Switching to it.");
    }
    return null;
  }
  return undefined;
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
          input: { text: highlighted ? `${highlighted.trim()} (edited by the mock)` : "Written by the mock." },
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
  if (/\b(code|math)\b/i.test(question)) return { blocks: [{ type: "text", text: CODE_AND_MATH }] };
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
          `- Files: ${fileNames(text).join(", ") || "none"}`,
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

type MockBody = Parameters<typeof answerFor>[0];
type Block = { type: string; [key: string]: unknown };
type Message = { role: string; content: Block[] };

/** Adds `block` to the conversation, starting a new message when the role changes or tool results begin or end. */
function append(messages: Message[], role: string, block: Block): void {
  const last = messages.at(-1);
  const isResult = (b: Block) => b.type === "tool_result";
  if (last?.role === role && isResult(last.content[0]!) === isResult(block)) last.content.push(block);
  else messages.push({ role, content: [block] });
}

/** A Gemini request as Claude's mock reads it. */
function geminiBody(params: GeminiStreamParams): MockBody {
  const messages: Message[] = [];
  const items = (content: Interactions.Content[] | undefined): Block[] =>
    (content ?? []).map((item) => (item.type === "text" ? { type: "text", text: item.text } : { type: "image" }));
  for (const step of params.input as Interactions.Step[]) {
    if (step.type === "user_input") for (const block of items(step.content)) append(messages, "user", block);
    else if (step.type === "model_output") for (const block of items(step.content)) append(messages, "assistant", block);
    else if (step.type === "function_call") append(messages, "assistant", { type: "tool_use", name: step.name, input: step.arguments });
    else if (step.type === "function_result") {
      const content = Array.isArray(step.result) ? items(step.result as Interactions.Content[]) : String(step.result);
      append(messages, "user", { type: "tool_result", content });
    }
  }
  const tools = (params.tools ?? []).flatMap((tool) => (tool.type === "function" ? [{ name: tool.name ?? "" }] : []));
  return { messages, tools, output_config: { effort: params.generation_config?.thinking_level ?? "default" } };
}

/** An OpenAI request as Claude's mock reads it. */
function openaiBody(params: OpenAIStreamParams): MockBody {
  const messages: Message[] = [];
  for (const item of params.input as ResponseInputItem[]) {
    if ("role" in item && (item.role === "user" || item.role === "assistant")) {
      const content = typeof item.content === "string" ? [{ type: "input_text", text: item.content }] : item.content;
      for (const part of content as Array<{ type: string; text?: string }>) {
        const block = part.type === "input_text" || part.type === "output_text" ? { type: "text", text: part.text } : { type: "image" };
        append(messages, item.role, block);
      }
    } else if (item.type === "function_call") {
      append(messages, "assistant", { type: "tool_use", name: item.name, input: JSON.parse(item.arguments) as unknown });
    } else if (item.type === "function_call_output") {
      const content =
        typeof item.output === "string"
          ? item.output
          : item.output.map((part) => (part.type === "input_text" ? { type: "text", text: part.text } : { type: "image" }));
      append(messages, "user", { type: "tool_result", content });
    }
  }
  const tools = (params.tools ?? []).flatMap((tool) => (tool.type === "function" ? [{ name: tool.name }] : []));
  return { messages, tools, output_config: { effort: params.reasoning?.effort ?? "default" } };
}

/** Streams `events` the way a slow model would: a pause to "think", then a beat before each new block. */
async function* slowly<T>(events: T[], isStart: (event: T) => boolean): AsyncGenerator<T> {
  await sleep(600);
  for (const event of events) {
    yield event;
    await sleep(isStart(event) ? 400 : 25);
  }
}

/** A chat completion request as Claude's mock reads it. */
function chatBody(params: { messages: ChatCompletionMessageParam[]; tools?: Array<{ type: string; function?: { name: string } }> }): MockBody {
  const messages: Message[] = [];
  for (const message of params.messages) {
    if (message.role === "user" || message.role === "assistant") {
      const content = typeof message.content === "string" || !message.content ? [{ type: "text", text: message.content ?? "" }] : message.content;
      for (const part of content as Array<{ type: string; text?: string }>) {
        if (part.type === "text" && !part.text) continue;
        append(messages, message.role, part.type === "text" ? { type: "text", text: part.text } : { type: "image" });
      }
      if (message.role === "assistant") {
        for (const call of message.tool_calls ?? []) {
          if (call.type === "function") append(messages, "assistant", { type: "tool_use", name: call.function.name, input: JSON.parse(call.function.arguments) as unknown });
        }
      }
    } else if (message.role === "tool") {
      append(messages, "user", { type: "tool_result", content: typeof message.content === "string" ? message.content : "" });
    }
  }
  const tools = (params.tools ?? []).flatMap((tool) => (tool.function ? [{ name: tool.function.name }] : []));
  return { messages, tools };
}

const mockGemini = (): GeminiClient => ({
  async stream(params) {
    const events = geminiEvents(answerFor(geminiBody(params)), `int_mock_${++call}`, 6);
    return slowly(events, (event) => event.event_type === "step.start");
  },
});

const mockOpenAI = (): OpenAIClient => ({
  async stream(params) {
    const events = openaiEvents(answerFor(openaiBody(params)), `resp_mock_${++call}`, 6);
    return slowly(events, (event) => event.type === "response.output_item.added");
  },
});

const mockCompatible = (): CompatibleClient => ({
  async stream(params) {
    const events = chatEvents(answerFor(chatBody(params)), `chat_mock_${++call}`, 6);
    return slowly(events, (event) => Boolean(event.choices[0]?.delta?.tool_calls?.[0]?.id));
  },
});

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

/** Clients that answer every question from the mock, whatever account or key it's asked on. */
export function mockClients(): Partial<Clients> {
  const claude = new Anthropic({ apiKey: "mock", fetch, maxRetries: 0 });
  return { anthropic: () => claude, google: mockGemini, openai: mockOpenAI, compatible: mockCompatible };
}
