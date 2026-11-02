// What apps of one kind share, so each app's module only says how to recognize it and what's its own.
import { execFile } from "node:child_process";
import { nameSuffix, stripSuffix } from "./titles.ts";
import { readVscodeFile } from "./vscodeFile.ts";
import type { Vicinity } from "../capture/common.ts";
import type { AppHandler, AppMatch, ReadContext } from "./types.ts";

interface Spec {
  id: string;
  name: string;
  match: AppMatch;
  read?: AppHandler["read"];
}

/**
 * A web browser: Kiki reads its pages over AT-SPI (the active tab's address and text). The title sent is the
 * page's own, without the browser's name, which is the app.
 */
export function browser(spec: Spec & { titleNames: string[] }): AppHandler {
  const suffixes = spec.titleNames.map(nameSuffix);
  return {
    id: spec.id,
    name: spec.name,
    kind: "browser",
    match: spec.match,
    title: (windowTitle, pageTitle) => pageTitle?.trim() || stripSuffix(windowTitle, suffixes),
  };
}

/**
 * A terminal: Kiki types into it with its paste shortcut (Ctrl+Shift+V), at the prompt, whether or not it shares
 * its text, and never replaces what's highlighted (that's output).
 */
export function terminal(spec: Spec): AppHandler {
  return { id: spec.id, name: spec.name, kind: "terminal", match: spec.match, ...(spec.read ? { read: spec.read } : {}) };
}

/** A text or code editor that shares its text over AT-SPI: Kiki reads the lines around the highlight. */
export function editor(spec: Spec & { titleNames?: string[] }): AppHandler {
  const suffixes = (spec.titleNames ?? []).map(nameSuffix);
  return {
    id: spec.id,
    name: spec.name,
    kind: "editor",
    match: spec.match,
    ...(suffixes.length ? { title: (windowTitle: string) => stripSuffix(windowTitle, suffixes) } : {}),
  };
}

/**
 * VS Code and its forks, which share nothing over AT-SPI: the title names the file. When VS Code's
 * `window.title` shows the file's full path, Kiki reads the lines around the highlight from the saved file.
 */
export function vscodeLike(spec: Spec & { titleNames: string[] }): AppHandler {
  const suffixes = spec.titleNames.map(nameSuffix);
  return {
    id: spec.id,
    name: spec.name,
    kind: "editor",
    match: spec.match,
    title: (windowTitle) => stripSuffix(windowTitle, suffixes),
    read: (context: ReadContext) => readVscodeFile(context, suffixes),
  };
}

/** Runs a program (never a shell) and gives its output; for apps' own command-line tools. */
export type Exec = (file: string, args: string[], options: { signal: AbortSignal; env?: NodeJS.ProcessEnv }) => Promise<string>;

export const execText: Exec = (file, args, { signal, env }) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { signal, env, timeout: 1_500, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

/**
 * A terminal's screen as an app's own tool printed it, around the highlight when it's there (the last time it
 * is: the newest output), or else all of it before the cursor, which is usually at the bottom.
 */
export function screenVicinity(screen: string, selection: string): Vicinity {
  const text = screen.replace(/\r\n?/g, "\n");
  const at = selection.trim() ? text.lastIndexOf(selection) : -1;
  if (at < 0) return { kind: "terminal", before: text, anchor: "", after: "" };
  return { kind: "terminal", before: text.slice(0, at), anchor: selection, after: text.slice(at + selection.length) };
}
