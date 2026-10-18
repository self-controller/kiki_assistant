// Calendar, Tasks and Gmail over their REST APIs, with the person's own token.
import type { ProposedAction } from "@kiki/shared";
import { getGoogleTokens, setGoogleTokens } from "../settings.ts";
import { accessToken, GoogleAuthError } from "./oauth.ts";
import { buildMime, summarizeEvents, summarizeTasks, toEventResource, toTaskResource } from "./format.ts";

type EventAction = Extract<ProposedAction, { kind: "event" }>;
type TaskAction = Extract<ProposedAction, { kind: "task" }>;
type EmailAction = Extract<ProposedAction, { kind: "email" }>;

const CALENDAR = "https://www.googleapis.com/calendar/v3";
const TASKS = "https://tasks.googleapis.com/tasks/v1";
const GMAIL = "https://gmail.googleapis.com/gmail/v1";

export class GoogleApiError extends Error {}

async function google<T>(url: string, init: { method?: string; body?: unknown } = {}, retried = false): Promise<T> {
  const token = await accessToken();
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401 && !retried) {
    // The saved access token went stale early; refresh and try once more.
    const tokens = getGoogleTokens();
    if (tokens) setGoogleTokens({ ...tokens, accessToken: undefined, expiresAt: 0 });
    return google(url, init, true);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string; status?: string } } | null;
    if (response.status === 401) throw new GoogleAuthError("Google rejected Kiki's access. Reconnect Google in Settings.");
    if (response.status === 403 && /scope|permission/i.test(body?.error?.message ?? "")) {
      throw new GoogleAuthError("Kiki doesn't have permission for this. Reconnect Google in Settings and allow it.");
    }
    throw new GoogleApiError(body?.error?.message ?? `Google returned HTTP ${response.status}.`);
  }
  return (await response.json()) as T;
}

export async function createEvent(action: EventAction, timeZone: string): Promise<{ link?: string }> {
  // Invites go out only for attendees the person saw on the card and approved.
  const query = action.attendees?.length ? "?sendUpdates=all" : "";
  const event = await google<{ htmlLink?: string }>(`${CALENDAR}/calendars/primary/events${query}`, {
    method: "POST",
    body: toEventResource(action, timeZone),
  });
  return event.htmlLink ? { link: event.htmlLink } : {};
}

export async function listEvents(timeMin: Date, timeMax: Date, timeZone: string, query?: string): Promise<string> {
  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
    timeZone,
  });
  if (query) params.set("q", query);
  const body = await google<{ items?: Parameters<typeof summarizeEvents>[0] }>(
    `${CALENDAR}/calendars/primary/events?${params}`,
  );
  return summarizeEvents(body.items ?? []);
}

export async function createTask(action: TaskAction): Promise<{ link?: string }> {
  await google(`${TASKS}/lists/%40default/tasks`, { method: "POST", body: toTaskResource(action) });
  return { link: "https://tasks.google.com/" };
}

export async function listTasks(includeCompleted: boolean): Promise<string> {
  const params = new URLSearchParams({
    maxResults: "100",
    showCompleted: String(includeCompleted),
    showHidden: String(includeCompleted),
  });
  const body = await google<{ items?: Parameters<typeof summarizeTasks>[0] }>(`${TASKS}/lists/%40default/tasks?${params}`);
  return summarizeTasks(body.items ?? []);
}

function gmailLink(fragment: string): string {
  const email = getGoogleTokens()?.email;
  return `https://mail.google.com/mail/${email ? `?authuser=${encodeURIComponent(email)}` : ""}#${fragment}`;
}

export async function createDraft(action: EmailAction): Promise<{ link?: string }> {
  const draft = await google<{ message?: { id?: string } }>(`${GMAIL}/users/me/drafts`, {
    method: "POST",
    body: { message: { raw: buildMime(action) } },
  });
  return { link: gmailLink(draft.message?.id ? `drafts?compose=${draft.message.id}` : "drafts") };
}

export async function sendEmail(action: EmailAction): Promise<{ link?: string }> {
  if (action.to.length === 0) throw new GoogleApiError("Add a recipient first.");
  const sent = await google<{ id?: string }>(`${GMAIL}/users/me/messages/send`, {
    method: "POST",
    body: { raw: buildMime(action) },
  });
  return { link: gmailLink(sent.id ? `sent/${sent.id}` : "sent") };
}
