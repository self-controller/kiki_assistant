// VS Code shares nothing over AT-SPI. When its title shows the open file's full path, Kiki reads the lines
// around the highlight from the file as saved: only what's highlighted is looked for, and only nearby lines go.
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, sep } from "node:path";
import { stripSuffix } from "./titles.ts";
import type { AppExtras, ReadContext } from "./types.ts";

/** Bigger files aren't something one reads around a highlight in. */
const MAX_FILE_BYTES = 1_000_000;
/** How much to keep on each side of the highlight, like the AT-SPI helper; Kiki trims it to whole lines. */
const BEFORE_CHARS = 16_000;
const AFTER_CHARS = 8_000;
/** VS Code's title shows an unsaved file with a dot first: the file on disk isn't what's on screen. */
const UNSAVED = "●";
/** Folders and files that hold keys and passwords: never read, even when they're open. */
const SECRET_FOLDERS = new Set([".ssh", ".gnupg"]);
const SECRET_FILE = /^(?:\.env(?:\..+)?|\.netrc|\.pgpass|id_[a-z0-9]+(?:\.pub)?)$|\.(?:pem|key|p12|pfx)$/i;

/**
 * Where the open file may be, from a title like "/home/me/kiki/src/main.ts - kiki - Visual Studio Code" (with
 * `window.title` set to show `${activeEditorLong}`): the path before each " - ", longest first, because a path
 * can hold " - " too. Nothing for an unsaved file or a title without a full path (VS Code's default).
 */
export function titlePaths(title: string, suffixes: RegExp[]): string[] {
  const trimmed = title.trim();
  if (trimmed.startsWith(UNSAVED)) return [];
  const rest = stripSuffix(trimmed, suffixes);
  const expanded = rest.startsWith("~/") ? join(homedir(), rest.slice(2)) : rest;
  if (!isAbsolute(expanded)) return [];
  const cuts = [...expanded.matchAll(/ - /g)].map((match) => match.index);
  return [expanded, ...cuts.reverse().map((at) => expanded.slice(0, at))];
}

/** Whether a file is one Kiki never reads: SSH and GPG keys, .env files, certificates' keys. */
export function isSecretPath(path: string): boolean {
  return path.split(sep).some((part) => SECRET_FOLDERS.has(part)) || SECRET_FILE.test(basename(path));
}

/** The first of `paths` that's a file Kiki can read around a highlight, after following links. */
async function readableFile(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    const real = await realpath(path).catch(() => undefined);
    if (!real) continue;
    const info = await stat(real).catch(() => undefined);
    if (info?.isFile()) return info.size <= MAX_FILE_BYTES ? real : undefined;
  }
  return undefined;
}

export async function readVscodeFile(context: ReadContext, suffixes: RegExp[]): Promise<AppExtras | undefined> {
  // With nothing highlighted Kiki can't tell where in the file the cursor is.
  const selection = context.selection.replace(/\r\n?/g, "\n");
  if (!selection.trim() || !context.windowTitle) return undefined;
  const path = await readableFile(titlePaths(context.windowTitle, suffixes));
  if (!path) return undefined;
  if (isSecretPath(path)) {
    console.info("[kiki] vscode read: skipped a file that may hold secrets");
    return undefined;
  }
  const raw = await readFile(path, { encoding: "utf8", signal: context.signal });
  if (raw.includes("\u0000")) return undefined;
  const text = raw.replace(/\r\n?/g, "\n");
  const at = text.indexOf(selection);
  // Not there (highlighted somewhere else: a panel, another window), or there twice: Kiki can't tell which lines.
  if (at < 0 || text.indexOf(selection, at + 1) >= 0) return undefined;
  const end = at + selection.length;
  return {
    vicinity: {
      kind: "editor",
      before: text.slice(Math.max(0, at - BEFORE_CHARS), at),
      anchor: selection,
      after: text.slice(end, end + AFTER_CHARS),
    },
  };
}
