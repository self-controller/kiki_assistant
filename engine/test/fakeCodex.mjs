// A stand-in for `codex app-server`, for tests: speaks its JSON-RPC over stdio and plays a scenario.
// Run as `node fakeCodex.mjs <scenario JSON> app-server ...`. It logs what it receives to `scenario.logFile`.
//
// scenario: {
//   logFile: string,
//   account?: object | null,             // what account/read returns (ChatGPT by default; null: signed out)
//   turns: Step[][],                     // one list of steps per turn/start, in order
// }
// Step: { notify: method, params } | { toolCall: { tool, arguments, callId } } | { complete: status, error? }
//       | { waitInterrupt: true }
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const scenario = JSON.parse(process.argv[2]);
const log = (entry) => appendFileSync(scenario.logFile, `${JSON.stringify(entry)}\n`);
log({
  argv: process.argv.slice(3),
  env: { OPENAI_API_KEY: "OPENAI_API_KEY" in process.env, ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY" in process.env },
});

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const threads = new Set();
let threadCount = 0;
let turnCount = 0;
let serverRequest = 0;
/** Answers to Kiki's tool calls and the interrupt, by what's waiting for them. */
const waiting = new Map();

async function play(threadId, turnId, steps) {
  for (const step of steps) {
    if (step.notify) {
      send({ method: step.notify, params: { threadId, turnId, ...step.params } });
    } else if (step.toolCall) {
      const id = `srv-${++serverRequest}`;
      const answered = new Promise((resolve) => waiting.set(id, resolve));
      send({ id, method: "item/tool/call", params: { threadId, turnId, namespace: null, ...step.toolCall } });
      log({ toolResponse: await answered });
    } else if (step.waitInterrupt) {
      await new Promise((resolve) => waiting.set("interrupt", resolve));
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted", error: null, items: [] } } });
    } else if (step.complete) {
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: step.complete, error: step.error ?? null, items: [] } } });
    }
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  log({ received: message });
  const { id, method, params } = message;
  if (method === undefined) {
    waiting.get(id)?.(message);
    return;
  }
  if (method === "initialize") send({ id, result: { userAgent: "fake/0.0.0", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
  else if (method === "account/read") send({ id, result: { account: "account" in scenario ? scenario.account : { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true } });
  else if (method === "thread/start") {
    const threadId = `thread-${++threadCount}`;
    threads.add(threadId);
    send({ id, result: { thread: { id: threadId }, model: params.model } });
  } else if (method === "turn/start") {
    if (!threads.has(params.threadId)) {
      send({ id, error: { code: -32600, message: `thread not found: ${params.threadId}` } });
      return;
    }
    const turnId = `turn-${++turnCount}`;
    send({ id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
    void play(params.threadId, turnId, scenario.turns[turnCount - 1] ?? [{ complete: "completed" }]);
  } else if (method === "turn/interrupt") {
    send({ id, result: {} });
    waiting.get("interrupt")?.();
  } else if (method !== "initialized") {
    send({ id, result: {} });
  }
});
