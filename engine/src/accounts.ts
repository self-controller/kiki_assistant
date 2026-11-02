// The person's own Claude Code and Codex: Kiki runs the copies they installed and signed in to themselves
// (with their Claude or ChatGPT plan), so questions use their plan's limits. Kiki ships neither, never signs
// anyone in, and never reads their credentials; signing in happens in Claude Code's and Codex's own flows.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ErrorCode } from "@kiki/shared";

/**
 * The environment Claude Code and Codex run with: Kiki's, without API keys (with ANTHROPIC_API_KEY set, Claude
 * Code would bill that key instead of the plan they signed in with), and without the variables of a Claude
 * Code session Kiki may have been started from.
 */
export function agentEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|CODEX_API_KEY|CLAUDECODE)$/.test(name)) continue;
    if (name.startsWith("CLAUDE_CODE_") && name !== "CLAUDE_CODE_OAUTH_TOKEN") continue;
    clean[name] = value;
  }
  return clean;
}

let agentDir: string | undefined;

/** An empty folder for the agents to run in, so no project's CLAUDE.md, AGENTS.md or git reaches them. */
export function agentCwd(): string {
  if (agentDir) return agentDir;
  const dir = join(tmpdir(), "kiki-agents");
  mkdirSync(dir, { recursive: true });
  return (agentDir = dir);
}

/**
 * Where `name` is installed: on PATH, or where Claude Code and Codex install themselves. An app started from
 * the desktop often has a shorter PATH than a terminal, without ~/.local/bin.
 */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string | null {
  const dirs = [
    ...(env.PATH ?? "").split(delimiter).filter(Boolean),
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    join(home, ".npm-global", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
  for (const dir of dirs) {
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** A short fingerprint of what an agent session was started with, to tell whether a follow-up can continue it. */
export function sessionKey(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/** A question to Claude Code or Codex that failed in a way the person should hear about in plain words. */
export class PlanError extends Error {
  readonly code: ErrorCode;
  /** Something worth a line in Kiki's log. */
  readonly log: boolean;
  /** What the agent said, for the log. */
  readonly detail: string | undefined;

  constructor(code: ErrorCode, message: string, log = false, detail?: string) {
    super(message);
    this.name = "PlanError";
    this.code = code;
    this.log = log;
    this.detail = detail;
  }
}

/** " (it resets at 3:40 PM)", or " (it resets Fri at 9:00 AM)" further out; empty without a time. */
export function resetNote(resetsAt: number | null | undefined, now = Date.now()): string {
  if (!resetsAt) return "";
  const at = new Date(resetsAt * 1000);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = at.getTime() - now > 20 * 60 * 60 * 1000 ? `${at.toLocaleDateString([], { weekday: "short" })} ` : "";
  return ` (it resets ${day}at ${time})`;
}

/** How the person's Claude Code or Codex is set up on this computer. */
export interface AgentStatus {
  /** Where it's installed; null when Kiki can't find it. */
  path: string | null;
  version?: string;
  signedIn: boolean;
  /** What it's signed in with, for Settings: "Claude Pro", "ChatGPT", "an API key". */
  account?: string;
}

/** Runs `command` and gives back what it printed, whether or not it succeeded. */
export type RunCommand = (command: string, args: string[]) => Promise<string>;

export const runCommand: RunCommand = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { env: agentEnv(), cwd: agentCwd(), timeout: 15_000 }, (_error, stdout, stderr) =>
      resolve(`${stdout}${stderr}`),
    );
  });

/** "2.1.308" from "2.1.308 (Claude Code)" or "codex-cli 0.163.0". */
export function versionOf(output: string): string | undefined {
  return /\d+\.\d+\.\d+(?:[-.\w]*)?/.exec(output)?.[0];
}

/** What `claude auth status` says: signed in, and with which plan. */
export function parseClaudeStatus(output: string): Pick<AgentStatus, "signedIn" | "account"> {
  let status: { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown };
  try {
    status = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1)) as typeof status;
  } catch {
    return { signedIn: false };
  }
  if (status.loggedIn === false || !status.authMethod || status.authMethod === "none") return { signedIn: false };
  if (status.authMethod === "claude.ai") {
    const plan = typeof status.subscriptionType === "string" && status.subscriptionType ? status.subscriptionType : "";
    return { signedIn: true, account: plan ? `Claude ${plan[0]!.toUpperCase()}${plan.slice(1)}` : "a Claude account" };
  }
  return { signedIn: true, account: "an API key" };
}

/** What `codex login status` says: "Logged in using ChatGPT", "Logged in using an API key - sk-…", "Not logged in". */
export function parseCodexStatus(output: string): Pick<AgentStatus, "signedIn" | "account"> {
  if (/not logged in/i.test(output) || !/logged in/i.test(output)) return { signedIn: false };
  if (/chatgpt/i.test(output)) return { signedIn: true, account: "ChatGPT" };
  return { signedIn: true, account: "an API key" };
}

/** Whether the person's Claude Code is installed and signed in. */
export async function claudeCodeStatus(run: RunCommand = runCommand, path = findExecutable("claude")): Promise<AgentStatus> {
  if (!path) return { path: null, signedIn: false };
  const [version, status] = await Promise.all([run(path, ["--version"]), run(path, ["auth", "status"])]);
  return { path, ...optionalVersion(versionOf(version)), ...parseClaudeStatus(status) };
}

/** Whether the person's Codex is installed and signed in. */
export async function codexStatus(run: RunCommand = runCommand, path = findExecutable("codex")): Promise<AgentStatus> {
  if (!path) return { path: null, signedIn: false };
  const [version, status] = await Promise.all([run(path, ["--version"]), run(path, ["login", "status"])]);
  return { path, ...optionalVersion(versionOf(version)), ...parseCodexStatus(status) };
}

function optionalVersion(version: string | undefined): { version?: string } {
  return version ? { version } : {};
}
