import "./env.ts";
import { parseArgs } from "node:util";
import { CodeStore } from "./codes.ts";

const USAGE = `Manage Kiki invite codes.

  npm run codes -- create <name> [--limit 100]   Create a code (shown once)
  npm run codes -- list                          List codes and today's usage
  npm run codes -- revoke <id|name>              Revoke a code
  npm run codes -- usage [--days 7]              Per-day usage per code`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    limit: { type: "string", default: "100" },
    days: { type: "string", default: "7" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, arg] = positionals;
if (values.help || !command) {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}

const store = new CodeStore(process.env.KIKI_DB_PATH || "kiki.db");

switch (command) {
  case "create": {
    const limit = Number(values.limit);
    if (!arg || !Number.isInteger(limit) || limit < 1) {
      console.error("Usage: create <name> [--limit <questions per day>]");
      process.exit(1);
    }
    const { code, record } = store.create(arg, limit);
    console.log(`Created code #${record.id} for "${record.name}" (${record.dailyLimit} questions/day):\n`);
    console.log(`  ${code}\n`);
    console.log("Send it to them privately. It can't be shown again; revoke and recreate if lost.");
    break;
  }
  case "list": {
    const rows = store.list();
    if (rows.length === 0) console.log("No codes yet. Create one with: npm run codes -- create <name>");
    for (const row of rows) {
      const status = row.revokedAt ? `revoked ${row.revokedAt.slice(0, 10)}` : "active";
      console.log(
        `#${row.id}  ${row.name.padEnd(20)} ${String(row.usedToday).padStart(4)}/${row.dailyLimit} today  ${status}`,
      );
    }
    break;
  }
  case "revoke": {
    if (!arg) {
      console.error("Usage: revoke <id|name>");
      process.exit(1);
    }
    const count = store.revoke(arg);
    console.log(count > 0 ? `Revoked ${count} code(s).` : `No active code matches "${arg}".`);
    break;
  }
  case "usage": {
    const rows = store.usage(Math.max(1, Number(values.days) || 7));
    if (rows.length === 0) console.log("No usage in that period.");
    for (const row of rows) {
      console.log(
        `${row.day}  ${row.name.padEnd(20)} ${String(row.requests).padStart(4)} questions  ` +
          `in=${row.inputTokens} cache_read=${row.cacheReadTokens} cache_write=${row.cacheWriteTokens} ` +
          `out=${row.outputTokens} searches=${row.webSearches}`,
      );
    }
    break;
  }
  default:
    console.error(`Unknown command "${command}".\n\n${USAGE}`);
    process.exit(1);
}

store.close();
