// OpenAI's models on the person's own ChatGPT plan (see accounts.ts): the Codex they installed and signed in
// to runs the turn through its app server (`codex app-server`, JSON-RPC over stdio). Each conversation is a
// Codex thread with Kiki's instructions and Kiki's tools; Codex's own tools are off except web search, and so
// are the person's MCP servers, plugins and memories. Follow-ups continue the thread.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type Anthropic from "@anthropic-ai/sdk";
import { agentCwd, agentEnv, findExecutable, PlanError, resetNote, sessionKey } from "./accounts.ts";
import { blocksOf, systemPrompt, withEarlierTurns } from "./prompt.ts";
import { toolsFor } from "./tools.ts";
import {
  canonicalToolId,
  dataUrl,
  emptyUsage,
  isKikiTool,
  parseArguments,
  resultParts,
  runAgentTool,
  SourceCollector,
  ToolBudget,
  TurnFeed,
  TurnTranscript,
  whenAborted,
  type TurnOptions,
  type TurnResult,
} from "./turn.ts";

/** Codex features that would give the model more than Kiki's tools and web search: shell, files, apps, … */
const FEATURES_OFF = [
  "shell_tool",
  "unified_exec",
  "view_image",
  "apps",
  "plugins",
  "multi_agent",
  "computer_use",
  "browser_use",
  "browser_use_external",
  "in_app_browser",
  "image_generation",
  "memories",
  "goals",
  "hooks",
  "tool_suggest",
  "skill_search",
  "sleep_tool",
  "workspace_dependencies",
];

type JsonObject = Record<string, unknown>;

/** A thread's turn, listening to what Codex says about it. */
interface ThreadListener {
  notify(method: string, params: JsonObject): void;
  /** Answers Codex's request (a call to one of Kiki's tools). */
  request(method: string, params: JsonObject): Promise<unknown>;
  /** The app server stopped. */
  closed(error: Error): void;
}

/** A Codex rate-limit window, as `account/rateLimits/updated` reports it. */
interface RateLimitWindow {
  usedPercent: number;
  resetsAt: number | null;
}

export class CodexRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexRpcError";
  }
}

export interface CodexAppServerOptions {
  /** The program to run: the codex executable by default; tests run a stand-in with node. */
  command?: string;
  /** Arguments before the app server's own (a stand-in's script). */
  args?: string[];
  /** Where Codex reads config.toml, to switch off the person's MCP servers. */
  codexHome?: string;
}

/** The names of the MCP servers in Codex's config.toml, so a thread can switch them off. */
export function configuredMcpServers(configToml: string): string[] {
  const names = new Set<string>();
  for (const match of configToml.matchAll(/^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/gm)) {
    names.add(match[1] ?? match[2]!);
  }
  return [...names];
}

/**
 * One `codex app-server`, started when first needed and again after it stops. It checks that Codex is
 * signed in before any turn.
 */
export class CodexAppServer {
  readonly #options: CodexAppServerOptions;
  #child: ChildProcessWithoutNullStreams | null = null;
  #ready: Promise<void> | null = null;
  #nextId = 1;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly #threads = new Map<string, ThreadListener>();
  /** The plan's latest limits, which say when a used-up one resets. */
  rateLimits: { primary?: RateLimitWindow | null; secondary?: RateLimitWindow | null } | null = null;

  constructor(options: CodexAppServerOptions = {}) {
    this.#options = options;
  }

  /** Starts the app server now (a request would anyway), so the first turn doesn't wait for it. */
  start(): Promise<void> {
    return this.#start();
  }

  /** Sends `method` once the app server is ready, and waits for its answer. */
  async request<T>(method: string, params: unknown): Promise<T> {
    await this.#start();
    return (await this.#send(method, params)) as T;
  }

  /** Routes what Codex says about `threadId` to `listener` until the returned function is called. */
  listen(threadId: string, listener: ThreadListener): () => void {
    this.#threads.set(threadId, listener);
    return () => {
      if (this.#threads.get(threadId) === listener) this.#threads.delete(threadId);
    };
  }

  /** Unloads a thread whose conversation is gone. */
  release(threadId: string): void {
    if (this.#child) this.#send("thread/unsubscribe", { threadId }).catch(() => {});
  }

  close(): void {
    this.#child?.kill();
  }

  /** Settings for a new thread: no MCP servers from the person's config, and live web search. */
  threadConfig(): JsonObject {
    const home = this.#options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    let toml = "";
    try {
      toml = readFileSync(join(home, "config.toml"), "utf8");
    } catch {
      // No config: nothing to switch off.
    }
    const config: JsonObject = { web_search: "live" };
    for (const name of configuredMcpServers(toml)) config[`mcp_servers.${name}.enabled`] = false;
    return config;
  }

  #start(): Promise<void> {
    this.#ready ??= this.#spawn().catch((error: unknown) => {
      this.#child?.kill();
      this.#ready = null;
      throw error;
    });
    return this.#ready;
  }

  async #spawn(): Promise<void> {
    const command = this.#options.command ?? findExecutable("codex");
    if (!command) throw new PlanError("unauthorized", "Kiki can't find Codex on this computer. Install it, then run `codex login` in a terminal.");
    const args = [
      ...(this.#options.args ?? []),
      "app-server",
      // `-c`, unlike `--disable`, doesn't fail on a feature another Codex version doesn't have.
      ...FEATURES_OFF.flatMap((feature) => ["-c", `features.${feature}=false`]),
    ];
    const child = spawn(command, args, { cwd: agentCwd(), env: agentEnv(), stdio: ["pipe", "pipe", "pipe"] });
    this.#child = child;
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2_000);
    });
    child.stdin.on("error", () => {});
    createInterface({ input: child.stdout }).on("line", (line) => this.#receive(line));
    child.on("error", (error) => this.#stopped(child, new PlanError("upstream", "Kiki couldn't start Codex. Check that `codex` runs in a terminal, then try again.", true, error.message)));
    child.on("exit", (code) => this.#stopped(child, new PlanError("upstream", "Codex stopped. Try again.", true, `exit ${code}: ${stderr}`)));

    await this.#send("initialize", {
      clientInfo: { name: "kiki", title: "Kiki", version: "0.2.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.#write({ method: "initialized" });
    const { account } = (await this.#send("account/read", {})) as { account: { type: string } | null };
    if (!account) throw new PlanError("unauthorized", "Codex isn't signed in. Run `codex login` in a terminal and sign in with ChatGPT.");
  }

  #stopped(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.#child !== child) return;
    this.#child = null;
    this.#ready = null;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const listener of this.#threads.values()) listener.closed(error);
    this.#threads.clear();
  }

  #write(message: JsonObject): void {
    this.#child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #send(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      if (!this.#child) return reject(new PlanError("upstream", "Codex stopped. Try again.", true));
      this.#pending.set(id, { resolve, reject });
      this.#write({ id, method, params });
    });
  }

  #receive(line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return;
    }
    const { id, method } = message;
    const params = (message["params"] ?? {}) as JsonObject;
    if (typeof method !== "string") {
      const pending = this.#pending.get(id as number);
      if (!pending) return;
      this.#pending.delete(id as number);
      const error = message["error"] as { message?: string } | undefined;
      if (error) pending.reject(new CodexRpcError(error.message ?? "Codex returned an error."));
      else pending.resolve(message["result"]);
      return;
    }
    const listener = typeof params["threadId"] === "string" ? this.#threads.get(params["threadId"]) : undefined;
    if (id !== undefined) {
      // Codex asks something: Kiki's tools go to their turn; anything else (approvals) is declined.
      const answer = listener
        ? listener.request(method, params)
        : Promise.reject(new CodexRpcError(`Kiki doesn't handle ${method}.`));
      answer.then(
        (result) => this.#write({ id, result }),
        (error: unknown) =>
          method.endsWith("requestApproval")
            ? this.#write({ id, result: { decision: "decline" } })
            : this.#write({ id, error: { code: -32601, message: error instanceof Error ? error.message : String(error) } }),
      );
      return;
    }
    if (method === "account/rateLimits/updated") {
      this.rateLimits = (params["rateLimits"] ?? null) as typeof this.rateLimits;
    } else if (method === "account/updated" && !params["authMode"]) {
      // Signed out: the next turn starts over and checks again.
      this.#child?.kill();
    }
    listener?.notify(method, params);
  }
}

/** When the plan's used-up limit resets, from the latest limits Codex reported. */
function codexReset(server: CodexAppServer): number | null {
  const windows = [server.rateLimits?.primary, server.rateLimits?.secondary].filter((w): w is RateLimitWindow => Boolean(w));
  const full = windows.filter((window) => window.usedPercent >= 100 && window.resetsAt);
  return Math.max(0, ...full.map((window) => window.resetsAt!)) || null;
}

/** What the person sees when a Codex turn failed. */
function turnError(error: { message?: string; codexErrorInfo?: unknown } | null, server: CodexAppServer): PlanError {
  const info = error?.codexErrorInfo;
  const kind = typeof info === "string" ? info : typeof info === "object" && info ? Object.keys(info)[0] : undefined;
  if (kind === "usageLimitExceeded") {
    return new PlanError("limit", `You've used up your ChatGPT plan's Codex limit for now${resetNote(codexReset(server))}.`);
  }
  if (kind === "unauthorized") {
    return new PlanError("unauthorized", "Codex isn't signed in. Run `codex login` in a terminal and sign in with ChatGPT.");
  }
  if (kind === "rateLimitExceeded" || kind === "serverOverloaded") {
    return new PlanError("busy", "GPT is busy right now. Try again in a moment.");
  }
  if (kind === "contextWindowExceeded") {
    return new PlanError("limit", "This conversation is too long for GPT. Close Kiki and highlight the text again to start fresh.");
  }
  return new PlanError("upstream", "Codex returned an error. Try again.", true, error?.message);
}

/** A question as Codex input: its images as data URLs, then its text. */
function codexInput(message: Anthropic.Beta.BetaMessageParam): JsonObject[] {
  const input: JsonObject[] = [];
  for (const block of blocksOf(message)) {
    if (block.type === "image" && block.source.type === "base64") {
      input.push({ type: "image", url: dataUrl(block.source) });
    } else if (block.type === "text") {
      input.push({ type: "text", text: block.text, text_elements: [] });
    }
  }
  return input;
}

/** A Kiki tool's result as Codex takes it: its text, and the screenshot of a scroll. */
function toolOutput(result: Anthropic.Beta.BetaToolResultBlockParam): { contentItems: JsonObject[]; success: boolean } {
  const contentItems: JsonObject[] = resultParts(result.content).map((part) =>
    part.type === "text" ? { type: "inputText", text: part.text } : { type: "inputImage", imageUrl: dataUrl(part.source) },
  );
  return { contentItems, success: !result.is_error };
}

/**
 * Runs one user turn with the person's Codex, streaming Kiki events through `emit`.
 * `history` must already end with the new user message; it is not modified. Throws a `PlanError`.
 */
export async function runCodexTurn(options: TurnOptions & { codex: CodexAppServer }): Promise<TurnResult> {
  const { codex, config, history, emit, signal, model } = options;
  const effort = options.effort ?? config.effort;
  const instructions = systemPrompt(options.personality);
  const tools = toolsFor(options.tools).map((def) => ({
    type: "function",
    name: def.name,
    description: def.description ?? "",
    inputSchema: def.input_schema,
  }));
  // A thread keeps the instructions and tools it started with.
  const key = sessionKey({ instructions, tools });

  const feed = new TurnFeed(emit);
  const sources = new SourceCollector();
  const transcript = new TurnTranscript();
  const budget = new ToolBudget();
  const usage = emptyUsage();
  let refused = false;
  let failed: { message?: string; codexErrorInfo?: unknown } | null = null;
  let thinkingPart = "";
  /** A model request finished; the feed hears of the next response when Codex starts on it. */
  let between = false;

  let finish!: (error?: Error) => void;
  const finished = new Promise<void>((resolve, reject) => {
    finish = (error) => (error ? reject(error) : resolve());
  });
  // Awaited once the turn has started; Codex may stop before that.
  finished.catch(() => {});
  let turnId: string | undefined;

  const listener: ThreadListener = {
    notify(method, params) {
      if (turnId && typeof params["turnId"] === "string" && params["turnId"] !== turnId) return;
      const item = (params["item"] ?? {}) as JsonObject;
      if (method === "item/agentMessage/delta") {
        feed.phase("writing");
        feed.text(String(params["delta"] ?? ""));
      } else if (method === "item/reasoning/summaryTextDelta") {
        // A new part of the reasoning summary (or a new reasoning item) starts a new block in the feed.
        const part = `${String(params["itemId"])}:${String(params["summaryIndex"])}`;
        if (part !== thinkingPart) {
          thinkingPart = part;
          feed.thinkingBlock();
        }
        feed.thinking(String(params["delta"] ?? ""));
      } else if (method === "item/started") {
        if (between && item["type"] !== "userMessage") {
          between = false;
          feed.startResponse();
        }
        if (item["type"] === "webSearch") feed.phase("searching");
        else if (item["type"] === "dynamicToolCall" && isKikiTool(String(item["tool"]))) feed.toolStarting();
      } else if (method === "item/completed") {
        if (item["type"] === "agentMessage") transcript.text(String(item["text"] ?? ""));
        else if (item["type"] === "webSearch") {
          const action = (item["action"] ?? {}) as { type?: string; query?: string | null; queries?: string[] | null; url?: string | null };
          if (action.type === "search") {
            const queries = action.queries?.length ? action.queries : [action.query || String(item["query"] ?? "")].filter(Boolean);
            for (const query of queries) feed.search(query);
            feed.results((item["results"] ?? []) as Array<{ url?: unknown; title?: unknown }>, sources);
            usage.webSearches += 1;
          } else if (action.type === "openPage" && action.url) {
            feed.read(action.url);
            sources.addSearched(action.url, null);
          }
          feed.phase("thinking");
        }
      } else if (method === "thread/tokenUsage/updated") {
        // One model request finished: what comes next is a new response.
        const last = ((params["tokenUsage"] ?? {}) as { last?: Record<string, number> }).last ?? {};
        const cached = last["cachedInputTokens"] ?? 0;
        usage.inputTokens += Math.max(0, (last["inputTokens"] ?? 0) - cached);
        usage.cacheReadTokens += cached;
        usage.cacheWriteTokens += last["cacheWriteInputTokens"] ?? 0;
        usage.outputTokens += last["outputTokens"] ?? 0;
        between = true;
        transcript.newResponse();
        budget.newResponse();
      } else if (method === "error" && !params["willRetry"]) {
        failed = (params["error"] ?? null) as typeof failed;
      } else if (method === "turn/completed") {
        const turn = (params["turn"] ?? {}) as { status?: string; error?: typeof failed };
        if (turn.status === "completed") finish();
        else if (turn.status === "interrupted") finish(new PlanError("internal", "Request cancelled."));
        else {
          const error = turn.error ?? failed;
          // Codex blocks some questions for safety: that's a refusal, not an error.
          if (error && /policy|misalignment|cyber/i.test(String(JSON.stringify(error.codexErrorInfo ?? "")))) {
            refused = true;
            finish();
          } else finish(turnError(error, codex));
        }
      }
    },
    async request(method, params) {
      if (method !== "item/tool/call") throw new CodexRpcError(`Kiki doesn't handle ${method}.`);
      const name = String(params["tool"]);
      const id = canonicalToolId(String(params["callId"]));
      const input = parseArguments(params["arguments"]);
      transcript.toolUse({ id, name, input });
      return toolOutput(await runAgentTool({ id, name, input }, budget, transcript, options));
    },
    closed(error) {
      finish(error);
    },
  };

  /** Starts a thread for this conversation with Kiki's instructions and tools. */
  const startThread = async () => {
    const started = await codex.request<{ thread: { id: string } }>("thread/start", {
      model,
      cwd: agentCwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: instructions,
      dynamicTools: tools,
      ephemeral: true,
      config: codex.threadConfig(),
    });
    return started.thread.id;
  };
  const turnParams = (threadId: string, message: Anthropic.Beta.BetaMessageParam) => ({
    threadId,
    input: codexInput(message),
    model,
    effort,
    summary: "auto",
  });

  let threadId = options.agent?.provider === "openai" && options.agent.key === key ? options.agent.id : undefined;
  let stopListening = () => {};
  let stopAbort = () => {};
  feed.startResponse();
  try {
    // Cancelled before it started: nothing runs on the person's plan.
    if (signal?.aborted) throw new PlanError("internal", "Request cancelled.");
    let started: { turn: { id: string } } | undefined;
    if (threadId) {
      stopListening = codex.listen(threadId, listener);
      // The thread is gone when the app server restarted: start over with the conversation so far.
      started = await codex.request<{ turn: { id: string } }>("turn/start", turnParams(threadId, history.at(-1)!)).catch(() => undefined);
      if (!started) stopListening();
    }
    if (!started) {
      threadId = await startThread();
      stopListening = codex.listen(threadId, listener);
      started = await codex.request<{ turn: { id: string } }>("turn/start", turnParams(threadId, withEarlierTurns(history)));
    }
    turnId = started.turn.id;
    // Cancelled while the turn was starting: interrupt it now.
    stopAbort = whenAborted(signal, () => codex.request("turn/interrupt", { threadId, turnId }).catch(() => {}));
    await finished;
  } finally {
    stopListening();
    stopAbort();
  }

  if (refused) return { kind: "refused", usage };
  return {
    kind: "answered",
    messages: transcript.messages(),
    stopReason: "end_turn",
    sources: sources.result(),
    usage,
    agent: { provider: "openai", id: threadId!, key },
  };
}
