// How each question reaches its model, from what the person set up in Settings › Models: Claude on their
// Claude Code or Anthropic key, GPT on their Codex or OpenAI key, Gemini on their key, and the models they
// added on their services. No Electron here, so tests can run it.
import type { Route } from "@kiki/engine";
import { isCustomModel, MODEL_PROVIDERS, PROVIDERS, type ModelPick, type Provider } from "@kiki/shared";
import { serviceName, type ServiceId } from "../services.ts";
import type { AccountChoice, AgentProvider, AgentStatus, ProviderStatus } from "../shared-types.ts";
import { KEY_NAMES } from "./providerKeys.ts";

/** What Settings has, as routing needs it. */
export interface RouteSetup {
  accounts: Partial<Record<AgentProvider, AccountChoice>>;
  /** The person's API key for a provider, if they saved one. */
  key(provider: Provider): string | null;
  /** Their Claude Code and Codex as Kiki last found them; null before the first look. */
  agents: Record<AgentProvider, AgentStatus | null>;
  /** Where their Claude Code or Codex is, for before the first look. */
  findAgent(provider: AgentProvider): string | null;
  customModel(id: string): { service: ServiceId; baseUrl: string; model: string; key: string | null } | null;
}

/** What the person calls each agent, the command that signs it in, and the key it can be swapped for. */
export const AGENTS: Record<AgentProvider, { name: string; family: string; signIn: string; key: string }> = {
  anthropic: { name: "Claude Code", family: "Claude", signIn: "Run `claude` in a terminal and log in", key: "an Anthropic API key" },
  openai: { name: "Codex", family: "GPT", signIn: "Run `codex login` in a terminal", key: "an OpenAI API key" },
};


function isAgentProvider(provider: Provider): provider is AgentProvider {
  return provider === "anthropic" || provider === "openai";
}

/** Where the person's Claude Code or Codex is, as far as Kiki knows. */
function agentPath(provider: AgentProvider, setup: RouteSetup): string | null {
  const status = setup.agents[provider];
  return status ? status.path : setup.findAgent(provider);
}

/**
 * How `provider`'s questions run: only ever one of the two. As the person chose, or else on their Claude Code
 * or Codex when Kiki finds it, then on their key (Kiki saves that choice once it can tell; see `checkAgents`).
 * A key they saved stays unused while Claude Code or Codex is picked.
 */
export function accountFor(provider: AgentProvider, setup: RouteSetup): AccountChoice {
  const chosen = setup.accounts[provider];
  if (chosen) return chosen;
  if (agentPath(provider, setup)) return "agent";
  return setup.key(provider) ? "key" : "agent";
}

/** The route for a model the composer picked (Claude Opus when none), or what to set up for it. */
export function routeFor(choice: ModelPick | undefined, setup: RouteSetup): { route: Route } | { error: string } {
  if (isCustomModel(choice)) {
    const added = setup.customModel(choice.slice("custom:".length));
    if (!added) return { error: "That model isn't in Settings anymore. Pick another one." };
    const { service, baseUrl, model, key } = added;
    return { route: { kind: "compatible", name: serviceName(service, baseUrl), baseUrl, model, ...(key ? { apiKey: key } : {}) } };
  }
  const provider = choice ? MODEL_PROVIDERS[choice] : "anthropic";
  if (isAgentProvider(provider) && accountFor(provider, setup) === "agent") {
    const { name, signIn, key } = AGENTS[provider];
    const path = agentPath(provider, setup);
    if (!path) return { error: `Kiki can't find ${name} on this computer. Install it and sign in, or use ${key} (Settings › Models).` };
    if (setup.agents[provider]?.signedIn === false) return { error: `${name} isn't signed in. ${signIn}, then try again.` };
    return { route: provider === "anthropic" ? { kind: "claude-code", executable: path } : { kind: "codex" } };
  }
  const apiKey = setup.key(provider);
  if (!apiKey) {
    const family = isAgentProvider(provider) ? AGENTS[provider].family : "Gemini";
    return { error: `To ask ${family}, add your ${KEY_NAMES[provider].key} in Settings › Models.` };
  }
  return { route: { kind: "key", provider, apiKey } };
}

/** The first model of each provider, to tell whether its models can be asked. */
const FIRST_MODEL: Record<Provider, ModelPick> = { anthropic: "haiku", google: "flash-lite", openai: "luna" };

/** Whether each provider's models are set up to answer. */
export function providerStatuses(setup: RouteSetup): Record<Provider, ProviderStatus> {
  const statuses = {} as Record<Provider, ProviderStatus>;
  for (const provider of PROVIDERS) statuses[provider] = "route" in routeFor(FIRST_MODEL[provider], setup) ? "ready" : "needsSetup";
  return statuses;
}
