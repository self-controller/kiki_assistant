import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";

export interface Conversation {
  id: string;
  codeId: number;
  /** Append-only Claude history; assistant turns are stored exactly as returned. */
  messages: Anthropic.Beta.BetaMessageParam[];
  userTurns: number;
  lastUsed: number;
  busy: boolean;
}

export interface ConversationStoreOptions {
  ttlMs?: number;
  maxUserTurns?: number;
  now?: () => number;
}

/**
 * In-memory conversation history, keyed by id and owned by one invite code.
 * Conversations expire after `ttlMs` of inactivity and do not survive restarts.
 */
export class ConversationStore {
  readonly ttlMs: number;
  readonly maxUserTurns: number;
  readonly now: () => number;
  readonly #byId = new Map<string, Conversation>();

  constructor(options: ConversationStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60 * 60 * 1000;
    this.maxUserTurns = options.maxUserTurns ?? 20;
    this.now = options.now ?? Date.now;
  }

  create(codeId: number): Conversation {
    this.sweep();
    const conversation: Conversation = {
      id: randomUUID(),
      codeId,
      messages: [],
      userTurns: 0,
      lastUsed: this.now(),
      busy: false,
    };
    this.#byId.set(conversation.id, conversation);
    return conversation;
  }

  /** Returns the conversation if it exists, has not expired, and belongs to `codeId`. */
  get(id: string, codeId: number): Conversation | undefined {
    const conversation = this.#byId.get(id);
    if (!conversation || conversation.codeId !== codeId) return undefined;
    if (!conversation.busy && this.now() - conversation.lastUsed > this.ttlMs) {
      this.#byId.delete(id);
      return undefined;
    }
    return conversation;
  }

  delete(id: string): void {
    this.#byId.delete(id);
  }

  sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, conversation] of this.#byId) {
      if (!conversation.busy && conversation.lastUsed < cutoff) this.#byId.delete(id);
    }
  }

  get size(): number {
    return this.#byId.size;
  }
}
