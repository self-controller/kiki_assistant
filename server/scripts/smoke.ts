// Live end-to-end check against the real Claude API (costs a few cents).
// Runs the Kiki app in-process with throwaway in-memory stores:
//   npm run smoke -w server
import "../src/env.ts";
import Anthropic from "@anthropic-ai/sdk";
import type { KikiEvent, StartConversationRequest } from "@kiki/shared";
import { createApp } from "../src/app.ts";
import { DEFAULT_CLAUDE_CONFIG } from "../src/claude.ts";
import { CodeStore } from "../src/codes.ts";
import { ConversationStore } from "../src/conversations.ts";

const codes = new CodeStore(":memory:");
const { code } = codes.create("smoke", 100);
const app = createApp({
  codes,
  conversations: new ConversationStore(),
  client: new Anthropic(),
  config: { ...DEFAULT_CLAUDE_CONFIG, model: process.env.KIKI_MODEL || DEFAULT_CLAUDE_CONFIG.model },
  log: (line) => console.log(`  server: ${line}`),
});

async function ask(path: string, body: unknown): Promise<KikiEvent[]> {
  const started = Date.now();
  const response = await app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${code}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const events: KikiEvent[] = [];
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let firstTextAt = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = chunk.split("\n").find((line) => line.startsWith("data: "));
      if (!data) continue;
      const event = JSON.parse(data.slice(6)) as KikiEvent;
      events.push(event);
      if (event.type === "text") {
        if (!firstTextAt) firstTextAt = Date.now();
        process.stdout.write(event.delta);
      } else if (event.type === "status") {
        console.log(`  [${event.phase}${event.query ? `: ${event.query}` : ""}]`);
      } else if (event.type !== "conversation") {
        console.log(`\n  [${event.type}] ${JSON.stringify(event)}`);
      }
    }
  }
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
const first = await ask("/v1/conversations", noSearch);
check("answered", first.at(-1)?.type === "done");
check("no web search", !first.some((e) => e.type === "status" && e.phase === "searching"));

console.log("2. Follow-up in the same conversation");
const id = (first[0] as { type: "conversation"; id: string }).id;
const followUp = await ask(`/v1/conversations/${id}/messages`, { question: "How is that different from persistent?" });
check("follow-up answered", followUp.at(-1)?.type === "done");
check("follow-up read the prompt cache", (codes.usage(1)[0]?.cacheReadTokens ?? 0) > 0);

console.log("3. Current facts (should search)");
const search = await ask("/v1/conversations", {
  question: "What's the latest LTS release of this?",
  selection: "Node.js",
  context: { appName: "Text Editor", windowTitle: "notes.txt", text: "Upgrade Node.js on the build servers." },
} satisfies StartConversationRequest);
check("answered", search.at(-1)?.type === "done");
check("searched the web", search.some((e) => e.type === "status" && e.phase === "searching"));
check("returned sources", search.some((e) => e.type === "sources" && e.items.length > 0));

const usage = codes.usage(1)[0];
console.log(`\nUsage: ${JSON.stringify(usage)}`);
