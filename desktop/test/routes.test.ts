import { describe, expect, it } from "vitest";
import { accountFor, providerStatuses, routeFor, type RouteSetup } from "../src/main/routes.ts";

const SIGNED_IN = { path: "/home/me/.local/bin/claude", version: "2.1.308", signedIn: true, account: "Claude Pro" };

function setup(over: Partial<RouteSetup> = {}): RouteSetup {
  return {
    accounts: {},
    key: () => null,
    agents: { anthropic: null, openai: null },
    findAgent: () => null,
    customModel: () => null,
    ...over,
  };
}

describe("routeFor", () => {
  it("asks Claude on the person's Claude Code when it's there", () => {
    const found = setup({ agents: { anthropic: SIGNED_IN, openai: null } });
    expect(routeFor("opus", found)).toEqual({ route: { kind: "claude-code", executable: "/home/me/.local/bin/claude" } });
    // No model picked: Claude.
    expect(routeFor(undefined, found)).toEqual({ route: { kind: "claude-code", executable: "/home/me/.local/bin/claude" } });
  });

  it("uses only the one the person picked: a saved key stays unused while Claude Code is picked", () => {
    const keys = { anthropic: "sk-ant-mine", openai: "sk-mine" } as Record<string, string>;
    const both = setup({ key: (provider) => keys[provider] ?? null, agents: { anthropic: SIGNED_IN, openai: { path: "/bin/codex", signedIn: true } } });
    expect(routeFor("opus", { ...both, accounts: { anthropic: "agent" } })).toMatchObject({ route: { kind: "claude-code" } });
    expect(routeFor("opus", { ...both, accounts: { anthropic: "key" } })).toEqual({ route: { kind: "key", provider: "anthropic", apiKey: "sk-ant-mine" } });
    expect(routeFor("sol", { ...both, accounts: { openai: "agent" } })).toEqual({ route: { kind: "codex" } });
    expect(routeFor("sol", { ...both, accounts: { openai: "key" } })).toEqual({ route: { kind: "key", provider: "openai", apiKey: "sk-mine" } });
  });

  it("never falls back to the key when Claude Code is picked but signed out or gone", () => {
    const keyed = { key: () => "sk-ant-mine", accounts: { anthropic: "agent" as const } };
    expect(routeFor("opus", setup({ ...keyed, agents: { anthropic: { ...SIGNED_IN, signedIn: false }, openai: null } }))).toEqual({
      error: "Claude Code isn't signed in. Run `claude` in a terminal and log in, then try again.",
    });
    expect(routeFor("opus", setup({ ...keyed, agents: { anthropic: { path: null, signedIn: false }, openai: null } }))).toEqual({
      error: "Kiki can't find Claude Code on this computer. Install it and sign in, or use an Anthropic API key (Settings › Models).",
    });
  });

  it("asks for a key where there's no other way", () => {
    expect(routeFor("flash", setup())).toEqual({ error: "To ask Gemini, add your Gemini API key in Settings › Models." });
    expect(routeFor("opus", setup({ accounts: { anthropic: "key" } }))).toEqual({
      error: "To ask Claude, add your Anthropic API key in Settings › Models.",
    });
    expect(routeFor("flash", setup({ key: (provider) => (provider === "google" ? "AIza-mine" : null) }))).toEqual({
      route: { kind: "key", provider: "google", apiKey: "AIza-mine" },
    });
  });

  it("asks the models the person added at their address, by their service's name", () => {
    const added = setup({
      customModel: (id) =>
        id === "m1"
          ? { service: "ollama", baseUrl: "http://localhost:11434/v1", model: "qwen3:8b", key: null }
          : id === "m2"
            ? { service: "custom", baseUrl: "https://llm.example.com/v1", model: "big", key: "sk-x" }
            : null,
    });
    expect(routeFor("custom:m1", added)).toEqual({
      route: { kind: "compatible", name: "Ollama", baseUrl: "http://localhost:11434/v1", model: "qwen3:8b" },
    });
    expect(routeFor("custom:m2", added)).toEqual({
      route: { kind: "compatible", name: "llm.example.com", baseUrl: "https://llm.example.com/v1", model: "big", apiKey: "sk-x" },
    });
    expect(routeFor("custom:gone", added)).toEqual({ error: "That model isn't in Settings anymore. Pick another one." });
  });
});

describe("accountFor", () => {
  it("defaults to Claude Code or Codex when Kiki finds it, else the key", () => {
    expect(accountFor("anthropic", setup({ findAgent: () => "/usr/local/bin/claude" }))).toBe("agent");
    expect(accountFor("openai", setup({ key: () => "sk-mine" }))).toBe("key");
    // Neither: Settings suggests installing it, or adding a key.
    expect(accountFor("openai", setup())).toBe("agent");
    expect(accountFor("anthropic", setup({ findAgent: () => "/usr/local/bin/claude", accounts: { anthropic: "key" } }))).toBe("key");
  });
});

describe("providerStatuses", () => {
  it("marks each provider ready, or waiting to be set up", () => {
    expect(providerStatuses(setup({ agents: { anthropic: SIGNED_IN, openai: null }, key: (p) => (p === "google" ? "AIza" : null) }))).toEqual({
      anthropic: "ready",
      google: "ready",
      openai: "needsSetup",
    });
  });
});
