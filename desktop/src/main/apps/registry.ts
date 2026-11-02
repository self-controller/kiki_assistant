/// <reference types="vite/types/importGlob.d.ts" />
// The one place Kiki looks up an app's handler. Each app is a module in ./handlers; adding one is adding a file.
import { errorMessage } from "../errors.ts";
import type { AppExtras, AppHandler, AppIdentity, AppMatch, ReadContext } from "./types.ts";

export type { AppExtras, AppHandler, AppIdentity, AppKind } from "./types.ts";

/** How long Kiki waits for an app's own reader, after the popup has opened. */
export const APP_READ_MS = 1_500;

const modules = import.meta.glob<{ default: AppHandler }>("./handlers/*.ts", { eager: true });

/** Every app Kiki knows, in file order. */
export const HANDLERS: AppHandler[] = Object.values(modules).map((module) => module.default);

/** Which of an identity's names to look for in which list, most specific first. */
const SIGNALS: [keyof AppIdentity, keyof AppMatch][] = [
  ["appId", "ids"],
  ["sandboxedId", "ids"],
  ["cgroupId", "ids"],
  ["wmClass", "wmClasses"],
  ["exe", "exes"],
  ["atspiName", "atspiNames"],
  ["macName", "macNames"],
];

export interface ResolvedApp {
  handler: AppHandler;
  /** Which of the identity's names matched. */
  by: keyof AppIdentity;
}

/**
 * The handler for the app an identity names, by its most specific name that any handler knows. Undefined for an
 * app Kiki has nothing special for: it gets the generic behavior.
 */
export function resolveApp(identity: AppIdentity, handlers: AppHandler[] = HANDLERS): ResolvedApp | undefined {
  for (const [key, list] of SIGNALS) {
    const value = identity[key];
    if (typeof value !== "string" || !value) continue;
    const name = value.toLowerCase();
    const handler = handlers.find((candidate) => candidate.match[list]?.includes(name));
    if (handler) return { handler, by: key };
  }
  return undefined;
}

/**
 * Runs an app's own reader, for at most APP_READ_MS. Anything that goes wrong (it throws, is too slow, finds
 * nothing) leaves Kiki with what it read over AT-SPI.
 */
export async function readApp(
  handler: AppHandler,
  context: Omit<ReadContext, "signal">,
  timeoutMs = APP_READ_MS,
): Promise<AppExtras | undefined> {
  if (!handler.read) return undefined;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`timed out after ${timeoutMs} ms`));
      console.warn(`[kiki] ${handler.id} read: timed out after ${timeoutMs} ms`);
      resolve(undefined);
    }, timeoutMs);
  });
  try {
    return await Promise.race([handler.read({ ...context, signal: controller.signal }), timedOut]);
  } catch (error) {
    if (!controller.signal.aborted) console.warn(`[kiki] ${handler.id} read:`, errorMessage(error));
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
