// Past sessions, kept on this computer so the popup can show and continue them. The server forgets a
// conversation after an hour; a session continued after that starts a new one from what's saved here.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS, type EarlierTurn } from "@kiki/shared";
import { app } from "electron";
import type { PastTurn } from "../shared-types.ts";
import { describeAction } from "./google/format.ts";

/** How many sessions Kiki keeps; older ones drop off. */
export const MAX_SESSIONS = 50;

/** The context a session started with: what went to the server, so chips the user removed stay out. */
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
  /** The server's conversation, until it expires. */
  conversationId: string | null;
  context: SessionContext;
  turns: PastTurn[];
}

export function newEntry(context: SessionContext, now = Date.now()): HistoryEntry {
  return { id: randomUUID(), createdAt: now, updatedAt: now, conversationId: null, context, turns: [] };
}

/** Puts `entry` first, replacing its older copy, and keeps the newest `max`. */
export function upsertEntry(entries: readonly HistoryEntry[], entry: HistoryEntry, max = MAX_SESSIONS): HistoryEntry[] {
  return [entry, ...entries.filter((other) => other.id !== entry.id)].slice(0, max);
}

/** The action cards in an answer and what became of them, as a line Claude can read back. */
function cardsNote(turn: PastTurn): string {
  if (!turn.actions?.length) return "";
  const cards = turn.actions.map(
    ({ action, status }) => `${action.kind} ${describeAction(action)} (${status ? status.outcome : "not acted on"})`,
  );
  return `\n\n[Cards proposed: ${cards.join("; ")}]`;
}

/** The turns a restarted conversation carries over: the latest few, with long answers cut short. */
export function earlierTurns(turns: readonly PastTurn[]): EarlierTurn[] {
  return turns
    .filter((turn) => turn.question.trim() && (turn.answer.trim() || turn.actions?.length))
    .slice(-LIMITS.earlierTurns)
    .map((turn) => {
      const note = cardsNote(turn);
      return {
        question: turn.question.slice(0, LIMITS.questionChars),
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

function persist(entries: HistoryEntry[]): void {
  cached = entries;
  try {
    writeFileSync(historyPath(), JSON.stringify({ sessions: entries }), { mode: 0o600 });
  } catch (error) {
    console.error("[kiki] couldn't save history:", error);
  }
}

/** Newest first. */
export function listHistory(): readonly HistoryEntry[] {
  return load();
}

export function getEntry(id: string): HistoryEntry | undefined {
  return load().find((entry) => entry.id === id);
}

export function saveEntry(entry: HistoryEntry): void {
  persist(upsertEntry(load(), structuredClone(entry)));
}

export function clearHistory(): void {
  persist([]);
}
