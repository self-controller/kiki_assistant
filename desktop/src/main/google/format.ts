// Pure helpers for Kiki's Google connectors: request bodies, summaries for Claude, browser fallbacks, and
// the PKCE pair for signing in. Nothing here touches Electron or the network.
import { createHash, randomBytes } from "node:crypto";
import { LIMITS, type Clock, type FieldValue, type ProposedAction } from "@kiki/shared";

type EventAction = Extract<ProposedAction, { kind: "event" }>;
type TaskAction = Extract<ProposedAction, { kind: "task" }>;
type EmailAction = Extract<ProposedAction, { kind: "email" }>;

export function base64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

/** A PKCE code verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** The email in an OpenID id_token, which came straight from Google's token endpoint over TLS. */
export function emailFromIdToken(idToken: string | undefined): string | undefined {
  const payload = idToken?.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `date` as local ISO 8601 with its offset, e.g. "2026-10-16T14:03:00-04:00". */
export function localIso(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export function currentClock(now = new Date()): Clock {
  return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", now: localIso(now) };
}

/** The day after a "YYYY-MM-DD" date. */
export function nextDay(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

/** A local "YYYY-MM-DDTHH:MM" time with seconds, as Calendar's dateTime wants with a separate time zone. */
function withSeconds(local: string): string {
  return local.length === 16 ? `${local}:00` : local;
}

/** A Calendar API event. All-day events end on the day after their last day. */
export function toEventResource(action: EventAction, timeZone: string): Record<string, unknown> {
  const when = action.allDay
    ? { start: { date: action.start.slice(0, 10) }, end: { date: nextDay(action.end.slice(0, 10)) } }
    : {
        start: { dateTime: withSeconds(action.start), timeZone },
        end: { dateTime: withSeconds(action.end), timeZone },
      };
  return {
    summary: action.title,
    ...when,
    ...(action.location ? { location: action.location } : {}),
    ...(action.description ? { description: action.description } : {}),
    ...(action.attendees?.length ? { attendees: action.attendees.map((email) => ({ email })) } : {}),
  };
}

/** A Tasks API task. Tasks keep only the date of `due`. */
export function toTaskResource(action: TaskAction): Record<string, unknown> {
  return {
    title: action.title,
    ...(action.notes ? { notes: action.notes } : {}),
    ...(action.due ? { due: `${action.due}T00:00:00.000Z` } : {}),
  };
}

/** Header values can't carry line breaks (they'd add headers). */
function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** RFC 2047 encoding for a header with non-ASCII text. */
function encodeWord(value: string): string {
  const clean = headerValue(value);
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

/** The email as an RFC 2822 message, base64url-encoded for Gmail's `raw` field. */
export function buildMime(action: EmailAction): string {
  const body = Buffer.from(action.body.replace(/\r?\n/g, "\r\n"), "utf8")
    .toString("base64")
    .replace(/.{76}/g, "$&\r\n");
  const headers = [
    action.to.length ? `To: ${headerValue(action.to.join(", "))}` : null,
    action.cc?.length ? `Cc: ${headerValue(action.cc.join(", "))}` : null,
    `Subject: ${encodeWord(action.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ].filter((line): line is string => line !== null);
  return base64url(`${headers.join("\r\n")}\r\n\r\n${body}`);
}

/** Google Calendar's "add event" page, prefilled; the person saves it there. */
export function calendarTemplateUrl(action: EventAction, timeZone: string): string {
  const compact = (value: string) => value.replace(/[-:]/g, "");
  const dates = action.allDay
    ? `${compact(action.start.slice(0, 10))}/${compact(nextDay(action.end.slice(0, 10)))}`
    : `${compact(withSeconds(action.start))}/${compact(withSeconds(action.end))}`;
  const params = new URLSearchParams({ action: "TEMPLATE", text: action.title, dates });
  if (!action.allDay) params.set("ctz", timeZone);
  if (action.description) params.set("details", action.description);
  if (action.location) params.set("location", action.location);
  if (action.attendees?.length) params.set("add", action.attendees.join(","));
  return `https://calendar.google.com/calendar/render?${params}`;
}

/** Gmail's compose window, prefilled; the person sends it there. */
export function gmailComposeUrl(action: EmailAction): string {
  const params = new URLSearchParams({ view: "cm", fs: "1", to: action.to.join(","), su: action.subject, body: action.body });
  if (action.cc?.length) params.set("cc", action.cc.join(","));
  return `https://mail.google.com/mail/?${params}`;
}

/** "Tue 2026-10-20 13:00" from a local ISO time (or just the date). */
export function describeTime(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/.exec(value);
  if (!match) return value;
  const [, year, month, day, time] = match;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
    new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay()
  ];
  return `${weekday} ${year}-${month}-${day}${time ? ` ${time}` : ""}`;
}

/** A one-line description of an action, for outcomes Claude reads. */
export function describeAction(action: ProposedAction): string {
  switch (action.kind) {
    case "event": {
      const end = action.allDay
        ? action.end.slice(0, 10) === action.start.slice(0, 10)
          ? ""
          : ` to ${describeTime(action.end.slice(0, 10))}`
        : `–${action.end.slice(0, 10) === action.start.slice(0, 10) ? action.end.slice(11, 16) : describeTime(action.end)}`;
      const where = action.location ? ` at ${action.location}` : "";
      return `"${action.title}", ${describeTime(action.allDay ? action.start.slice(0, 10) : action.start)}${end}${where}.`;
    }
    case "task":
      return `"${action.title}"${action.due ? `, due ${describeTime(action.due)}` : ""}.`;
    case "email":
      return `"${action.subject}" to ${action.to.length ? action.to.join(", ") : "no one yet"}.`;
    case "edit": {
      const preview = action.text.length > 200 ? `${action.text.slice(0, 200)}…` : action.text;
      return `The text "${preview}" (${action.text.length} characters).`;
    }
    case "changes": {
      const list = action.changes.map((change) => `${clip(change.find)} → ${clip(change.replace)}`).join("; ");
      return `${plural(action.changes.length, "change")}: ${list.length > 600 ? `${list.slice(0, 600)}…` : list}.`;
    }
    case "fill": {
      const list = action.fields
        .map((item) => `${item.field} = ${typeof item.value === "boolean" ? (item.value ? "checked" : "unchecked") : clip(item.value)}`)
        .join("; ");
      return `${plural(action.fields.length, "field")}: ${list.length > 600 ? `${list.slice(0, 600)}…` : list}.`;
    }
    case "press":
      return `${action.presses.map((press) => `${press.control}${press.label ? ` (${clip(press.label)})` : ""}`).join(", ")}.`;
  }
}

/** A quoted, shortened piece of text for a one-line description. */
function clip(text: string, max = 60): string {
  return JSON.stringify(text.length > max ? `${text.slice(0, max)}…` : text);
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

interface CalendarEvent {
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  status?: string;
}

/** Calendar events as short lines for Claude. */
export function summarizeEvents(items: CalendarEvent[]): string {
  const events = items.filter((event) => event.status !== "cancelled");
  if (events.length === 0) return "No events in that time.";
  return events
    .map((event) => {
      const start = event.start?.dateTime ?? event.start?.date ?? "?";
      const end = event.end?.dateTime ?? event.end?.date ?? "";
      const allDay = !event.start?.dateTime;
      const span = allDay
        ? `${describeTime(start)} (all day)`
        : `${describeTime(start)}–${end.slice(0, 10) === start.slice(0, 10) ? end.slice(11, 16) : describeTime(end)}`;
      return `- ${span}: ${event.summary || "(no title)"}${event.location ? ` @ ${event.location}` : ""}`;
    })
    .join("\n");
}

interface GoogleTask {
  title?: string;
  due?: string;
  status?: string;
  notes?: string;
}

/** Tasks as short lines for Claude. */
export function summarizeTasks(items: GoogleTask[]): string {
  const tasks = items.filter((task) => task.title?.trim());
  if (tasks.length === 0) return "No tasks.";
  return tasks
    .map((task) => {
      const done = task.status === "completed" ? "x" : " ";
      const due = task.due ? ` (due ${describeTime(task.due.slice(0, 10))})` : "";
      return `- [${done}] ${task.title}${due}`;
    })
    .join("\n");
}

const strings = (value: unknown, max: number): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()).slice(0, max)
    : undefined;

const str = (value: unknown, fallback: string, max = 50_000): string =>
  typeof value === "string" ? value.slice(0, max) : fallback;

const optionalStr = (value: unknown, fallback: string | undefined, max = 50_000): string | undefined => {
  const next = typeof value === "string" ? value.trim().slice(0, max) : fallback;
  return next ? next : undefined;
};

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The card's action with the person's edits applied. Only the fields that kind of action has are taken,
 * and the id and kind never change. Returns an error for a time that doesn't parse.
 */
export function applyEdits(original: ProposedAction, edited: unknown): ProposedAction | { error: string } {
  const e = (edited && typeof edited === "object" ? edited : {}) as Record<string, unknown>;
  switch (original.kind) {
    case "event": {
      const allDay = typeof e["allDay"] === "boolean" ? e["allDay"] : Boolean(original.allDay);
      const start = str(e["start"], original.start, 20);
      const end = str(e["end"], original.end, 20);
      const format = allDay ? DATE : LOCAL_TIME;
      if (!format.test(start) || !format.test(end)) return { error: "Check the start and end times." };
      if (end < start) return { error: "The event ends before it starts." };
      const attendees = strings(e["attendees"], 50) ?? original.attendees;
      const location = optionalStr(e["location"], original.location, 500);
      const description = optionalStr(e["description"], original.description);
      return {
        id: original.id,
        kind: "event",
        title: str(e["title"], original.title, 300).trim() || original.title,
        start,
        end,
        ...(allDay ? { allDay: true } : {}),
        ...(location ? { location } : {}),
        ...(description ? { description } : {}),
        ...(attendees?.length ? { attendees } : {}),
      };
    }
    case "task": {
      const due = optionalStr(e["due"], original.due, 10);
      if (due && !DATE.test(due)) return { error: "Check the due date." };
      const notes = optionalStr(e["notes"], original.notes);
      return {
        id: original.id,
        kind: "task",
        title: str(e["title"], original.title, 1_000).trim() || original.title,
        ...(notes ? { notes } : {}),
        ...(due ? { due } : {}),
      };
    }
    case "email": {
      const to = strings(e["to"], 50) ?? original.to;
      const cc = strings(e["cc"], 50) ?? original.cc;
      const bad = [...to, ...(cc ?? [])].find((address) => !/^[^\s@<>,]+@[^\s@<>,]+$/.test(address));
      if (bad) return { error: `"${bad}" isn't an email address.` };
      return {
        id: original.id,
        kind: "email",
        to,
        ...(cc?.length ? { cc } : {}),
        subject: str(e["subject"], original.subject, 500),
        body: str(e["body"], original.body),
        ...(original.send ? { send: true } : {}),
      };
    }
    case "edit": {
      // Untrimmed: indentation and line breaks are part of it.
      const text = str(e["text"], original.text, LIMITS.editChars);
      if (!text.trim()) return { error: "There's no text to put in." };
      return { id: original.id, kind: "edit", text };
    }
    case "changes": {
      // The person can untick changes and edit what each one becomes, but not what it finds.
      const edits: unknown[] = Array.isArray(e["changes"]) ? (e["changes"] as unknown[]) : original.changes;
      const kept = original.changes.flatMap((change) => {
        const match = edits.find((item) => item && typeof item === "object" && (item as Record<string, unknown>)["find"] === change.find);
        if (!match) return [];
        return [{ find: change.find, replace: str((match as Record<string, unknown>)["replace"], change.replace, LIMITS.editChars) }];
      });
      if (kept.length === 0) return { error: "Tick at least one change." };
      return { id: original.id, kind: "changes", changes: kept };
    }
    case "fill": {
      const edits: unknown[] = Array.isArray(e["fields"]) ? (e["fields"] as unknown[]) : original.fields;
      const kept = original.fields.flatMap((item): FieldValue[] => {
        const match = edits.find((next) => next && typeof next === "object" && (next as Record<string, unknown>)["field"] === item.field);
        if (!match) return [];
        const value = (match as Record<string, unknown>)["value"];
        // A check box stays a check box, and text stays text.
        if (typeof item.value === "boolean") return [{ field: item.field, value: typeof value === "boolean" ? value : item.value }];
        return [{ field: item.field, value: str(value, item.value, LIMITS.fillValueChars) }];
      });
      if (kept.length === 0) return { error: "Tick at least one field." };
      return { id: original.id, kind: "fill", fields: kept };
    }
    case "press": {
      // The person can only untick what's pressed.
      const edits: unknown[] = Array.isArray(e["presses"]) ? (e["presses"] as unknown[]) : original.presses;
      const ticked = new Set(edits.map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>)["control"] : undefined)));
      const kept = original.presses.filter((press) => ticked.has(press.control));
      if (kept.length === 0) return { error: "Tick at least one." };
      return { id: original.id, kind: "press", presses: kept };
    }
  }
}
