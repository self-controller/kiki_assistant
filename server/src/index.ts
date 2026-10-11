import "./env.ts";
import Anthropic from "@anthropic-ai/sdk";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { DEFAULT_CLAUDE_CONFIG, type ClaudeConfig, type Effort } from "./claude.ts";
import { CodeStore } from "./codes.ts";
import { ConversationStore } from "./conversations.ts";
import { sttConfigFromEnv } from "./stt.ts";

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

function effortFrom(name: string, value: string | undefined, fallback: Effort): Effort {
  const effort = (value || fallback) as Effort;
  if (!EFFORTS.includes(effort)) {
    throw new Error(`${name} must be one of ${EFFORTS.join(", ")}`);
  }
  return effort;
}

/** A non-negative whole number, so 0 can turn a tool off. */
function countFrom(value: string | undefined, fallback: number): number {
  const count = Number(value);
  return value?.trim() && Number.isInteger(count) && count >= 0 ? count : fallback;
}

function loadConfig(env: NodeJS.ProcessEnv): ClaudeConfig {
  return {
    model: env.KIKI_MODEL || DEFAULT_CLAUDE_CONFIG.model,
    effort: effortFrom("KIKI_EFFORT", env.KIKI_EFFORT, DEFAULT_CLAUDE_CONFIG.effort),
    thinkEffort: effortFrom("KIKI_THINK_EFFORT", env.KIKI_THINK_EFFORT, DEFAULT_CLAUDE_CONFIG.thinkEffort),
    maxTokens: Number(env.KIKI_MAX_TOKENS) || DEFAULT_CLAUDE_CONFIG.maxTokens,
    maxSearches: Number(env.KIKI_MAX_SEARCHES) || DEFAULT_CLAUDE_CONFIG.maxSearches,
    maxFetches: countFrom(env.KIKI_MAX_FETCHES, DEFAULT_CLAUDE_CONFIG.maxFetches),
    fallbacks: env.KIKI_FALLBACKS !== "off",
  };
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const config = loadConfig(process.env);
const codes = new CodeStore(process.env.KIKI_DB_PATH || "kiki.db");
const conversations = new ConversationStore();
const stt = sttConfigFromEnv(process.env);
const app = createApp({ codes, conversations, client: new Anthropic(), config, stt });

setInterval(() => conversations.sweep(), 5 * 60 * 1000).unref();

const port = Number(process.env.PORT) || 8787;
const hostname = process.env.HOST || "127.0.0.1";
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(
    `Kiki server listening on http://${hostname}:${info.port} (model ${config.model}, effort ${config.effort}, ` +
      `voice ${stt ? `on via ${new URL(stt.url).host}` : "off"})`,
  );
});
