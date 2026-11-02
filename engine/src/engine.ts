// Kiki's engine, which runs inside the app: it keeps each conversation, sends its questions to the model
// the person picked (on their own Claude Code, Codex, API key or local model; see models.ts), and streams
// what happens back as KikiEvents. Tools the app runs (reads, checks, scrolls, clicks) are `tool_call` events
// whose results come back through `toolResults`.
import {
  isCustomModel,
  MODEL_PROVIDERS,
  type AppToolName,
  type FollowUpRequest,
  type KikiEvent,
  type QuestionOptions,
  type StartConversationRequest,
  type ToolAccess,
  type ToolResult,
} from "@kiki/shared";
import { z } from "zod";
import { PlanError } from "./accounts.ts";
import { DEFAULT_CLAUDE_CONFIG, type ClaudeConfig, type Effort } from "./claude.ts";
import { ClaudeCodeProcess, releaseClaudeCodeSession } from "./claudeCode.ts";
import type { CodexAppServer } from "./codex.ts";
import { ConversationStore, type Conversation } from "./conversations.ts";
import { classifyError, defaultClients, MODEL_IDS, routeProvider, runTurnFor, type Clients, type Route } from "./models.ts";
import { buildConversationStart, buildFollowUpMessage, withoutScreenshots } from "./prompt.ts";
import { followUpSchema, startSchema, toolResultsSchema, warmSchema } from "./requests.ts";
import { whenAborted } from "./turn.ts";

export type OnEvent = (event: KikiEvent) => void;

export interface EngineDeps {
  /** Stand-ins for the model clients (tests, the mock). */
  clients?: Partial<Clients>;
  conversations?: ConversationStore;
  config?: ClaudeConfig;
  /** How long a turn waits for the app to run one of its tools. */
  toolTimeoutMs?: number;
  log?: (line: string) => void;
}

/** What the next question would be asked with, for `Engine.warm`. */
export interface WarmRequest {
  /** The conversation it follows up, when it isn't a first question. */
  conversationId?: string;
  options?: QuestionOptions;
  tools?: ToolAccess;
  /** For a first question; a follow-up keeps its conversation's. */
  personality?: string;
}

export interface Engine {
  /** Starts a conversation with its first question, and streams the answer to `onEvent` until it's done. */
  start(request: StartConversationRequest, route: Route, onEvent: OnEvent, signal?: AbortSignal): Promise<void>;
  /** Asks a follow-up in a conversation; an `expired` error when it's gone (restart it with `earlier`). */
  followUp(conversationId: string, request: FollowUpRequest, route: Route, onEvent: OnEvent, signal?: AbortSignal): Promise<void>;
  /** Hands the results of the app's tools to the turn waiting for them; how many it was waiting for. */
  toolResults(conversationId: string, results: ToolResult[]): number;
  /** Starts the person's Codex now rather than with the first GPT question, so that question doesn't wait. */
  startCodex(): void;
  /**
   * Starts a Claude Code process for the question `request` describes, so that question doesn't wait for one;
   * a question that needs anything else starts its own. One at most: it replaces the last, and on any other
   * route it only lets the last go. Resolves once the process is ready, or couldn't start.
   */
  warm(route: Route, request: WarmRequest): Promise<void>;
  /** Lets go of the process `warm` started, when no question is coming for it (the popup closed). */
  discardSpare(): void;
  /** Lets go of every conversation and stops Codex (Kiki is quitting). */
  close(): void;
}

/** `text` without the person's API key, or anything that looks like one, for the log. */
function redact(text: string, route: Route): string {
  const key = route.kind === "key" ? route.apiKey : route.kind === "compatible" ? route.apiKey : undefined;
  const scrubbed = key ? text.replaceAll(key, "[key]") : text;
  return scrubbed.replace(/\b(sk-[\w*-]{8,}|AIza[\w-]{20,})/g, "[key]");
}

/** How the log names a route. */
function routeLabel(route: Route): string {
  if (route.kind === "key") return `${route.provider} key`;
  if (route.kind === "compatible") return route.name;
  return route.kind;
}

/** The model that answers on `route`: the composer's pick, or Claude Opus when it picked none. */
function modelFor(route: Route, options: QuestionOptions | undefined, config: ClaudeConfig): string | null {
  const choice = options?.model;
  if (route.kind === "compatible") return choice === undefined || isCustomModel(choice) ? route.model : null;
  if (isCustomModel(choice)) return null;
  const provider = choice ? MODEL_PROVIDERS[choice] : "anthropic";
  if (provider !== routeProvider(route)) return null;
  return choice ? MODEL_IDS[choice] : config.model;
}

function invalid(error: z.ZodError): KikiEvent {
  return { type: "error", code: "invalid", message: `Invalid request: ${z.prettifyError(error)}` };
}

export function createEngine(deps: EngineDeps = {}): Engine {
  const config = deps.config ?? DEFAULT_CLAUDE_CONFIG;
  const toolTimeoutMs = deps.toolTimeoutMs ?? 30_000;
  const log = deps.log ?? ((line: string) => console.log(line));
  const base: Clients = { ...defaultClients(), ...deps.clients };
  // Codex starts on its first question, or when the app asks; `close` stops it if it did.
  let codex: CodexAppServer | undefined;
  const clients: Clients = { ...base, codex: () => (codex ??= base.codex()) };
  /** The Claude Code process started ahead of the next question (`warm`): one at most, ~250 MB while it waits. */
  let spare: { process: ClaudeCodeProcess; conversationId?: string } | undefined;
  /** Counts each time the spare is taken or let go, so a start that lands after that closes itself. */
  let generation = 0;
  const conversations =
    deps.conversations ??
    new ConversationStore({
      // A gone conversation's agent session isn't needed anymore, nor a process started to continue it.
      onRemove: ({ id, agent }) => {
        if (spare?.conversationId === id) discardSpare();
        if (agent?.provider === "anthropic") releaseClaudeCodeSession(agent.id);
        else if (agent?.provider === "openai") codex?.release(agent.id);
      },
    });
  const sweeper = setInterval(() => conversations.sweep(), 5 * 60 * 1000);
  sweeper.unref?.();

  function discardSpare(): void {
    generation++;
    spare?.process.close();
    spare = undefined;
  }

  /** The process started ahead for the turn that needs `fingerprint`, if that's the one waiting; else the turn starts its own. */
  function takeSpare(fingerprint: string): ClaudeCodeProcess | undefined {
    const parked = spare;
    // A start still on its way was for a question this turn may move past (its session): it closes when it lands.
    generation++;
    spare = undefined;
    if (parked?.process.fingerprint === fingerprint) {
      log("[kiki] claude code: warm start");
      return parked.process;
    }
    parked?.process.close();
    log(`[kiki] claude code: cold start${parked ? " (the spare was for another question)" : ""}`);
    return undefined;
  }

  /** How hard the model thinks for a question: its effort level, or the older Think toggle. */
  function effortFor(options: QuestionOptions | undefined): Effort {
    return options?.effort ?? (options?.think ? config.thinkEffort : config.effort);
  }

  /**
   * Runs one turn for `conversation`, whose history already ends with the new user message, and streams it
   * to `onEvent`. Fails without changing the history.
   */
  async function runConversationTurn(
    conversation: Conversation,
    isFirstTurn: boolean,
    options: QuestionOptions | undefined,
    tools: ToolAccess | undefined,
    route: Route,
    model: string,
    onEvent: OnEvent,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    // The agent's session continues the conversation when it holds everything but the new question.
    const agent = conversation.agent?.covers === conversation.messages.length - 1 ? conversation.agent : undefined;
    const effort = effortFor(options);
    conversation.busy = true;
    conversation.userTurns += 1;
    const startedAt = Date.now();

    // Undo the user message so the history stays valid (and append-only) for the next turn.
    const rollback = () => {
      conversation.messages.pop();
      conversation.userTurns -= 1;
      // The agent may have kept the question that failed: the next one starts a new session.
      conversation.agent = undefined;
      if (isFirstTurn) conversations.delete(conversation.id);
    };

    const controller = new AbortController();
    const stopAbort = whenAborted(signal, () => controller.abort());

    // Waits for the app to hand back this tool's result, or gives the model an error after a while.
    const callTool = (id: string, _name: AppToolName, _input: Record<string, unknown>) =>
      new Promise<ToolResult>((resolve) => {
        let stopCancel = () => {};
        const finish = (result: ToolResult) => {
          clearTimeout(timer);
          stopCancel();
          conversation.pendingTools.delete(id);
          resolve(result);
        };
        const timer = setTimeout(() => finish({ id, content: "The Kiki app didn't answer in time.", isError: true }), toolTimeoutMs);
        conversation.pendingTools.set(id, finish);
        stopCancel = whenAborted(controller.signal, () => finish({ id, content: "Cancelled.", isError: true }));
      });

    const send: OnEvent = (event) => {
      try {
        onEvent(event);
      } catch (error) {
        console.error("[kiki] the popup couldn't take an event", error);
      }
    };

    send({ type: "conversation", id: conversation.id });
    try {
      const result = await runTurnFor(
        route,
        clients,
        {
          config,
          history: conversation.messages,
          emit: send,
          signal: controller.signal,
          model,
          effort,
          tools,
          personality: conversation.personality,
          callTool,
          conversationId: conversation.id,
          ...(agent ? { agent } : {}),
        },
        takeSpare,
      );
      const u = result.usage;
      const stats = `${model} via ${routeLabel(route)} effort=${effort} in=${u.inputTokens} cache_read=${u.cacheReadTokens} out=${u.outputTokens} searches=${u.webSearches} ${Date.now() - startedAt}ms`;
      if (result.kind === "refused") {
        rollback();
        log(`[kiki] refused ${stats}`);
        send({ type: "error", code: "refused", message: "Kiki can't help with this one." });
      } else {
        // Screenshots from scrolling stay with the turn that took them; follow-ups don't send them again.
        conversation.messages.push(...withoutScreenshots(result.messages));
        conversation.agent = result.agent ? { ...result.agent, covers: conversation.messages.length } : undefined;
        log(`[kiki] ${result.stopReason} ${stats}`);
        if (result.sources.length > 0) send({ type: "sources", items: result.sources });
        send({ type: "done", stopReason: result.stopReason });
      }
    } catch (error) {
      const info = classifyError(route, error, controller.signal.aborted);
      rollback();
      if (info.log && error instanceof PlanError) {
        console.error(`[kiki] ${routeLabel(route)} failed: ${error.message}${error.detail ? ` (${error.detail})` : ""}`);
      } else if (info.log) {
        // Only the message: the error object can carry the request, and the request carries the key.
        const message = redact(error instanceof Error ? error.message : String(error), route);
        console.error(`[kiki] ${model} via ${routeLabel(route)} failed: ${message}`);
      }
      if (!info.aborted) send({ type: "error", code: info.code, message: info.message });
    } finally {
      stopAbort();
      conversation.busy = false;
      conversation.lastUsed = conversations.now();
    }
  }

  /** The question's options as the route takes them: models the person added can't search the web. */
  function optionsFor(route: Route, options: QuestionOptions | undefined): QuestionOptions | undefined {
    return route.kind === "compatible" && options?.search ? { ...options, search: false } : options;
  }

  return {
    async start(body, route, onEvent, signal) {
      const parsed = startSchema.safeParse(body);
      if (!parsed.success) return onEvent(invalid(parsed.error));
      const options = optionsFor(route, parsed.data.options);
      const request: StartConversationRequest = { ...parsed.data, ...(options ? { options } : {}) };
      const model = modelFor(route, options, config);
      if (!model) return onEvent({ type: "error", code: "invalid", message: "That model can't answer this way. Pick it again in the model menu." });

      const conversation = conversations.create();
      if (request.personality) conversation.personality = request.personality;
      const today = new Date(conversations.now()).toISOString().slice(0, 10);
      conversation.messages.push(...buildConversationStart(request, today));
      // Earlier turns it carries over count toward the conversation's length.
      conversation.userTurns += request.earlier?.length ?? 0;
      await runConversationTurn(conversation, true, options, request.tools, route, model, onEvent, signal);
    },

    async followUp(conversationId, body, route, onEvent, signal) {
      const parsed = followUpSchema.safeParse(body);
      if (!parsed.success) return onEvent(invalid(parsed.error));
      const conversation = conversations.get(conversationId);
      if (!conversation) {
        return onEvent({ type: "error", code: "expired", message: "This conversation has expired. Ask again to start a new one." });
      }
      if (conversation.busy) return onEvent({ type: "error", code: "busy", message: "Kiki is still answering the previous question." });
      if (conversation.userTurns >= conversations.maxUserTurns) {
        return onEvent({
          type: "error",
          code: "limit",
          message: "This conversation is getting long. Close Kiki and highlight the text again to start fresh.",
        });
      }
      const options = optionsFor(route, parsed.data.options);
      const request: FollowUpRequest = { ...parsed.data, ...(options ? { options } : {}) };
      const model = modelFor(route, options, config);
      if (!model) return onEvent({ type: "error", code: "invalid", message: "That model can't answer this way. Pick it again in the model menu." });

      conversation.messages.push(buildFollowUpMessage(request));
      await runConversationTurn(conversation, false, options, request.tools, route, model, onEvent, signal);
    },

    toolResults(conversationId, results) {
      const parsed = toolResultsSchema.safeParse(results);
      const conversation = conversations.get(conversationId);
      if (!parsed.success || !conversation) return 0;
      const waiting = parsed.data.filter((result) => conversation.pendingTools.has(result.id));
      for (const result of waiting) conversation.pendingTools.get(result.id)?.(result);
      return waiting.length;
    },

    startCodex() {
      // Not installed or not signed in: the first GPT question says so.
      clients.codex().start().catch(() => {});
    },

    async warm(route, request) {
      const parsed = warmSchema.safeParse(request);
      // Only Claude Code starts a process per question; one waiting is no use to any other route.
      if (route.kind !== "claude-code" || !parsed.success) return discardSpare();
      const { conversationId, options, tools, personality } = parsed.data;
      const model = modelFor(route, options, config);
      if (!model) return discardSpare();
      const conversation = conversationId ? conversations.get(conversationId) : undefined;
      // Its session continues the conversation when it holds all of it (as in runConversationTurn, before the question).
      const agent = conversation && conversation.agent?.covers === conversation.messages.length ? conversation.agent : undefined;
      const claude = new ClaudeCodeProcess({
        config,
        model,
        effort: effortFor(options),
        tools,
        personality: conversation ? conversation.personality : personality,
        agent,
        executable: route.executable,
      });
      // The one waiting is for this very question.
      if (spare?.process.fingerprint === claude.fingerprint) return;
      discardSpare();
      const ticket = generation;
      try {
        await claude.warm(clients.claudeCodeStartup);
      } catch (error) {
        // The question says what's wrong when it starts its own.
        log(`[kiki] claude code: couldn't start ahead: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      // Taken or let go while it started (a question came, or the popup closed): nothing waits for it.
      if (ticket !== generation) return claude.close();
      spare = { process: claude, conversationId: conversation?.id };
    },

    discardSpare,

    close() {
      clearInterval(sweeper);
      conversations.clear();
      codex?.close();
      discardSpare();
    },
  };
}
