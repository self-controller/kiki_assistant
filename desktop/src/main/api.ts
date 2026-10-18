import { LIMITS, type ErrorResponse, type KikiEvent, type MeResponse, type ToolResult } from "@kiki/shared";
import { EventSourceParserStream } from "eventsource-parser/stream";
import type { TestResult } from "../shared-types.ts";
import { getAccessCode, getSettings } from "./settings.ts";

type ErrorEvent = Extract<KikiEvent, { type: "error" }>;

function connection(): { base: string; code: string } | null {
  const { serverUrl } = getSettings();
  const code = getAccessCode();
  return serverUrl && code ? { base: serverUrl.replace(/\/+$/, ""), code } : null;
}

const NOT_CONFIGURED: ErrorEvent = {
  type: "error",
  code: "unauthorized",
  message: "Kiki isn't set up yet. Add the server address and your access code in Settings.",
};

function unreachable(base: string): ErrorEvent {
  return {
    type: "error",
    code: "upstream",
    message: `Couldn't reach the Kiki server at ${new URL(base).host}. Check your connection.`,
  };
}

async function errorFromResponse(response: Response): Promise<ErrorEvent> {
  try {
    const body = (await response.json()) as ErrorResponse;
    if (body.error?.code) return { type: "error", ...body.error };
  } catch {
    // Not one of our JSON errors (e.g. a proxy's HTML page).
  }
  return { type: "error", code: "upstream", message: `The Kiki server returned HTTP ${response.status}.` };
}

/** POSTs `body` and forwards each server-sent event to `onEvent`. Never throws. */
export async function streamRequest(
  path: string,
  body: unknown,
  onEvent: (event: KikiEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const conn = connection();
  if (!conn) return onEvent(NOT_CONFIGURED);

  let response: Response;
  try {
    response = await fetch(conn.base + path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${conn.code}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    if (!signal.aborted) onEvent(unreachable(conn.base));
    return;
  }
  if (!response.ok || !response.body) return onEvent(await errorFromResponse(response));

  let finished = false;
  try {
    const messages = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream());
    for await (const message of messages) {
      const event = JSON.parse(message.data) as KikiEvent;
      if (event.type === "done" || event.type === "error") finished = true;
      onEvent(event);
    }
  } catch {
    // Falls through to the dropped-connection check below.
  }
  if (!finished && !signal.aborted) {
    onEvent({ type: "error", code: "upstream", message: "The connection to the Kiki server dropped. Try again." });
  }
}

export async function fetchMe(): Promise<TestResult> {
  const conn = connection();
  if (!conn) return { ok: false, message: NOT_CONFIGURED.message };
  try {
    const response = await fetch(`${conn.base}/v1/me`, {
      headers: { authorization: `Bearer ${conn.code}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false, message: (await errorFromResponse(response)).message };
    const me = (await response.json()) as MeResponse;
    return { ok: true, me };
  } catch {
    return { ok: false, message: unreachable(conn.base).message };
  }
}

/** Answers a streaming turn's `tool_call`. The turn carries on (or times out) either way, so failures are ignored. */
export async function postToolResults(conversationId: string, results: ToolResult[]): Promise<void> {
  const conn = connection();
  if (!conn) return;
  const body = {
    results: results.map((result) => ({
      ...result,
      content: result.content.slice(0, LIMITS.toolResultChars),
      ...(result.screen?.text ? { screen: { ...result.screen, text: result.screen.text.slice(0, LIMITS.screenTextChars) } } : {}),
    })),
  };
  try {
    await fetch(`${conn.base}/v1/conversations/${encodeURIComponent(conversationId)}/tool-results`, {
      method: "POST",
      headers: { authorization: `Bearer ${conn.code}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // The server gives Claude an error result after its timeout.
  }
}
