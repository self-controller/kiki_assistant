import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Calls Kiki's GNOME Shell extension (resources/gnome-extension) over D-Bus. */
export async function callExtension(timeoutMs: number, method: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(
    "gdbus",
    [
      "call",
      "--session",
      "--dest",
      "org.gnome.Shell",
      "--object-path",
      "/app/kiki/Shell",
      "--method",
      `app.kiki.Shell.${method}`,
      ...args,
    ],
    { timeout: timeoutMs },
  );
  return stdout;
}

/**
 * Tells Kiki's GNOME extension to remember the focused window and the pointer, so `captureSource` can
 * take a screenshot of them later, even under Kiki's popup. False without a focused window, or without
 * version 3 of the extension (it loads at the next login).
 */
export async function rememberSource(): Promise<boolean> {
  try {
    // "(uint32 3, true)"
    return (await callExtension(1_000, "RememberSource")).includes("true");
  } catch {
    return false;
  }
}

/**
 * A PNG of the window `rememberSource` saw, around the pointer, at most `maxWidth`×`maxHeight` (logical
 * pixels). Returns the file's path, or null when the window is gone.
 */
export async function captureSource(maxWidth: number, maxHeight: number): Promise<string | null> {
  try {
    // "(uint32 3, '/run/user/1000/kiki/source.png')"
    const out = await callExtension(3_000, "CaptureSource", String(maxWidth), String(maxHeight));
    return out.match(/'([^']+)'/)?.[1] ?? null;
  } catch {
    return null;
  }
}
