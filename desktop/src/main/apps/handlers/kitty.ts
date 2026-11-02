// kitty: nothing over AT-SPI, but with remote control on, `kitty @ get-text` prints the active window's screen and
// what's highlighted in it. Needs `allow_remote_control yes` and `listen_on unix:...` in kitty.conf, and Kiki's
// GNOME helper (v11) to tell it's kitty and which process.
import { readFile, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { execText, screenVicinity, terminal, type Exec } from "../families.ts";
import type { AppExtras, ReadContext } from "../types.ts";

/** `allow_remote_control` values that let a program outside kitty ask it, without a password or a prompt. */
const REMOTE_ON = new Set(["yes", "y", "true", "socket", "socket-only"]);

/** The last value of each setting in kitty.conf's text (later lines win, as in kitty). Ignores `include`. */
export function parseKittyConfig(text: string): Map<string, string> {
  const settings = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^\s*([a-z_]+)\s+(.+?)\s*$/.exec(line);
    if (match && !line.trimStart().startsWith("#")) settings.set(match[1]!, match[2]!);
  }
  return settings;
}

/**
 * Where the kitty with process `pid` listens, from `listen_on`: environment variables and `~` expanded, and
 * `{kitty_pid}` filled in (or, for a UNIX socket without it, "-<pid>" added, as kitty does). Undefined without one.
 */
export function kittySocket(listenOn: string | undefined, pid: number, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!listenOn || listenOn === "none") return undefined;
  const expanded = listenOn
    .replace(/\$\{(\w+)\}|\$(\w+)/g, (_, braced?: string, bare?: string) => env[(braced ?? bare)!] ?? "")
    .replace(/^unix:~\//, `unix:${homedir()}/`);
  if (expanded.includes("{kitty_pid}")) return expanded.replaceAll("{kitty_pid}", String(pid));
  return expanded.startsWith("unix:") ? `${expanded}-${pid}` : expanded;
}

export interface KittyDeps {
  exec: Exec;
  /** kitty.conf's text, or "" when there's none. */
  readConfig: () => Promise<string>;
  /** The kitty program behind `pid`: it may not be on PATH (~/.local/kitty.app). */
  program: (pid: number) => Promise<string>;
}

const DEFAULTS: KittyDeps = {
  exec: execText,
  readConfig: async () => {
    const dir = process.env.KITTY_CONFIG_DIRECTORY ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kitty");
    return readFile(join(dir, "kitty.conf"), "utf8").catch(() => "");
  },
  program: async (pid) => {
    const exe = await readlink(`/proc/${pid}/exe`).catch(() => "");
    return basename(exe) === "kitty" ? exe : "kitty";
  },
};

export async function readKitty(context: ReadContext, deps: KittyDeps = DEFAULTS): Promise<AppExtras | undefined> {
  const { pid } = context.identity;
  if (!pid) return undefined;
  const config = parseKittyConfig(await deps.readConfig());
  // Off, or set to ask: kitty would show a prompt in the terminal on every hotkey.
  if (!REMOTE_ON.has(config.get("allow_remote_control")?.toLowerCase() ?? "no")) return undefined;
  const socket = kittySocket(config.get("listen_on"), pid);
  if (!socket) return undefined;
  const program = await deps.program(pid);
  // Started from a kitty window, Kiki has its id, and kitty would read that window instead of the active one.
  const { KITTY_WINDOW_ID: _window, KITTY_LISTEN_ON: _listen, ...env } = process.env;
  const ask = (extent: string) =>
    deps.exec(program, ["@", "--to", socket, "get-text", "--extent", extent], { signal: context.signal, env });
  const [screen, selection] = await Promise.all([ask("screen"), ask("selection").catch(() => undefined)]);
  if (!screen.trim()) return undefined;
  const highlighted = selection?.replace(/\n$/, "");
  return {
    vicinity: screenVicinity(screen, highlighted ?? context.selection),
    // kitty knows what's highlighted in it: nothing means the primary selection came from another window.
    ...(highlighted !== undefined ? { selection: highlighted } : {}),
  };
}

export default terminal({
  id: "kitty",
  name: "kitty",
  match: {
    ids: ["kitty"],
    wmClasses: ["kitty"],
    exes: ["kitty"],
    atspiNames: ["kitty"],
    macNames: ["kitty"],
  },
  read: (context) => readKitty(context),
});
