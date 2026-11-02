// Past sessions, kept on this computer so the popup can show and continue them. The engine forgets a
// conversation after an hour (and when Kiki quits); a session continued after that starts a new one from what's saved here.
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS, type EarlierTurn } from "@kiki/shared";
import { app } from "electron";
import type { PastTurn } from "../shared-types.ts";
import { describeAction } from "./google/format.ts";

/** How many unsaved sessions Kiki keeps; older ones drop off. Saved ones don't count. */
export const MAX_SESSIONS = 50;

/** How long an unsaved session stays after it was last used. */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The context a session started with: what went to the model, so chips the user removed stay out. */
export interface SessionContext {
  selection: string;
  appName?: string;
  windowTitle?: string;
  text?: string;
}

export interface HistoryEntry {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** The engine's conversation, until it expires. */
  conversationId: string | null;
  context: SessionContext;
  turns: PastTurn[];
  /** Kept until the person deletes it; unsaved sessions go a week after they were last used. */
  saved?: boolean;
}

export function newEntry(context: SessionContext, now = Date.now()): HistoryEntry {
  return { id: randomUUID(), createdAt: now, updatedAt: now, conversationId: null, context, turns: [] };
}

/** Puts `entry` first, replacing its older copy, and keeps every saved session and the newest `max` others. */
export function upsertEntry(entries: readonly HistoryEntry[], entry: HistoryEntry, max = MAX_SESSIONS): HistoryEntry[] {
  let unsaved = 0;
  return [entry, ...entries.filter((other) => other.id !== entry.id)].filter(
    (other) => other.saved || unsaved++ < max,
  );
}

/** The sessions still kept at `now`: saved ones, and the others used in the last week. */
export function pruneEntries(entries: readonly HistoryEntry[], now = Date.now()): HistoryEntry[] {
  return entries.filter((entry) => entry.saved || now - entry.updatedAt < RETENTION_MS);
}

/** The action cards in an answer and what became of them, as a line Claude can read back. */
function cardsNote(turn: PastTurn): string {
  if (!turn.actions?.length) return "";
  const cards = turn.actions.map(
    ({ action, status }) => `${action.kind} ${describeAction(action)} (${status ? status.outcome : "not acted on"})`,
  );
  return `\n\n[Cards proposed: ${cards.join("; ")}]`;
}

/** How long a later highlight can be in a restarted conversation's question. */
const HIGHLIGHT_NOTE_CHARS = 600;

/** The text a turn's question was about, when it came with a later press of the hotkey. */
function highlightNote(turn: PastTurn): string {
  const highlight = turn.highlight?.trim();
  if (!highlight) return "";
  const cut = highlight.length > HIGHLIGHT_NOTE_CHARS ? `${highlight.slice(0, HIGHLIGHT_NOTE_CHARS)}…` : highlight;
  return `[Highlighted: "${cut}"]\n`;
}

/** The turns a restarted conversation carries over: the latest few, with long answers cut short. */
export function earlierTurns(turns: readonly PastTurn[]): EarlierTurn[] {
  return turns
    .filter((turn) => turn.question.trim() && (turn.answer.trim() || turn.actions?.length))
    .slice(-LIMITS.earlierTurns)
    .map((turn) => {
      const note = cardsNote(turn);
      const highlight = highlightNote(turn);
      return {
        question: highlight + turn.question.slice(0, LIMITS.questionChars - highlight.length),
        answer: turn.answer.slice(0, LIMITS.earlierAnswerChars - note.length) + note,
      };
    });
}

let cached: HistoryEntry[] | null = null;

function historyPath(): string {
  return join(app.getPath("userData"), "history.json");
}

function isEntry(value: unknown): value is HistoryEntry {
  const entry = value as HistoryEntry | null;
  return typeof entry?.id === "string" && Array.isArray(entry.turns) && typeof entry.context === "object";
}

function load(): HistoryEntry[] {
  if (cached) return cached;
  try {
    const stored = JSON.parse(readFileSync(historyPath(), "utf8")) as { sessions?: unknown };
    cached = Array.isArray(stored.sessions) ? stored.sessions.filter(isEntry) : [];
  } catch {
    cached = [];
  }
  return cached;
}

/** Whether `cached` has changes not yet on disk, and the write on its way, if any. */
let dirty = false;
let writing: Promise<void> | null = null;

/**
 * Keeps `entries` and writes them to disk off the main thread: one write at a time, each of whatever is current
 * when it starts, so a burst of saves ends in one write of the newest state. Through a temporary file, so a write
 * cut short (Kiki quitting) leaves the last complete one.
 */
function persist(entries: HistoryEntry[]): void {
  cached = entries;
  dirty = true;
  writing ??= (async () => {
    while (dirty) {
      dirty = false;
      const path = historyPath();
      try {
        await writeFile(`${path}.tmp`, JSON.stringify({ sessions: cached }), { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      } catch (error) {
        console.error("[kiki] couldn't save history:", error);
      }
    }
    writing = null;
  })();
}

/** Writes what hasn't reached the disk yet; Kiki is quitting. */
export function flushHistory(): void {
  if (!dirty) return;
  dirty = false;
  const path = historyPath();
  try {
    writeFileSync(`${path}.tmp`, JSON.stringify({ sessions: cached ?? [] }), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  } catch (error) {
    console.error("[kiki] couldn't save history:", error);
  }
}

/** Deletes unsaved sessions that weren't used in the last week, on disk too. */
export function pruneHistory(now = Date.now()): void {
  const entries = load();
  const kept = pruneEntries(entries, now);
  if (kept.length < entries.length) persist(kept);
}

/** Newest first. */
export function listHistory(): readonly HistoryEntry[] {
  pruneHistory();
  return load();
}

export function getEntry(id: string): HistoryEntry | undefined {
  return load().find((entry) => entry.id === id);
}

export function saveEntry(entry: HistoryEntry): void {
  // The popup's copy doesn't hear about saves from the list of past sessions: the stored copy has the say.
  const stored = getEntry(entry.id);
  const copy = withSaved(structuredClone(entry), stored ? Boolean(stored.saved) : Boolean(entry.saved));
  persist(upsertEntry(pruneEntries(load()), copy));
}

/** Saves a session for good, or lets it go a week after it was last used. False when it's gone. */
export function setSaved(id: string, saved: boolean): boolean {
  const entries = load();
  if (!entries.some((entry) => entry.id === id)) return false;
  persist(entries.map((entry) => (entry.id === id ? withSaved({ ...entry }, saved) : entry)));
  return true;
}

function withSaved(entry: HistoryEntry, saved: boolean): HistoryEntry {
  if (saved) entry.saved = true;
  else delete entry.saved;
  return entry;
}

export function clearHistory(): void {
  persist([]);
}
