// Checks the person's own API keys with their provider before Settings saves them, and lists the models a
// service they add offers. Every check goes straight from this computer to the provider: it lists the models
// the key can use.
import type { Provider } from "@kiki/shared";
import type { ModelListResult } from "../shared-types.ts";

/** What Settings calls each provider and its key. */
export const KEY_NAMES: Record<Provider, { company: string; key: string }> = {
  anthropic: { company: "Anthropic", key: "Anthropic API key" },
  google: { company: "Google", key: "Gemini API key" },
  openai: { company: "OpenAI", key: "OpenAI API key" },
};

function modelsRequest(provider: Provider, key: string): { url: string; headers: Record<string, string> } {
  if (provider === "anthropic") {
    return { url: "https://api.anthropic.com/v1/models?limit=1", headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } };
  }
  return provider === "google"
    ? { url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", headers: { "x-goog-api-key": key } }
    : { url: "https://api.openai.com/v1/models", headers: { authorization: `Bearer ${key}` } };
}

/**
 * "valid" when the provider accepts the key, "rejected" when it says the key is wrong, or "unchecked" (with
 * why) when it couldn't say: offline, rate-limited, or down. Only a rejected key isn't saved.
 */
export async function checkProviderKey(
  provider: Provider,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ result: "valid" | "rejected" } | { result: "unchecked"; reason: string }> {
  const { url, headers } = modelsRequest(provider, key);
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (response.ok) return { result: "valid" };
    // Google answers a wrong key with 400 (API_KEY_INVALID); Anthropic and OpenAI with 401.
    if ([400, 401, 403].includes(response.status)) return { result: "rejected" };
    return { result: "unchecked", reason: `${KEY_NAMES[provider].company} answered HTTP ${response.status}` };
  } catch {
    return { result: "unchecked", reason: `Kiki couldn't reach ${KEY_NAMES[provider].company}` };
  }
}

/**
 * The models an OpenAI-compatible service offers (`GET {baseUrl}/models`), which also checks the key.
 * `name` is the service's, for messages; `local` says it runs on this computer.
 */
export async function listCompatibleModels(
  service: { name: string; baseUrl: string; local: boolean },
  key: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelListResult> {
  const { name, baseUrl, local } = service;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return {
      ok: false,
      message: local ? `Kiki couldn't reach ${name} at ${new URL(baseUrl).host}. Is it running?` : `Kiki couldn't reach ${name}. Check the address.`,
    };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, message: key ? `${name} didn't accept that API key.` : `${name} needs an API key.` };
  }
  if (!response.ok) return { ok: false, message: `${name} answered HTTP ${response.status}. Check the address.` };
  try {
    const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const models = (body.data ?? []).flatMap((model) => (typeof model.id === "string" ? [model.id] : []));
    return { ok: true, models: [...new Set(models)].sort((a, b) => a.localeCompare(b)) };
  } catch {
    return { ok: false, message: `That address didn't answer like an OpenAI-compatible API.` };
  }
}
