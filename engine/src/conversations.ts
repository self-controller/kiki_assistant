import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolResult } from "@kiki/shared";
import type { AgentSession } from "./turn.ts";

export interface Conversation {
  id: string;
  /** Append-only Claude history; assistant turns are stored exactly as returned. */
  messages: Anthropic.Beta.BetaMessageParam[];
  userTurns: number;
  lastUsed: number;
  busy: boolean;
  /** Read tools the app is running for the current turn, by tool_use id. */
  pendingTools: Map<string, (result: ToolResult) => void>;
  /** The personality prompt the conversation started with. */
  personality?: string;
  /** The plan agent's session (Claude Code, Codex), and how many of `messages` it holds. */
  agent?: AgentSession & { covers: number };
}

export interface ConversationStoreOptions {
  ttlMs?: number;
  maxUserTurns?: number;
  now?: () => number;
  /** Called when a conversation is deleted or expires, to let go of its agent session. */
  onRemove?: (conversation: Conversation) => void;
}

/**
 * In-memory conversation history, keyed by id. Conversations expire after `ttlMs` of inactivity and do not
 * survive restarts (the app keeps its own history, and restarts a conversation from it).
 */
export class ConversationStore {
  readonly ttlMs: number;
  readonly maxUserTurns: number;
  readonly now: () => number;
  readonly #byId = new Map<string, Conversation>();
  readonly #onRemove: (conversation: Conversation) => void;

  constructor(options: ConversationStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60 * 60 * 1000;
    this.maxUserTurns = options.maxUserTurns ?? 20;
    this.now = options.now ?? Date.now;
    this.#onRemove = options.onRemove ?? (() => {});
  }

  #remove(conversation: Conversation): void {
    this.#byId.delete(conversation.id);
    this.#onRemove(conversation);
  }

  create(): Conversation {
    this.sweep();
    const conversation: Conversation = {
      id: randomUUID(),
      messages: [],
      userTurns: 0,
      lastUsed: this.now(),
      busy: false,
      pendingTools: new Map(),
    };
    this.#byId.set(conversation.id, conversation);
    return conversation;
  }

  /** Returns the conversation if it exists and has not expired. */
  get(id: string): Conversation | undefined {
    const conversation = this.#byId.get(id);
    if (!conversation) return undefined;
    if (!conversation.busy && this.now() - conversation.lastUsed > this.ttlMs) {
      this.#remove(conversation);
      return undefined;
    }
    return conversation;
  }

  delete(id: string): void {
    const conversation = this.#byId.get(id);
    if (conversation) this.#remove(conversation);
  }

  /** Forgets every conversation (Kiki is quitting). */
  clear(): void {
    for (const conversation of [...this.#byId.values()]) this.#remove(conversation);
  }

  sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const conversation of this.#byId.values()) {
      if (!conversation.busy && conversation.lastUsed < cutoff) this.#remove(conversation);
    }
  }

  get size(): number {
    return this.#byId.size;
  }
}
