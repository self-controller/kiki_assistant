// Claude on the person's own Claude plan (see accounts.ts): the Claude Code they installed and signed in to
// runs the turn, through the Agent SDK. It gets Kiki's system prompt and tools plus its own web search and
// fetch, and nothing else of Claude Code: no files or shell, and none of the person's settings, hooks,
// plugins, CLAUDE.md or MCP servers. Follow-ups resume the same Claude Code session.
import {
  createSdkMcpServer,
  deleteSession,
  query,
  startup,
  tool,
  type HookCallback,
  type Options,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { hasAdaptiveThinking } from "./claude.ts";
import { agentCwd, agentEnv, PlanError, resetNote, sessionKey } from "./accounts.ts";
import { blocksOf, systemPrompt, withEarlierTurns } from "./prompt.ts";
import { toolsFor } from "./tools.ts";
import {
  canonicalToolId,
  emptyUsage,
  isKikiTool,
  MAX_SCREEN_STEPS,
  MAX_TOOL_ROUNDS,
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

/** Starts a Claude Code query: the Agent SDK's `query`, or a stand-in in tests. */
export type ClaudeCodeQuery = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>;

export const claudeCodeQuery: ClaudeCodeQuery = (params) => query(params);

/** A Claude Code process started ahead of its question (the Agent SDK's `WarmQuery`): it takes the question once, or closes. */
export interface ClaudeCodeWarm {
  query(prompt: AsyncIterable<SDKUserMessage>): AsyncIterable<SDKMessage>;
  close(): void;
}

/** Starts a Claude Code process ahead of its question: the Agent SDK's `startup`, or a stand-in in tests. */
export type ClaudeCodeStartup = (params: { options: Options }) => Promise<ClaudeCodeWarm>;

export const claudeCodeStartup: ClaudeCodeStartup = (params) => startup(params);

/** Forgets a conversation's Claude Code session once the conversation is gone. */
export function releaseClaudeCodeSession(sessionId: string): void {
  deleteSession(sessionId, { dir: agentCwd() }).catch(() => {});
}

/** Claude Code's name for Kiki's tool `name`. */
const KIKI_PREFIX = "mcp__kiki__";

const PLAN_NOTE = `Kiki's tools above reach you as mcp__kiki__<name> (mcp__kiki__open_search and so on). Your web search results end with a reminder to list sources; in Kiki that's already done for you (the pages you searched and read show under your answer), so skip the list and don't mention it.`;

function addUsage(total: ReturnType<typeof emptyUsage>, result: SDKResultMessage): void {
  for (const model of Object.values(result.modelUsage)) {
    total.inputTokens += model.inputTokens;
    total.outputTokens += model.outputTokens;
    total.cacheReadTokens += model.cacheReadInputTokens;
    total.cacheWriteTokens += model.cacheCreationInputTokens;
    total.webSearches += model.webSearchRequests;
  }
}

/** A URL without its scheme or trailing slash, to compare the ones Claude fetches with the ones it saw. */
function bareUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** The text of the conversation so far, where Claude may have seen a page's address. */
function conversationText(history: Anthropic.Beta.BetaMessageParam[]): string {
  return history
    .flatMap((message) =>
      blocksOf(message).flatMap((block) => {
        if (block.type === "text") return [block.text];
        if (block.type === "tool_result") return resultParts(block.content).flatMap((part) => (part.type === "text" ? [part.text] : []));
        return [];
      }),
    )
    .join("\n")
    .replace(/https?:\/\//g, "");
}

/** Each tool's input shape for the Agent SDK, from its JSON schema once: the definitions are constants. */
const toolShapes = new Map<string, z.ZodObject["shape"]>();

function toolShape(def: Anthropic.Beta.BetaTool): z.ZodObject["shape"] {
  let shape = toolShapes.get(def.name);
  if (!shape) {
    shape = (z.fromJSONSchema(def.input_schema as z.core.JSONSchema.JSONSchema) as z.ZodObject).shape;
    toolShapes.set(def.name, shape);
  }
  return shape;
}

/** A Kiki tool's result as Claude Code takes it from an MCP tool: its text, and the screenshot of a scroll. */
function toolOutput(result: Anthropic.Beta.BetaToolResultBlockParam): CallToolResult {
  const content: CallToolResult["content"] = resultParts(result.content).map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : { type: "image" as const, data: part.source.data, mimeType: part.source.media_type },
  );
  return result.is_error ? { content, isError: true } : { content };
}

/** What the person sees when Claude Code couldn't answer. */
function planError(error: SDKAssistantMessageError | undefined, rateLimit: SDKRateLimitInfo | undefined, detail: string): PlanError {
  if (error === "rate_limit" || rateLimit?.status === "rejected") {
    return new PlanError("limit", `You've used up your Claude plan's limit for now${resetNote(rateLimit?.resetsAt)}.`);
  }
  if (error === "authentication_failed" || error === "oauth_org_not_allowed") {
    return new PlanError("unauthorized", "Claude Code isn't signed in. Run `claude` in a terminal and log in with your Claude account.");
  }
  if (error === "billing_error" || error === "account_on_hold" || error === "verification_required") {
    return new PlanError("upstream", "Your Claude account can't be used right now. Check it at claude.ai.");
  }
  if (error === "model_not_found") return new PlanError("upstream", "Your Claude plan doesn't include this model. Pick another one.");
  if (error === "overloaded") return new PlanError("busy", "Claude is busy right now. Try again in a moment.");
  if (error === "server_error") return new PlanError("upstream", "Claude is temporarily unavailable. Try again shortly.");
  return new PlanError("upstream", "Claude Code returned an error. Try again.", true, detail);
}

/** What a Claude Code process is started with (`ClaudeCodeProcess`); a question that needs anything else can't use it. */
export type ClaudeCodeSetup = Pick<TurnOptions, "config" | "model" | "effort" | "tools" | "personality" | "agent"> & { executable: string };

/**
 * The turn a process serves, which its tools and hooks read when they're called: a process started ahead of
 * its question (`ClaudeCodeProcess.warm`) has them before the turn exists.
 */
interface TurnState {
  options: TurnOptions;
  budget: ToolBudget;
  transcript: TurnTranscript;
  sources: SourceCollector;
  /** Web searches and page reads so far, within the answer's limits. */
  searches: number;
  fetches: number;
  /** The conversation's text, where Claude may have seen a page's address; read when first needed. */
  seen?: string;
}

/** What a process starts with, from its setup: the prompt, the session it continues, its tools, and a fingerprint of them all. */
function startOf(setup: ClaudeCodeSetup) {
  const effort = setup.effort ?? setup.config.effort;
  const system = `${systemPrompt(setup.personality)}\n\n${PLAN_NOTE}`;
  // Claude Code keeps the system prompt a session started with; Kiki's tools can change between turns.
  const key = sessionKey(system);
  const resume = setup.agent?.provider === "anthropic" && setup.agent.key === key ? setup.agent.id : undefined;
  const tools = toolsFor(setup.tools);
  const fingerprint = sessionKey({ system, tools: tools.map((def) => def.name), model: setup.model, effort, resume, executable: setup.executable });
  return { effort, system, key, resume, tools, fingerprint };
}

/** The Agent SDK options `claude` starts with. Its tools and hooks serve whatever turn the process has when they're called. */
function processOptions(setup: ClaudeCodeSetup, start: ReturnType<typeof startOf>, claude: ClaudeCodeProcess): Options {
  const { config } = setup;
  // Tools and hooks are only called for the question the process got, and by then it has its turn.
  const turnOf = () => claude.turn!;
  const kikiTools = start.tools.map((def) =>
    tool(
      def.name,
      def.description ?? "",
      toolShape(def),
      async (args: Record<string, unknown>, extra: unknown) => {
        const turn = turnOf();
        const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta;
        const id = typeof meta?.["claudecode/toolUseId"] === "string" ? meta["claudecode/toolUseId"] : canonicalToolId("");
        return toolOutput(await runAgentTool({ id, name: def.name, input: args }, turn.budget, turn.transcript, turn.options));
      },
    ),
  );

  // Web searches and page reads, within the answer's limits. A page must be one Claude found by searching or
  // saw in the conversation, as with the API's web fetch: nothing on screen can send it to an address it
  // made up, carrying what's on screen.
  const webGate: HookCallback = async (input) => {
    const deny = (reason: string) => ({
      hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason },
    });
    if (input.hook_event_name !== "PreToolUse") return {};
    const turn = turnOf();
    if (input.tool_name === "WebSearch") {
      if (turn.searches >= config.maxSearches) return deny("That's all the searching for this answer: answer with what you found.");
      turn.searches++;
    } else if (input.tool_name === "WebFetch") {
      const url = String((input.tool_input as { url?: unknown } | null)?.url ?? "");
      if (turn.fetches >= config.maxFetches) return deny("That's all the page reading for this answer: answer with what you have.");
      const known =
        turn.sources.urls().some((found) => bareUrl(found) === bareUrl(url)) ||
        (turn.seen ??= conversationText(turn.options.history)).includes(bareUrl(url));
      if (!known) return deny("You can only read pages from your search results or from the conversation.");
      turn.fetches++;
    }
    return {};
  };

  return {
    model: setup.model,
    effort: start.effort,
    ...(hasAdaptiveThinking(setup.model) ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
    systemPrompt: start.system,
    tools: config.maxFetches > 0 ? ["WebSearch", "WebFetch"] : ["WebSearch"],
    allowedTools: ["mcp__kiki", "WebSearch", "WebFetch"],
    // Anything else that would ask is refused; there's no one at Claude Code to ask.
    permissionMode: "dontAsk",
    settingSources: [],
    strictMcpConfig: true,
    ...(kikiTools.length > 0 ? { mcpServers: { kiki: createSdkMcpServer({ name: "kiki", tools: kikiTools }) } } : {}),
    hooks: { PreToolUse: [{ matcher: "WebSearch|WebFetch", hooks: [webGate] }] },
    includePartialMessages: true,
    ...(start.resume ? { resume: start.resume } : {}),
    maxTurns: MAX_TOOL_ROUNDS + MAX_SCREEN_STEPS + config.maxSearches + config.maxFetches + 3,
    cwd: agentCwd(),
    // Their own installed Claude Code, unmodified; Kiki doesn't ship one.
    pathToClaudeCodeExecutable: setup.executable,
    env: { ...agentEnv(), CLAUDE_AGENT_SDK_CLIENT_APP: "kiki/0.2.0" },
    abortController: claude.controller,
  };
}

/**
 * One Claude Code process for one question. The Agent SDK fixes everything at startup (prompt, tools, hooks,
 * model, session), so one started ahead of its question (`warm`) serves only a turn whose setup has the same
 * `fingerprint`; the engine keeps one such spare (`Engine.warm`).
 */
export class ClaudeCodeProcess {
  readonly fingerprint: string;
  /** The session it continues, if any, and the key of the one the turn leaves (`AgentSession.key`). */
  readonly resume: string | undefined;
  readonly key: string;
  readonly options: Options;
  /** Cancels the question (the SDK takes the controller at startup, like everything else). */
  readonly controller = new AbortController();
  /** The turn it serves, set when the question goes. */
  turn: TurnState | undefined;
  #warm: ClaudeCodeWarm | undefined;

  constructor(setup: ClaudeCodeSetup) {
    const start = startOf(setup);
    this.fingerprint = start.fingerprint;
    this.resume = start.resume;
    this.key = start.key;
    this.options = processOptions(setup, start, this);
  }

  /** Starts the process now, ahead of its question. */
  async warm(startup: ClaudeCodeStartup): Promise<void> {
    this.#warm = await startup({ options: this.options });
  }

  /** Sends the question: to the process started ahead, or to one `query` starts now. */
  ask(prompt: AsyncIterable<SDKUserMessage>, query: ClaudeCodeQuery): AsyncIterable<SDKMessage> {
    return this.#warm ? this.#warm.query(prompt) : query({ prompt, options: this.options });
  }

  /** Closes a process started ahead without sending it a question. */
  close(): void {
    this.#warm?.close();
  }
}

/** Hands a turn the process started ahead for its `fingerprint`, if there is one (`Engine.warm`). */
export type TakeSpare = (fingerprint: string) => ClaudeCodeProcess | undefined;

/**
 * Runs one user turn with the person's Claude Code (`executable`), streaming Kiki events through `emit`.
 * `history` must already end with the new user message; it is not modified. Throws a `PlanError`.
 */
export async function runClaudeCodeTurn(
  options: TurnOptions & { query: ClaudeCodeQuery; executable: string; takeSpare?: TakeSpare },
): Promise<TurnResult> {
  const { history, emit, signal } = options;
  const needed = new ClaudeCodeProcess(options);
  const { key, resume } = needed;
  const message = resume ? history.at(-1)! : withEarlierTurns(history);

  const feed = new TurnFeed(emit);
  const turn: TurnState = {
    options,
    budget: new ToolBudget(),
    transcript: new TurnTranscript(),
    sources: new SourceCollector(),
    searches: 0,
    fetches: 0,
  };
  const { budget, sources, transcript } = turn;
  const usage = emptyUsage();
  /** Each tool call's tool, by id, to tell what a tool result is from. */
  const toolNames = new Map<string, string>();
  let refused = false;
  let failure: SDKAssistantMessageError | undefined;
  let rateLimit: SDKRateLimitInfo | undefined;
  let result: SDKResultMessage | undefined;
  let sessionId = resume;
  let responseId: string | undefined;

  // Cancelled before it started: nothing runs on the person's plan.
  if (signal?.aborted) throw new PlanError("internal", "Request cancelled.");
  // The process started ahead for this very question, if there is one; otherwise one starts now.
  const claude = options.takeSpare?.(needed.fingerprint) ?? needed;
  claude.turn = turn;
  const stopAbort = whenAborted(signal, () => claude.controller.abort());
  const prompt = (async function* () {
    yield { type: "user", message: message as SDKUserMessage["message"], parent_tool_use_id: null } satisfies SDKUserMessage;
  })();

  try {
    for await (const event of claude.ask(prompt, options.query)) {
      if (event.type === "system" && event.subtype === "init") {
        sessionId = event.session_id;
      } else if (event.type === "system" && event.subtype === "model_refusal_no_fallback") {
        refused = true;
      } else if (event.type === "rate_limit_event") {
        rateLimit = event.rate_limit_info;
      } else if (event.type === "stream_event") {
        const streamed = event.event;
        if (streamed.type === "message_start") {
          feed.startResponse();
        } else if (streamed.type === "content_block_start") {
          const block = streamed.content_block;
          if (block.type === "thinking") feed.thinkingBlock();
          else if (block.type === "text") feed.phase("writing");
          else if (block.type === "tool_use") {
            toolNames.set(block.id, block.name);
            if (block.name === "WebSearch") feed.phase("searching");
            else if (block.name.startsWith(KIKI_PREFIX) && isKikiTool(block.name.slice(KIKI_PREFIX.length))) feed.toolStarting();
          }
        } else if (streamed.type === "content_block_delta") {
          if (streamed.delta.type === "thinking_delta") feed.thinking(streamed.delta.thinking);
          else if (streamed.delta.type === "text_delta") feed.text(streamed.delta.text);
        } else if (streamed.type === "message_delta" && streamed.delta.stop_reason === "refusal") {
          refused = true;
        }
      } else if (event.type === "assistant" && event.parent_tool_use_id === null) {
        if (event.error) failure = event.error;
        if (event.message.id !== responseId) {
          responseId = event.message.id;
          transcript.newResponse();
          budget.newResponse();
        }
        for (const block of event.message.content) {
          if (block.type === "text") transcript.text(block.text);
          else if (block.type === "tool_use" && block.name.startsWith(KIKI_PREFIX)) {
            const input = (block.input ?? {}) as Record<string, unknown>;
            transcript.toolUse({ id: block.id, name: block.name.slice(KIKI_PREFIX.length), input });
          } else if (block.type === "tool_use" && block.name === "WebSearch") {
            const query = (block.input as { query?: unknown }).query;
            if (typeof query === "string" && query) feed.search(query);
          } else if (block.type === "tool_use" && block.name === "WebFetch") {
            const url = (block.input as { url?: unknown }).url;
            if (typeof url === "string") feed.read(url);
          }
        }
      } else if (event.type === "user" && event.parent_tool_use_id === null) {
        const content = event.message.content;
        const resultFor = Array.isArray(content) ? content.find((block) => block.type === "tool_result") : undefined;
        const tool = resultFor?.type === "tool_result" ? toolNames.get(resultFor.tool_use_id) : undefined;
        if (tool === "WebSearch") {
          // The results come in groups, between notes to Claude.
          const output = event.tool_use_result as { results?: Array<{ content?: Array<{ url?: unknown; title?: unknown }> } | string> } | undefined;
          const groups = output?.results ?? [];
          feed.results(groups.flatMap((group) => (typeof group === "object" && group !== null ? (group.content ?? []) : [])), sources);
          feed.phase("thinking");
        } else if (tool === "WebFetch") {
          const url = (event.tool_use_result as { url?: unknown } | undefined)?.url;
          if (typeof url === "string") sources.addSearched(url, null);
          feed.phase("thinking");
        }
      } else if (event.type === "result") {
        result = event;
        addUsage(usage, event);
      }
    }
  } catch (error) {
    // Their Claude Code moved, or can't start: say so, rather than a generic failure.
    if (!signal?.aborted && error instanceof Error && !(error instanceof PlanError) && /executable|ENOENT|EACCES|spawn/i.test(error.message)) {
      throw new PlanError("upstream", "Kiki couldn't start Claude Code. Check that `claude` runs in a terminal, then try again.", true, error.message);
    }
    throw error;
  } finally {
    stopAbort();
  }

  if (refused || result?.stop_reason === "refusal") return { kind: "refused", usage };
  if (!result || result.subtype !== "success" || result.is_error || failure) {
    const detail = result ? (result.subtype === "success" ? result.result : result.errors.join("; ")) : "no result";
    throw planError(failure, rateLimit, detail);
  }
  return {
    kind: "answered",
    messages: transcript.messages(),
    stopReason: result.stop_reason === "max_tokens" ? "max_tokens" : "end_turn",
    sources: sources.result(),
    usage,
    ...(sessionId ? { agent: { provider: "anthropic" as const, id: sessionId, key } } : {}),
  };
}
