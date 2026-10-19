import type Anthropic from "@anthropic-ai/sdk";
import {
  ACTION_OUTCOMES,
  CHANGES_MODES,
  EDIT_MODES,
  FIELD_KINDS,
  EFFORT_LEVELS,
  LIMITS,
  MODEL_CHOICES,
  type ErrorCode,
  type ErrorResponse,
  type KikiEvent,
  type FollowUpRequest,
  type MeResponse,
  type QuestionOptions,
  type AppToolName,
  type StartConversationRequest,
  type ToolAccess,
  type ToolResult,
  type TranscribeResponse,
} from "@kiki/shared";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { classifyError, MODEL_IDS, runTurn, type ClaudeConfig } from "./claude.ts";
import type { CodeRecord, CodeStore } from "./codes.ts";
import type { Conversation, ConversationStore } from "./conversations.ts";
import { buildConversationStart, buildFollowUpMessage, withoutScreenshots } from "./prompt.ts";
import { audioExtension, SttError, transcribe, type SttConfig } from "./stt.ts";

export interface AppDeps {
  codes: CodeStore;
  conversations: ConversationStore;
  client: Anthropic;
  config: ClaudeConfig;
  /** Speech-to-text for voice questions; voice is off without it. */
  stt?: SttConfig | null;
  /** For tests: replaces fetch for transcription requests. */
  sttFetch?: typeof fetch;
  maxConcurrentPerCode?: number;
  heartbeatMs?: number;
  /** How long a turn waits for the app to run a read tool. */
  toolTimeoutMs?: number;
  log?: (line: string) => void;
}

type Env = { Variables: { code: CodeRecord } };

const screenshotSchema = z.object({
  mediaType: z.enum(["image/jpeg", "image/png"]),
  data: z
    .string()
    .min(1)
    .max(LIMITS.screenshotBase64Chars)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be base64"),
  area: z.enum(["screen", "pointer"]).optional(),
});

const imagesSchema = z.array(screenshotSchema).max(LIMITS.imagesPerQuestion).optional();

const optionsSchema = z
  .object({
    search: z.boolean().optional(),
    model: z.enum(MODEL_CHOICES).optional(),
    effort: z.enum(EFFORT_LEVELS).optional(),
    think: z.boolean().optional(),
  })
  .optional();

const toolsSchema = z
  .object({
    actions: z.boolean().optional(),
    calendarRead: z.boolean().optional(),
    tasksRead: z.boolean().optional(),
    edit: z.enum(EDIT_MODES).optional(),
    changes: z.enum(CHANGES_MODES).optional(),
    fill: z.boolean().optional(),
    open: z.boolean().optional(),
    screen: z.boolean().optional(),
    press: z.boolean().optional(),
    click: z.boolean().optional(),
  })
  .optional();

const clockSchema = z
  .object({
    timeZone: z.string().min(1).max(100),
    now: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/, "must be ISO 8601"),
  })
  .optional();

const outcomesSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(100),
      kind: z.enum(["event", "task", "email", "edit", "changes", "fill", "press"]),
      outcome: z.enum(ACTION_OUTCOMES),
      summary: z.string().max(1_000),
    }),
  )
  .max(LIMITS.actionOutcomes)
  .optional();

/** What every question can carry besides its text and images. */
const questionExtras = { tools: toolsSchema, clock: clockSchema, actionOutcomes: outcomesSchema };

const fieldsSchema = z
  .array(
    z.object({
      id: z.string().regex(/^f\d{1,3}$/),
      label: z.string().max(LIMITS.fieldLabelChars),
      kind: z.enum(FIELD_KINDS),
      value: z.string().max(LIMITS.fieldValueChars).optional(),
      checked: z.boolean().optional(),
    }),
  )
  .max(LIMITS.formFields)
  .optional();

const toolResultsSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        content: z.string().max(LIMITS.toolResultChars),
        isError: z.boolean().optional(),
        screen: z
          .object({
            windowTitle: z.string().max(LIMITS.windowTitleChars).optional(),
            url: z.string().max(LIMITS.urlChars).optional(),
            text: z.string().max(LIMITS.screenTextChars).optional(),
            fields: fieldsSchema,
            screenshot: screenshotSchema.optional(),
            atEnd: z.boolean().optional(),
          })
          .optional(),
      }),
    )
    .min(1)
    .max(10),
});

const startSchema = z.object({
  question: z.string().trim().min(1).max(LIMITS.questionChars),
  selection: z.string().max(LIMITS.selectionChars),
  context: z.object({
    appName: z.string().max(LIMITS.appNameChars).optional(),
    windowTitle: z.string().max(LIMITS.windowTitleChars).optional(),
    url: z.string().max(LIMITS.urlChars).optional(),
    text: z.string().max(LIMITS.contextTextChars).optional(),
    screenshot: screenshotSchema.optional(),
    editable: z
      .object({ text: z.string().max(LIMITS.editableChars), truncated: z.boolean().optional() })
      .optional(),
    fields: fieldsSchema,
  }),
  images: imagesSchema,
  options: optionsSchema,
  earlier: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(LIMITS.questionChars),
        answer: z.string().trim().min(1).max(LIMITS.earlierAnswerChars),
      }),
    )
    .max(LIMITS.earlierTurns)
    .optional(),
  personality: z.string().trim().max(LIMITS.personalityChars).optional(),
  ...questionExtras,
});

const followUpSchema = z.object({
  question: z.string().trim().min(1).max(LIMITS.questionChars),
  images: imagesSchema,
  options: optionsSchema,
  ...questionExtras,
});

function errorJson(
  c: Context,
  status: 400 | 401 | 404 | 409 | 413 | 415 | 429 | 501 | 502,
  code: ErrorCode,
  message: string,
) {
  const body: ErrorResponse = { error: { code, message } };
  return c.json(body, status);
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export function createApp(deps: AppDeps) {
  const { codes, conversations, client, config } = deps;
  const stt = deps.stt ?? null;
  const maxConcurrent = deps.maxConcurrentPerCode ?? 2;
  const heartbeatMs = deps.heartbeatMs ?? 15_000;
  const toolTimeoutMs = deps.toolTimeoutMs ?? 30_000;
  const log = deps.log ?? ((line: string) => console.log(line));
  const activeByCode = new Map<number, number>();

  const app = new Hono<Env>();

  app.get("/healthz", (c) => c.text("ok"));

  app.use("/v1/*", async (c, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
    const record = match?.[1] ? codes.verify(match[1]) : null;
    if (!record) {
      return errorJson(c, 401, "unauthorized", "This access code is not valid or has been revoked.");
    }
    c.set("code", record);
    await next();
  });

  const limitBody = bodyLimit({
    maxSize: LIMITS.bodyBytes,
    onError: (c) => errorJson(c, 413, "invalid", "The request is too large."),
  });

  app.get("/v1/me", (c) => {
    const record = c.get("code");
    const body: MeResponse = {
      name: record.name,
      usedToday: codes.usedToday(record.id),
      dailyLimit: record.dailyLimit,
      features: { voice: stt !== null, actions: true },
    };
    return c.json(body);
  });

  /** Checks concurrency and the daily limit; returns an error response or null. */
  function admit(c: Context<Env>, record: CodeRecord) {
    if ((activeByCode.get(record.id) ?? 0) >= maxConcurrent) {
      return errorJson(c, 429, "busy", "Too many questions at once. Wait for an answer to finish.");
    }
    if (!codes.tryConsume(record)) {
      return errorJson(
        c,
        429,
        "limit",
        `You've reached today's limit of ${record.dailyLimit} questions. It resets at midnight UTC.`,
      );
    }
    return null;
  }

  /** Streams one Claude turn for `conversation`, whose history already ends with the new user message. */
  function streamTurn(
    c: Context<Env>,
    record: CodeRecord,
    conversation: Conversation,
    isFirstTurn: boolean,
    options: QuestionOptions | undefined,
    tools: ToolAccess | undefined,
  ) {
    // The model can change between turns: the API skips earlier thinking the new model can't read.
    const model = options?.model ? MODEL_IDS[options.model] : config.model;
    const effort = options?.effort ?? (options?.think ? config.thinkEffort : config.effort);
    conversation.busy = true;
    conversation.userTurns += 1;
    activeByCode.set(record.id, (activeByCode.get(record.id) ?? 0) + 1);
    const startedAt = Date.now();

    // Undo the user message so the history stays valid (and append-only) for the next turn.
    const rollback = () => {
      conversation.messages.pop();
      conversation.userTurns -= 1;
      if (isFirstTurn) conversations.delete(conversation.id);
    };

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());

      // Waits for the app to POST this read tool's result, or gives Claude an error after a while.
      const callTool = (id: string, _name: AppToolName, _input: Record<string, unknown>) =>
        new Promise<ToolResult>((resolve) => {
          const finish = (result: ToolResult) => {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", onAbort);
            conversation.pendingTools.delete(id);
            resolve(result);
          };
          const onAbort = () => finish({ id, content: "Cancelled.", isError: true });
          const timer = setTimeout(
            () => finish({ id, content: "The Kiki app didn't answer in time.", isError: true }),
            toolTimeoutMs,
          );
          controller.signal.addEventListener("abort", onAbort);
          conversation.pendingTools.set(id, finish);
        });

      let writes = Promise.resolve();
      const send = (event: KikiEvent) => {
        writes = writes
          .then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }))
          .catch(() => {});
      };
      const heartbeat = setInterval(() => {
        writes = writes.then(() => stream.write(": ping\n\n")).then(() => {}, () => {});
      }, heartbeatMs);

      send({ type: "conversation", id: conversation.id });
      try {
        const result = await runTurn({
          client,
          config,
          history: conversation.messages,
          emit: send,
          signal: controller.signal,
          model,
          effort,
          tools,
          personality: conversation.personality,
          callTool,
        });
        codes.recordUsage(record, result.usage);
        const u = result.usage;
        const stats = `${model} effort=${effort} in=${u.inputTokens} cache_read=${u.cacheReadTokens} out=${u.outputTokens} searches=${u.webSearches} ${Date.now() - startedAt}ms`;
        if (result.kind === "refused") {
          rollback();
          log(`[kiki] ${record.name}: refused ${stats}`);
          send({ type: "error", code: "refused", message: "Kiki can't help with this one." });
        } else {
          // Screenshots from scrolling stay with the turn that took them; follow-ups don't send them again.
          conversation.messages.push(...withoutScreenshots(result.messages));
          log(`[kiki] ${record.name}: ${result.stopReason} ${stats}`);
          if (result.sources.length > 0) send({ type: "sources", items: result.sources });
          send({ type: "done", stopReason: result.stopReason });
        }
      } catch (error) {
        const info = classifyError(error);
        rollback();
        if (info.refundable) codes.refund(record);
        if (info.log) console.error(`[kiki] ${record.name}: Claude request failed`, error);
        if (!info.aborted) send({ type: "error", code: info.code, message: info.message });
      } finally {
        clearInterval(heartbeat);
        conversation.busy = false;
        conversation.lastUsed = conversations.now();
        activeByCode.set(record.id, (activeByCode.get(record.id) ?? 1) - 1);
        await writes;
      }
    });
  }

  app.post("/v1/conversations", limitBody, async (c) => {
    const record = c.get("code");
    const parsed = startSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return errorJson(c, 400, "invalid", `Invalid request: ${z.prettifyError(parsed.error)}`);
    }
    const rejected = admit(c, record);
    if (rejected) return rejected;

    const request: StartConversationRequest = parsed.data;
    const conversation = conversations.create(record.id);
    if (request.personality) conversation.personality = request.personality;
    const today = new Date(conversations.now()).toISOString().slice(0, 10);
    conversation.messages.push(...buildConversationStart(request, today));
    // Earlier turns it carries over count toward the conversation's length.
    conversation.userTurns += request.earlier?.length ?? 0;
    return streamTurn(c, record, conversation, true, request.options, request.tools);
  });

  app.post("/v1/conversations/:id/messages", limitBody, async (c) => {
    const record = c.get("code");
    const parsed = followUpSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return errorJson(c, 400, "invalid", `Invalid request: ${z.prettifyError(parsed.error)}`);
    }
    const conversation = conversations.get(c.req.param("id"), record.id);
    if (!conversation) {
      return errorJson(c, 404, "expired", "This conversation has expired. Ask again to start a new one.");
    }
    if (conversation.busy) {
      return errorJson(c, 409, "busy", "Kiki is still answering the previous question.");
    }
    if (conversation.userTurns >= conversations.maxUserTurns) {
      return errorJson(c, 409, "limit", "This conversation is getting long. Highlight the text again to start fresh.");
    }
    const rejected = admit(c, record);
    if (rejected) return rejected;

    const request: FollowUpRequest = parsed.data;
    conversation.messages.push(buildFollowUpMessage(request));
    return streamTurn(c, record, conversation, false, request.options, request.tools);
  });

  // Results of read tools the app ran during a streaming turn. Allowed while busy; that's when they come.
  app.post("/v1/conversations/:id/tool-results", limitBody, async (c) => {
    const record = c.get("code");
    const parsed = toolResultsSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return errorJson(c, 400, "invalid", `Invalid request: ${z.prettifyError(parsed.error)}`);
    }
    const conversation = conversations.get(c.req.param("id"), record.id);
    const waiting = parsed.data.results.filter((result) => conversation?.pendingTools.has(result.id));
    if (!conversation || waiting.length === 0) {
      return errorJson(c, 404, "expired", "Kiki isn't waiting for these results anymore.");
    }
    for (const result of waiting) conversation.pendingTools.get(result.id)?.(result);
    return c.json({ accepted: waiting.length });
  });

  const limitAudio = bodyLimit({
    maxSize: LIMITS.audioBytes,
    onError: (c) => errorJson(c, 413, "invalid", "That recording is too long."),
  });

  // Voice questions: the raw recording in, its transcript out. Doesn't count as a question.
  app.post("/v1/transcribe", limitAudio, async (c) => {
    const record = c.get("code");
    if (!stt) return errorJson(c, 501, "invalid", "Voice questions aren't set up on this Kiki server.");
    const mimeType = c.req.header("content-type") ?? "";
    if (!audioExtension(mimeType)) return errorJson(c, 415, "invalid", "Unsupported audio format.");
    if ((activeByCode.get(record.id) ?? 0) >= maxConcurrent) {
      return errorJson(c, 429, "busy", "Too many requests at once. Try again in a moment.");
    }
    activeByCode.set(record.id, (activeByCode.get(record.id) ?? 0) + 1);
    try {
      const audio = await c.req.arrayBuffer();
      if (audio.byteLength === 0) return errorJson(c, 400, "invalid", "The recording was empty.");
      const text = await transcribe(stt, audio, mimeType, { fetch: deps.sttFetch });
      const body: TranscribeResponse = { text };
      return c.json(body);
    } catch (error) {
      if (!(error instanceof SttError)) console.error(`[kiki] ${record.name}: transcription failed`, error);
      const message = error instanceof SttError ? error.message : "Transcription failed.";
      return errorJson(c, 502, "upstream", message);
    } finally {
      activeByCode.set(record.id, (activeByCode.get(record.id) ?? 1) - 1);
    }
  });

  return app;
}
