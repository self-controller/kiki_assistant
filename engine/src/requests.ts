// The shape every question must have before it reaches a model: the app builds them, and these checks keep a
// bug there (an oversized screenshot, a field over its limit) from turning into a model's error.
import {
  ACTION_OUTCOMES,
  CHANGES_MODES,
  CUSTOM_MODEL_PATTERN,
  EDIT_MODES,
  EFFORT_LEVELS,
  FIELD_KINDS,
  LIMITS,
  MODEL_CHOICES,
  type CustomModelChoice,
} from "@kiki/shared";
import { z } from "zod";

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

const filesSchema = z
  .array(
    z.object({
      name: z.string().trim().min(1).max(LIMITS.fileNameChars),
      text: z.string().max(LIMITS.fileChars),
      truncated: z.boolean().optional(),
    }),
  )
  .max(LIMITS.filesPerQuestion)
  .optional();

const optionsSchema = z
  .object({
    search: z.boolean().optional(),
    model: z
      .union([z.enum(MODEL_CHOICES), z.string().regex(CUSTOM_MODEL_PATTERN).transform((model) => model as CustomModelChoice)])
      .optional(),
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
    browse: z.boolean().optional(),
    windows: z.boolean().optional(),
    act: z.boolean().optional(),
    coordinates: z.boolean().optional(),
    autoApprove: z.boolean().optional(),
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

export const toolResultsSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(200),
      content: z.string().max(LIMITS.toolResultChars),
      isError: z.boolean().optional(),
      applied: z.boolean().optional(),
      screen: z
        .object({
          windowTitle: z.string().max(LIMITS.windowTitleChars).optional(),
          url: z.string().max(LIMITS.urlChars).optional(),
          text: z.string().max(LIMITS.screenTextChars).optional(),
          fields: fieldsSchema,
          screenshot: screenshotSchema.optional(),
          atEnd: z.boolean().optional(),
          loading: z.boolean().optional(),
          target: z
            .object({ kind: z.enum(["browser", "window"]), title: z.string().max(LIMITS.windowTitleChars).optional() })
            .optional(),
          screenshotSize: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
        })
        .optional(),
    }),
  )
  .min(1)
  .max(10);

const contextSchema = z.object({
  appName: z.string().max(LIMITS.appNameChars).optional(),
  windowTitle: z.string().max(LIMITS.windowTitleChars).optional(),
  url: z.string().max(LIMITS.urlChars).optional(),
  text: z.string().max(LIMITS.contextTextChars).optional(),
  screenshot: screenshotSchema.optional(),
  editable: z
    .object({ text: z.string().max(LIMITS.editableChars), truncated: z.boolean().optional() })
    .optional(),
  fields: fieldsSchema,
});

export const startSchema = z.object({
  question: z.string().trim().min(1).max(LIMITS.questionChars),
  selection: z.string().max(LIMITS.selectionChars),
  context: contextSchema,
  images: imagesSchema,
  files: filesSchema,
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

export const followUpSchema = z.object({
  question: z.string().trim().min(1).max(LIMITS.questionChars),
  // A highlight the hotkey brought into the conversation, and its window when that's new.
  selection: z.string().max(LIMITS.selectionChars).optional(),
  context: contextSchema.optional(),
  images: imagesSchema,
  files: filesSchema,
  options: optionsSchema,
  ...questionExtras,
});

/** What the next question would be asked with (`Engine.warm`). */
export const warmSchema = z.object({
  conversationId: z.string().optional(),
  options: optionsSchema,
  tools: toolsSchema,
  personality: z.string().trim().max(LIMITS.personalityChars).optional(),
});
