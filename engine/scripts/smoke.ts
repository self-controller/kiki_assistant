// Live end-to-end check of the engine against a real model. Keys come from engine/.env (see .env.example).
//   npm run smoke -w engine                                   # Claude on ANTHROPIC_API_KEY (a few cents)
//   npm run smoke -w engine -- --plan                         # Claude on your own Claude Code (your plan)
//   npm run smoke -w engine -- --provider google              # Gemini on GEMINI_API_KEY
//   npm run smoke -w engine -- --provider openai              # GPT on OPENAI_API_KEY
//   npm run smoke -w engine -- --provider openai --plan       # GPT on your own Codex (your ChatGPT plan)
//   npm run smoke -w engine -- --provider compatible --base-url http://localhost:11434/v1 --model qwen3:8b
//                                                             # a local model (or a service, with COMPATIBLE_API_KEY)
import { parseArgs } from "node:util";
import type { KikiEvent, ModelPick, StartConversationRequest, ToolAccess } from "@kiki/shared";
import { findExecutable } from "../src/accounts.ts";
import { ConversationStore } from "../src/conversations.ts";
import { createEngine } from "../src/engine.ts";
import type { Route } from "../src/models.ts";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // No .env: keys come from the environment.
}

const { values } = parseArgs({
  options: {
    provider: { type: "string", default: "anthropic" },
    plan: { type: "boolean", default: false },
    "base-url": { type: "string" },
    model: { type: "string" },
  },
});
const { provider, plan } = values;

function keyFrom(name: string): string {
  const key = process.env[name];
  if (!key) throw new Error(`Set ${name} in engine/.env to check ${provider}.`);
  return key;
}

function routeFor(): { route: Route; model?: ModelPick; web: boolean } {
  if (provider === "compatible") {
    const baseUrl = values["base-url"];
    if (!baseUrl || !values.model) throw new Error("--provider compatible needs --base-url and --model");
    const apiKey = process.env.COMPATIBLE_API_KEY;
    return { route: { kind: "compatible", name: new URL(baseUrl).host, baseUrl, model: values.model, ...(apiKey ? { apiKey } : {}) }, model: "custom:smoke", web: false };
  }
  if (provider === "anthropic") {
    if (!plan) return { route: { kind: "key", provider, apiKey: keyFrom("ANTHROPIC_API_KEY") }, web: true };
    const executable = findExecutable("claude");
    if (!executable) throw new Error("Install Claude Code and sign in with `claude` first.");
    return { route: { kind: "claude-code", executable }, web: true };
  }
  if (provider === "openai") {
    return { route: plan ? { kind: "codex" } : { kind: "key", provider, apiKey: keyFrom("OPENAI_API_KEY") }, model: "sol", web: true };
  }
  if (provider === "google" && !plan) return { route: { kind: "key", provider, apiKey: keyFrom("GEMINI_API_KEY") }, model: "flash", web: true };
  throw new Error("--provider must be anthropic, google, openai or compatible (--plan with anthropic or openai)");
}

const { route, model, web } = routeFor();
const options = model ? { model } : undefined;
console.log(`Checking ${provider}${model ? ` (${model})` : ""}${plan ? " on your own sign-in" : ""}\n`);

const conversations = new ConversationStore();
const engine = createEngine({ conversations, log: (line) => console.log(`  engine: ${line}`) });

// A 1×1 PNG, for the screen that looks and scrolls show.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Answers the app's side of a turn: looks and scrolls see a short page with a screenshot, reads see nothing. */
function answerTool(conversation: string, event: Extract<KikiEvent, { type: "tool_call" }>): void {
  const screen =
    event.name === "look" || event.name === "scroll"
      ? {
          windowTitle: "Release notes",
          text: "Kiki 2.0 released October 2026. ⟦b1 Download⟧ ⟦b2 Changelog⟧",
          screenshot: { mediaType: "image/png" as const, data: PIXEL },
        }
      : undefined;
  queueMicrotask(() =>
    engine.toolResults(conversation, [{ id: event.id, content: screen ? "Done." : "Nothing found.", ...(screen ? { screen } : {}) }]),
  );
}

async function ask(conversationId: string | null, body: unknown): Promise<KikiEvent[]> {
  const started = Date.now();
  const events: KikiEvent[] = [];
  let firstTextAt = 0;
  let id = conversationId ?? "";
  const onEvent = (event: KikiEvent) => {
    events.push(event);
    if (event.type === "conversation") id = event.id;
    else if (event.type === "tool_call") answerTool(id, event);
    else if (event.type === "text") {
      if (!firstTextAt) firstTextAt = Date.now();
      process.stdout.write(event.delta);
    } else if (event.type === "status") {
      console.log(`  [${event.phase}${event.query ? `: ${event.query}` : ""}]`);
    } else {
      console.log(`\n  [${event.type}] ${JSON.stringify(event)}`);
    }
  };
  if (conversationId) await engine.followUp(conversationId, body as never, route, onEvent);
  else await engine.start(body as StartConversationRequest, route, onEvent);
  console.log(`  first text after ${firstTextAt ? firstTextAt - started : "-"}ms, total ${Date.now() - started}ms\n`);
  return events;
}

function check(label: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) process.exitCode = 1;
}

const noSearch: StartConversationRequest = {
  question: "What does this mean here?",
  selection: "ephemeral",
  context: {
    appName: "Zen",
    windowTitle: "Volumes | Kubernetes",
    text:
      "Kubernetes supports many types of volumes. Ephemeral volume types have a lifetime of a pod, " +
      "but persistent volumes exist beyond the lifetime of a pod. When a pod ceases to exist, Kubernetes " +
      "destroys ephemeral volumes; however, Kubernetes does not destroy persistent volumes.",
  },
};

console.log("1. Definition from context (should not search)");
const first = await ask(null, { ...noSearch, options });
check("answered", first.at(-1)?.type === "done");
check("no web search", !first.some((e) => e.type === "status" && e.phase === "searching"));

console.log("2. Follow-up in the same conversation");
const id = (first[0] as { type: "conversation"; id: string }).id;
const session = conversations.get(id)?.agent?.id;
const followUp = await ask(id, { question: "How is that different from persistent?", options });
check("follow-up answered", followUp.at(-1)?.type === "done");
if (plan) check("follow-up continued the agent's session", Boolean(session) && conversations.get(id)?.agent?.id === session);

if (web) {
  console.log("3. Current facts (should search)");
  const search = await ask(null, {
    question: "What's the latest LTS release of this?",
    selection: "Node.js",
    context: { appName: "Text Editor", windowTitle: "notes.txt", text: "Upgrade Node.js on the build servers." },
    options,
  } satisfies StartConversationRequest);
  check("answered", search.at(-1)?.type === "done");
  check("searched the web", search.some((e) => e.type === "status" && e.phase === "searching"));
  check("returned sources", search.some((e) => e.type === "sources" && e.items.length > 0));
}

// Every tool Kiki has, so the model accepts all their schemas (alongside its web search, where it has one).
const ALL_TOOLS: ToolAccess = { actions: true, open: true, screen: true, click: true, press: true, fill: true, edit: "replace" };

console.log("4. A card (Kiki's tools)");
const card = await ask(null, {
  question: "Remind me to renew my passport on October 30.",
  selection: "Passport renewal",
  context: { appName: "Zen", windowTitle: "Passport renewal | Canada.ca" },
  tools: ALL_TOOLS,
  clock: { timeZone: "America/Toronto", now: "2026-10-19T10:00:00-04:00" },
  options,
} satisfies StartConversationRequest);
check("answered", card.at(-1)?.type === "done");
check("proposed a task", card.some((e) => e.type === "action" && e.action.kind === "task"));

console.log("5. Follow-up after a card (earlier tool calls in the history)");
const cardId = (card[0] as { type: "conversation"; id: string }).id;
const afterCard = await ask(cardId, { question: "Look at my screen: what does the page say?", tools: ALL_TOOLS, options });
check("answered", afterCard.at(-1)?.type === "done");
check("looked at the screen (with a screenshot)", afterCard.some((e) => e.type === "tool_call" && (e.name === "look" || e.name === "scroll")));

engine.close();
