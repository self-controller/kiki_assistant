// Kiki's engine, running in the main process: each question goes from here straight to the model the person
// picked, on their own Claude Code, Codex, API key or local model (see routes.ts). With KIKI_MOCK=1, every
// model answers from the engine's mock instead, for working on the app without accounts or keys.
import {
  claudeCodeStatus,
  codexStatus,
  createEngine,
  findExecutable,
  type AgentStatus,
  type Engine,
  type OnEvent,
  type Route,
  type WarmRequest,
} from "@kiki/engine";
import {
  LIMITS,
  PROVIDERS,
  type FollowUpRequest,
  type ModelPick,
  type Provider,
  type StartConversationRequest,
  type ToolResult,
} from "@kiki/shared";
import { serviceName, SERVICES } from "../services.ts";
import { AGENT_PROVIDERS, type AgentProvider, type CustomModelInfo, type ProviderStatus } from "../shared-types.ts";
import { accountFor, providerStatuses, routeFor, type RouteSetup } from "./routes.ts";
import { customModelViews, getCustomModel, getProviderKey, getSettings, saveSettings } from "./settings.ts";

const mock = process.env.KIKI_MOCK === "1";

let engine: Promise<Engine> | null = null;

function getEngine(): Promise<Engine> {
  engine ??= (async () => {
    if (!mock) return createEngine();
    const { mockClients } = await import("@kiki/engine/mock");
    console.info("[kiki] KIKI_MOCK=1: every model answers from the mock");
    return createEngine({ clients: mockClients() });
  })();
  return engine;
}

/** Lets go of every conversation and stops Codex; Kiki is quitting. */
export function closeEngine(): void {
  void engine?.then((running) => running.close());
}

// ---------- The person's Claude Code and Codex ----------

let agents: Record<AgentProvider, AgentStatus | null> = { anthropic: null, openai: null };
let checking: Promise<Record<AgentProvider, AgentStatus>> | null = null;

/** Their Claude Code and Codex as Kiki last found them (null before the first look). */
export function agentStatuses(): Record<AgentProvider, AgentStatus | null> {
  return agents;
}

/**
 * Looks for their Claude Code and Codex again, and how they're signed in. The first time Kiki can tell
 * which a provider should use (Claude Code or Codex when it's there, else a key they saved), it saves that
 * choice, so questions never switch between the two on their own.
 */
export function checkAgents(): Promise<Record<AgentProvider, AgentStatus>> {
  checking ??= (async () => {
    const [anthropic, openai] = await Promise.all([claudeCodeStatus(), codexStatus()]);
    agents = { anthropic, openai };
    const unset = AGENT_PROVIDERS.filter((provider) => !getSettings().accounts[provider]);
    const resolved = Object.fromEntries(
      unset.flatMap((provider) =>
        agents[provider]?.path ? [[provider, "agent"]] : getProviderKey(provider) ? [[provider, "key"]] : [],
      ),
    );
    if (Object.keys(resolved).length > 0) saveSettings({ accounts: resolved });
    // GPT runs on Codex: start its app server now, so the first GPT question doesn't wait for it.
    if (!mock && openai.signedIn && accountFor("openai", setup()) === "agent") {
      void getEngine().then((running) => running.startCodex());
    }
    return { anthropic, openai };
  })().finally(() => {
    checking = null;
  });
  return checking;
}

// ---------- Routes ----------

function setup(): RouteSetup {
  return {
    accounts: getSettings().accounts,
    key: getProviderKey,
    agents,
    findAgent: (provider) => findExecutable(provider === "anthropic" ? "claude" : "codex"),
    customModel: getCustomModel,
  };
}

/** The route for `model`, or what the person needs to set up first. */
function resolve(model: ModelPick | undefined): { route: Route } | { error: string } {
  if (!mock) return routeFor(model, setup());
  // The mock answers on any route; the custom ones keep their names.
  const found = routeFor(model, { ...setup(), accounts: { anthropic: "key", openai: "key" }, key: () => "mock" });
  return "route" in found ? found : { route: { kind: "key", provider: "anthropic", apiKey: "mock" } };
}

/** How each provider's questions run, as Settings would show it. */
export function accountChoices(): Record<AgentProvider, "agent" | "key"> {
  const current = setup();
  return { anthropic: accountFor("anthropic", current), openai: accountFor("openai", current) };
}

/** What the popup's model menu offers: each provider's models when they're set up, and the person's own. */
export function modelMenu(): { providers: Record<Provider, ProviderStatus>; customModels: CustomModelInfo[] } {
  const providers = mock
    ? (Object.fromEntries(PROVIDERS.map((provider) => [provider, "ready"])) as Record<Provider, ProviderStatus>)
    : providerStatuses(setup());
  const customModels = customModelViews().map(({ id, name, service, baseUrl }) => ({
    choice: `custom:${id}` as const,
    name,
    service: serviceName(service, baseUrl),
    local: SERVICES[service].local,
  }));
  return { providers, customModels };
}

/** Whether any model can answer yet; before that, the hotkey opens Settings. */
export function anyModelReady(): boolean {
  const { providers, customModels } = modelMenu();
  return customModels.length > 0 || Object.values(providers).includes("ready");
}

// ---------- Questions ----------

/**
 * Asks the engine: a new conversation with `conversationId` null, else a follow-up in it. Streams its events
 * to `onEvent`, and never throws.
 */
export async function ask(
  conversationId: string | null,
  request: StartConversationRequest | FollowUpRequest,
  onEvent: OnEvent,
  signal: AbortSignal,
): Promise<void> {
  const found = resolve(request.options?.model);
  if ("error" in found) return onEvent({ type: "error", code: "unauthorized", message: found.error });
  const { route } = found;
  const listen: OnEvent = (event) => {
    // Signed out of Claude Code or Codex since Kiki last looked: look again, for the menu and Settings.
    if (event.type === "error" && event.code === "unauthorized" && (route.kind === "claude-code" || route.kind === "codex")) {
      void checkAgents().catch(() => {});
    }
    onEvent(event);
  };
  try {
    const running = await getEngine();
    if (conversationId) await running.followUp(conversationId, request as FollowUpRequest, route, listen, signal);
    else await running.start(request as StartConversationRequest, route, listen, signal);
  } catch (error) {
    console.error("[kiki] the engine failed:", error);
    if (!signal.aborted) onEvent({ type: "error", code: "internal", message: "Something went wrong in Kiki. Try again." });
  }
}

/**
 * Starts a Claude Code process for the question `request` describes, when that's how it would run, so it
 * doesn't wait for one (`Engine.warm`).
 */
export function warm(request: WarmRequest): void {
  const found = resolve(request.options?.model);
  if ("error" in found) return;
  void getEngine().then((running) => running.warm(found.route, request));
}

/** Lets go of the process `warm` started: the popup closed without asking. */
export function discardSpare(): void {
  void engine?.then((running) => running.discardSpare());
}

/** Answers a turn's `tool_call`. The turn carries on (or times out) either way. */
export function sendToolResults(conversationId: string, results: ToolResult[]): void {
  void getEngine().then((running) =>
    running.toolResults(
      conversationId,
      results.map((result) => ({
        ...result,
        content: result.content.slice(0, LIMITS.toolResultChars),
        ...(result.screen?.text ? { screen: { ...result.screen, text: result.screen.text.slice(0, LIMITS.screenTextChars) } } : {}),
      })),
    ),
  );
}
