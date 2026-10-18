// Runs what Kiki's action cards and read tools ask for: through the person's Google account when it's
// connected, or by opening a prefilled Google page in the browser when it isn't.
import type { ActionOutcome, ProposedAction, ReadToolName, ToolResult } from "@kiki/shared";
import type { ActionMode, ActionStatus } from "../shared-types.ts";
import { createDraft, createEvent, createTask, listEvents, listTasks, sendEmail } from "./google/api.ts";
import { calendarTemplateUrl, describeAction, gmailComposeUrl } from "./google/format.ts";
import { googleAccount } from "./google/oauth.ts";
import { openExternal } from "./windows.ts";

function timeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The cards that go to Google (or open a Google page); edit cards run in edit.ts, changes and fills in
 * changes.ts, presses in screen.ts.
 */
export type GoogleAction = Exclude<ProposedAction, { kind: "edit" | "changes" | "fill" | "press" }>;

/** Runs one button on a card. Throws with a message for the card when it fails. */
export async function runAction(action: GoogleAction, mode: ActionMode): Promise<ActionStatus> {
  if (mode === "dismiss") return { outcome: "dismissed", message: "Dismissed." };
  if (mode === "open") {
    if (action.kind === "task") throw new Error("Tasks need a connected Google account.");
    openExternal(action.kind === "event" ? calendarTemplateUrl(action, timeZone()) : gmailComposeUrl(action));
    return {
      outcome: "opened",
      message: action.kind === "event" ? "Opened in Google Calendar. Save it there." : "Opened in Gmail. Send it there.",
    };
  }
  if (!googleAccount().connected) throw new Error("Connect Google in Settings first.");
  switch (action.kind) {
    case "event":
      return { outcome: "added", message: "Added to Google Calendar.", ...(await createEvent(action, timeZone())) };
    case "task":
      return { outcome: "added", message: "Added to Google Tasks.", ...(await createTask(action)) };
    case "email":
      if (mode === "send") return { outcome: "sent", message: "Sent.", ...(await sendEmail(action)) };
      return { outcome: "drafted", message: "Saved to Gmail drafts.", ...(await createDraft(action)) };
  }
}

/** What Claude hears about a card the person acted on. */
export function outcomeFor(action: ProposedAction, status: ActionStatus): ActionOutcome {
  const summary =
    status.outcome === "failed"
      ? `Error: ${status.message}`
      : // Where the text went (replaced, inserted or pasted), or how much of it, matters for the next edit.
        action.kind === "edit" || action.kind === "changes" || action.kind === "fill" || action.kind === "press"
        ? `${status.message} ${describeAction(action)}`
        : describeAction(action);
  return { id: action.id, kind: action.kind, outcome: status.outcome, summary: summary.slice(0, 1_000) };
}

/** A local "YYYY-MM-DDTHH:MM" time from Claude, read in this computer's time zone. */
function localDate(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(value)) return null;
  const date = new Date(value.length === 10 ? `${value}T00:00` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Runs a read tool for Claude. Errors come back as error results, never thrown. */
export async function runReadTool(id: string, name: ReadToolName, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    if (name === "list_calendar_events") {
      const min = localDate(input["time_min"]);
      const max = localDate(input["time_max"]);
      if (!min || !max || max <= min) {
        return { id, content: "time_min and time_max must be local times, with time_max after time_min.", isError: true };
      }
      const query = typeof input["query"] === "string" ? input["query"].slice(0, 200) : undefined;
      return { id, content: await listEvents(min, max, timeZone(), query) };
    }
    return { id, content: await listTasks(input["include_completed"] === true) };
  } catch (error) {
    return { id, content: `Couldn't read the person's ${name === "list_tasks" ? "tasks" : "calendar"}: ${errorMessage(error)}`, isError: true };
  }
}
