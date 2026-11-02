// The models behind the composer's picker, how each question reaches one (its route), and running a turn
// with it.
import Anthropic from "@anthropic-ai/sdk";
import type { ModelChoice, Provider } from "@kiki/shared";
import { PlanError } from "./accounts.ts";
import { classifyAnthropicError, runTurn, type ClassifiedError } from "./claude.ts";
import { claudeCodeQuery, claudeCodeStartup, runClaudeCodeTurn, type ClaudeCodeQuery, type ClaudeCodeStartup, type TakeSpare } from "./claudeCode.ts";
import { CodexAppServer, runCodexTurn } from "./codex.ts";
import { compatibleClient, EmptyAnswerError, runCompatibleTurn, type CompatibleClient, type CompatibleEndpoint } from "./compatible.ts";
import { geminiClient, runGeminiTurn, type GeminiClient } from "./gemini.ts";
import { openaiClient, runOpenAITurn, type OpenAIClient } from "./openai.ts";
import type { TurnOptions, TurnResult } from "./turn.ts";

/** The model behind each built-in choice in the composer's model picker (its provider is `MODEL_PROVIDERS`). */
export const MODEL_IDS: Record<ModelChoice, string> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
  "flash-lite": "gemini-3.5-flash-lite",
  flash: "gemini-3.8-flash",
  argon: "gemini-4-argon",
  luna: "gpt-6-luna",
  sol: "gpt-6.1-sol",
  astra: "gpt-6-astra",
};

/** What each provider is called in messages to the person, and the key they add in Settings. */
export const PROVIDER_NAMES: Record<Provider, { model: string; company: string; key: string }> = {
  anthropic: { model: "Claude", company: "Anthropic", key: "Anthropic API key" },
  google: { model: "Gemini", company: "Google", key: "Gemini API key" },
  openai: { model: "GPT", company: "OpenAI", key: "OpenAI API key" },
};

/**
 * How a question reaches its model, all from the person's computer: their own Claude Code or Codex (signed
 * in with their plan), their own API key, or an OpenAI-compatible service or local server they added.
 */
export type Route =
  /** Claude, on the Claude Code installed at `executable`. */
  | { kind: "claude-code"; executable: string }
  /** GPT, on the person's Codex. */
  | { kind: "codex" }
  /** A built-in model on the person's API key for its provider. */
  | { kind: "key"; provider: Provider; apiKey: string }
  /** A model the person added: `name` is the service's ("Ollama", "OpenRouter") for messages. */
  | { kind: "compatible"; name: string; baseUrl: string; model: string; apiKey?: string };

/** The provider whose model a route runs, or null for the person's own services. */
export function routeProvider(route: Route): Provider | null {
  if (route.kind === "claude-code") return "anthropic";
  if (route.kind === "codex") return "openai";
  if (route.kind === "key") return route.provider;
  return null;
}

/** Makes what talks to each model. Tests and the mock stand in for them. */
export interface Clients {
  anthropic: (apiKey: string) => Anthropic;
  google: (apiKey: string) => GeminiClient;
  openai: (apiKey: string) => OpenAIClient;
  compatible: (endpoint: CompatibleEndpoint) => CompatibleClient;
  /** Starts a Claude Code query (the Agent SDK's `query`). */
  claudeCode: ClaudeCodeQuery;
  /** Starts a Claude Code process ahead of its question (the Agent SDK's `startup`). */
  claudeCodeStartup: ClaudeCodeStartup;
  /** Makes the Codex app server; the engine keeps the one it makes. */
  codex: () => CodexAppServer;
}

export function defaultClients(): Clients {
  return {
    anthropic: (apiKey) => new Anthropic({ apiKey }),
    google: geminiClient,
    openai: openaiClient,
    compatible: compatibleClient,
    claudeCode: claudeCodeQuery,
    claudeCodeStartup: claudeCodeStartup,
    codex: () => new CodexAppServer(),
  };
}

/**
 * Runs a turn on `route` with `options.model` (the provider's model id, or the custom model's name). Throws like
 * its client. `takeSpare` hands a Claude Code turn the process started ahead for it, if there is one (`Engine.warm`).
 */
export function runTurnFor(route: Route, clients: Clients, options: TurnOptions, takeSpare?: TakeSpare): Promise<TurnResult> {
  switch (route.kind) {
    case "claude-code":
      return runClaudeCodeTurn({ ...options, query: clients.claudeCode, executable: route.executable, ...(takeSpare ? { takeSpare } : {}) });
    case "codex":
      return runCodexTurn({ ...options, codex: clients.codex() });
    case "compatible":
      return runCompatibleTurn({ ...options, client: clients.compatible(route) });
    case "key":
      if (route.provider === "anthropic") return runTurn({ ...options, client: clients.anthropic(route.apiKey) });
      if (route.provider === "google") return runGeminiTurn({ ...options, client: clients.google(route.apiKey) });
      return runOpenAITurn({ ...options, client: clients.openai(route.apiKey) });
  }
}

/** The HTTP status of an API error from the Gemini or OpenAI client, if it has one. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  const value = typeof status === "number" ? status : statusCode;
  return typeof value === "number" ? value : undefined;
}

function isLocal(baseUrl: string): boolean {
  try {
    return /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** A failed question to a model the person added, in words for them. */
function classifyCompatibleError(route: Extract<Route, { kind: "compatible" }>, error: unknown): ClassifiedError {
  const base = { aborted: false, log: false };
  const { name, model } = route;
  if (error instanceof EmptyAnswerError) return { ...base, code: "upstream", message: `${model} didn't write an answer. Try again.` };
  const status = statusOf(error);
  const message = error instanceof Error ? error.message : "";
  if (status === undefined) {
    // No answer at all: the server isn't running, or the address is wrong.
    if (isLocal(route.baseUrl)) {
      return { ...base, code: "upstream", message: `Kiki couldn't reach ${name} at ${hostOf(route.baseUrl)}. Is it running?` };
    }
    return { ...base, code: "upstream", message: `Kiki couldn't reach ${name}. Check your connection and its address in Settings.`, log: true };
  }
  if (status === 401 || status === 403) {
    return { ...base, code: "unauthorized", message: `${name} didn't accept your API key. Check it in Kiki's Settings › Models.` };
  }
  if (status === 402) return { ...base, code: "limit", message: `Your ${name} account is out of credits.` };
  if (status === 429) return { ...base, code: "busy", message: `${name} says you've hit its rate limit. Try again in a moment.` };
  if (status === 404 && /model/i.test(message)) {
    const pull = /ollama/i.test(name) || route.baseUrl.includes(":11434") ? ` Get it with \`ollama pull ${model}\`.` : "";
    return { ...base, code: "upstream", message: `${name} doesn't have the model ${model}.${pull}` };
  }
  if (status === 400 && /image|vision|multimodal/i.test(message)) {
    return { ...base, code: "invalid", message: `${model} can't read images. Leave them out, or pick another model.` };
  }
  if (status === 400 && /context|too long|maximum.*tokens/i.test(message)) {
    return { ...base, code: "limit", message: `This conversation is too long for ${model}. Close Kiki and highlight the text again to start fresh.` };
  }
  if (status >= 500) return { ...base, code: "upstream", message: `${name} is having trouble right now. Try again shortly.`, log: true };
  return { ...base, code: "upstream", message: `${name} couldn't answer with ${model}.`, log: true };
}

/**
 * Turns a failed turn into what the person sees. `aborted` says the request was cancelled (the popup closed).
 * Everything runs on the person's own accounts and keys, so a rejected key or a used-up limit is theirs to fix.
 */
export function classifyError(route: Route, error: unknown, aborted = false): ClassifiedError {
  const base = { aborted: false, log: false };
  if (aborted) return { ...base, code: "internal", message: "Request cancelled.", aborted: true };
  // Claude Code's and Codex's failures, already in words for the person.
  if (error instanceof PlanError) return { ...base, code: error.code, message: error.message, log: error.log };
  if (route.kind === "compatible") return classifyCompatibleError(route, error);
  const provider = routeProvider(route)!;
  if (provider === "anthropic") return classifyAnthropicError(error);
  const { model, company, key } = PROVIDER_NAMES[provider];
  const status = statusOf(error);
  if (status === 401 || status === 403) {
    return { ...base, code: "unauthorized", message: `${company} didn't accept your ${key}. Check it in Kiki's Settings › Models.` };
  }
  if (status === 429) {
    return { ...base, code: "busy", message: `Your ${key} hit its rate limit or quota with ${company}. Try again later.` };
  }
  if (status === 400 || status === 404 || status === 422) {
    return { ...base, code: "upstream", message: `${model} could not process this request.`, log: true };
  }
  if (status !== undefined && status >= 500) {
    return { ...base, code: "upstream", message: `${model} is temporarily unavailable. Try again shortly.` };
  }
  if (status !== undefined) {
    return { ...base, code: "upstream", message: `${model} returned an error. Try again.`, log: true };
  }
  return { ...base, code: "upstream", message: `Kiki could not get an answer from ${model}. Try again.`, log: true };
}

