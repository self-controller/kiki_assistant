import { describe, expect, it } from "vitest";
import { checkProviderKey, listCompatibleModels } from "../src/main/providerKeys.ts";

/** A fetch that answers `status`, and remembers what it was asked. */
function answering(status: number) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers as Record<string, string> });
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("checkProviderKey", () => {
  it("lists one provider's models with the key, in each provider's header", async () => {
    const google = answering(200);
    expect(await checkProviderKey("google", "AIza-key", google.fetchImpl)).toEqual({ result: "valid" });
    expect(google.calls).toEqual([
      { url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", headers: { "x-goog-api-key": "AIza-key" } },
    ]);
    const openai = answering(200);
    expect(await checkProviderKey("openai", "sk-key", openai.fetchImpl)).toEqual({ result: "valid" });
    expect(openai.calls).toEqual([{ url: "https://api.openai.com/v1/models", headers: { authorization: "Bearer sk-key" } }]);
  });

  it("rejects a key the provider says is wrong", async () => {
    // Google answers a bad key with 400; OpenAI with 401.
    for (const status of [400, 401, 403]) {
      expect(await checkProviderKey("google", "bad", answering(status).fetchImpl)).toEqual({ result: "rejected" });
    }
  });

  it("leaves a key unchecked when the provider can't say", async () => {
    expect(await checkProviderKey("openai", "sk-key", answering(429).fetchImpl)).toEqual({
      result: "unchecked",
      reason: "OpenAI answered HTTP 429",
    });
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await checkProviderKey("google", "AIza-key", offline)).toEqual({
      result: "unchecked",
      reason: "Kiki couldn't reach Google",
    });
  });
});

describe("checkProviderKey for Anthropic", () => {
  it("lists a model with the key in Anthropic's headers", async () => {
    const anthropic = answering(200);
    expect(await checkProviderKey("anthropic", "sk-ant-key", anthropic.fetchImpl)).toEqual({ result: "valid" });
    expect(anthropic.calls).toEqual([
      { url: "https://api.anthropic.com/v1/models?limit=1", headers: { "x-api-key": "sk-ant-key", "anthropic-version": "2023-06-01" } },
    ]);
    expect(await checkProviderKey("anthropic", "bad", answering(401).fetchImpl)).toEqual({ result: "rejected" });
  });
});

describe("listCompatibleModels", () => {
  const ollama = { name: "Ollama", baseUrl: "http://localhost:11434/v1", local: true };
  const router = { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", local: false };

  it("lists the service's models, sorted, with the key when there is one", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: init?.headers as Record<string, string> });
      return Response.json({ object: "list", data: [{ id: "qwen3:8b" }, { id: "llama3.2:3b" }, { id: "qwen3:8b" }] });
    }) as unknown as typeof fetch;
    expect(await listCompatibleModels(ollama, undefined, fetchImpl)).toEqual({ ok: true, models: ["llama3.2:3b", "qwen3:8b"] });
    await listCompatibleModels(router, "sk-or-key", fetchImpl);
    expect(calls).toEqual([
      { url: "http://localhost:11434/v1/models", headers: {} },
      { url: "https://openrouter.ai/api/v1/models", headers: { authorization: "Bearer sk-or-key" } },
    ]);
  });

  it("says when a local server isn't running, or the key is wrong", async () => {
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await listCompatibleModels(ollama, undefined, offline)).toEqual({
      ok: false,
      message: "Kiki couldn't reach Ollama at localhost:11434. Is it running?",
    });
    expect(await listCompatibleModels(router, "bad", answering(401).fetchImpl)).toEqual({ ok: false, message: "OpenRouter didn't accept that API key." });
    expect(await listCompatibleModels(router, undefined, answering(401).fetchImpl)).toEqual({ ok: false, message: "OpenRouter needs an API key." });
  });
});
