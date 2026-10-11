import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface CodeRecord {
  id: number;
  name: string;
  dailyLimit: number;
  createdAt: string;
  revokedAt: string | null;
}

export interface UsageDelta {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
}

export interface UsageRow extends UsageDelta {
  name: string;
  day: string;
  requests: number;
}

interface CodeRow {
  id: number;
  name: string;
  daily_limit: number;
  created_at: string;
  revoked_at: string | null;
}

const CODE_PREFIX = "kiki_";

export function hashCode(code: string): string {
  return createHash("sha256").update(code.trim()).digest("hex");
}

function toRecord(row: CodeRow): CodeRecord {
  return {
    id: row.id,
    name: row.name,
    dailyLimit: row.daily_limit,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

/** UTC day key, e.g. "2026-10-10". */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Invite codes and per-day usage, stored in SQLite. Only a SHA-256 of each code
 * is kept, so a code can be shown once at creation and never recovered.
 */
export class CodeStore {
  readonly db: DatabaseSync;
  readonly now: () => Date;

  constructor(path: string, now: () => Date = () => new Date()) {
    this.db = new DatabaseSync(path);
    this.now = now;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        code_hash TEXT NOT NULL UNIQUE,
        daily_limit INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS usage (
        code_id INTEGER NOT NULL REFERENCES codes(id),
        day TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        web_searches INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (code_id, day)
      );
    `);
  }

  create(name: string, dailyLimit: number): { code: string; record: CodeRecord } {
    const code = CODE_PREFIX + randomBytes(16).toString("base64url");
    const createdAt = this.now().toISOString();
    const result = this.db
      .prepare("INSERT INTO codes (name, code_hash, daily_limit, created_at) VALUES (?, ?, ?, ?)")
      .run(name, hashCode(code), dailyLimit, createdAt);
    const id = Number(result.lastInsertRowid);
    return { code, record: { id, name, dailyLimit, createdAt, revokedAt: null } };
  }

  /** Returns the code's record if it exists and has not been revoked. */
  verify(code: string): CodeRecord | null {
    if (!code.startsWith(CODE_PREFIX)) return null;
    const row = this.db
      .prepare("SELECT * FROM codes WHERE code_hash = ? AND revoked_at IS NULL")
      .get(hashCode(code)) as CodeRow | undefined;
    return row ? toRecord(row) : null;
  }

  list(): Array<CodeRecord & { usedToday: number }> {
    const rows = this.db
      .prepare(
        `SELECT c.*, COALESCE(u.requests, 0) AS used_today
         FROM codes c LEFT JOIN usage u ON u.code_id = c.id AND u.day = ?
         ORDER BY c.id`,
      )
      .all(dayKey(this.now())) as unknown as Array<CodeRow & { used_today: number }>;
    return rows.map((row) => ({ ...toRecord(row), usedToday: row.used_today }));
  }

  /** Revokes by numeric id or by name. Returns how many codes were revoked. */
  revoke(idOrName: string): number {
    const revokedAt = this.now().toISOString();
    const result = /^\d+$/.test(idOrName)
      ? this.db
          .prepare("UPDATE codes SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
          .run(revokedAt, Number(idOrName))
      : this.db
          .prepare("UPDATE codes SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL")
          .run(revokedAt, idOrName);
    return Number(result.changes);
  }

  usedToday(codeId: number): number {
    const row = this.db
      .prepare("SELECT requests FROM usage WHERE code_id = ? AND day = ?")
      .get(codeId, dayKey(this.now())) as { requests: number } | undefined;
    return row?.requests ?? 0;
  }

  /** Counts one request against today's limit. Returns false if the limit is already reached. */
  tryConsume(record: CodeRecord): boolean {
    const day = dayKey(this.now());
    this.db
      .prepare("INSERT INTO usage (code_id, day) VALUES (?, ?) ON CONFLICT DO NOTHING")
      .run(record.id, day);
    const result = this.db
      .prepare(
        "UPDATE usage SET requests = requests + 1 WHERE code_id = ? AND day = ? AND requests < ?",
      )
      .run(record.id, day, record.dailyLimit);
    return Number(result.changes) === 1;
  }

  /** Gives back a request that never reached Claude (e.g. the conversation was busy). */
  refund(record: CodeRecord): void {
    this.db
      .prepare("UPDATE usage SET requests = MAX(requests - 1, 0) WHERE code_id = ? AND day = ?")
      .run(record.id, dayKey(this.now()));
  }

  recordUsage(record: CodeRecord, delta: UsageDelta): void {
    this.db
      .prepare(
        `UPDATE usage SET
           input_tokens = input_tokens + ?,
           output_tokens = output_tokens + ?,
           cache_read_tokens = cache_read_tokens + ?,
           cache_write_tokens = cache_write_tokens + ?,
           web_searches = web_searches + ?
         WHERE code_id = ? AND day = ?`,
      )
      .run(
        delta.inputTokens,
        delta.outputTokens,
        delta.cacheReadTokens,
        delta.cacheWriteTokens,
        delta.webSearches,
        record.id,
        dayKey(this.now()),
      );
  }

  usage(days: number): UsageRow[] {
    const since = dayKey(new Date(this.now().getTime() - (days - 1) * 86_400_000));
    const rows = this.db
      .prepare(
        `SELECT c.name, u.day, u.requests, u.input_tokens, u.output_tokens,
                u.cache_read_tokens, u.cache_write_tokens, u.web_searches
         FROM usage u JOIN codes c ON c.id = u.code_id
         WHERE u.day >= ? ORDER BY u.day DESC, c.name`,
      )
      .all(since) as Array<Record<string, number | string>>;
    return rows.map((row) => ({
      name: String(row.name),
      day: String(row.day),
      requests: Number(row.requests),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      cacheWriteTokens: Number(row.cache_write_tokens),
      webSearches: Number(row.web_searches),
    }));
  }

  close(): void {
    this.db.close();
  }
}
