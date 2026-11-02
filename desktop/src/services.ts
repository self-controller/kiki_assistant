// The services Settings › Models can add models from: hosted ones, on the person's own key, and servers on
// their own computer. All of them speak the OpenAI-compatible Chat Completions API, so one kind of route
// (`compatible` in the engine) asks any of them.

export interface ServicePreset {
  name: string;
  /** Where its OpenAI-compatible API lives; empty for "Other", where the person types it. */
  baseUrl: string;
  /** Runs on the person's computer and takes no key. */
  local: boolean;
  /** Where to get a key. */
  keyUrl?: string;
}

export const SERVICES = {
  ollama: { name: "Ollama", baseUrl: "http://localhost:11434/v1", local: true },
  lmstudio: { name: "LM Studio", baseUrl: "http://localhost:1234/v1", local: true },
  openrouter: { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", local: false, keyUrl: "https://openrouter.ai/settings/keys" },
  groq: { name: "Groq", baseUrl: "https://api.groq.com/openai/v1", local: false, keyUrl: "https://console.groq.com/keys" },
  deepseek: { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", local: false, keyUrl: "https://platform.deepseek.com/api_keys" },
  xai: { name: "xAI", baseUrl: "https://api.x.ai/v1", local: false, keyUrl: "https://console.x.ai" },
  mistral: { name: "Mistral", baseUrl: "https://api.mistral.ai/v1", local: false, keyUrl: "https://console.mistral.ai/api-keys" },
  together: { name: "Together", baseUrl: "https://api.together.xyz/v1", local: false, keyUrl: "https://api.together.ai/settings/api-keys" },
  custom: { name: "Other", baseUrl: "", local: false },
} as const satisfies Record<string, ServicePreset>;

export type ServiceId = keyof typeof SERVICES;
export const SERVICE_IDS = Object.keys(SERVICES) as ServiceId[];

/** Models the person can add in Settings › Models. */
export const MAX_CUSTOM_MODELS = 12;
export const CUSTOM_NAME_CHARS = 40;
export const CUSTOM_MODEL_CHARS = 200;

/** A host on this computer or the local network, where plain http is fine. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/**
 * A service's base URL as Kiki keeps it (no trailing slash), or what's wrong with it. Keys only travel over
 * https, except to a server on this computer or the local network.
 */
export function checkBaseUrl(raw: string): { url: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: "Enter the service's full address, like http://localhost:11434/v1." };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
    return { error: "The address must start with https:// (http:// only for a server on this computer or your network)." };
  }
  return { url: url.toString().replace(/\/+$/, "") };
}

/** How messages name a service: its name, or the address's host for "Other". */
export function serviceName(service: ServiceId, baseUrl: string): string {
  if (service !== "custom") return SERVICES[service].name;
  try {
    return new URL(baseUrl).host;
  } catch {
    return "your server";
  }
}
