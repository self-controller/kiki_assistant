// The hotkey, pressed again while Kiki is open, brings the new highlight into the chat instead of starting a
// new one. The next question carries it, and the window's context too when the conversation doesn't have it.

/** A window's context as the conversation knows it: what went with its first question, or its latest update. */
export interface PageContext {
  appName?: string;
  windowTitle?: string;
  url?: string;
  text?: string;
}

export function pageOf(capture: PageContext): PageContext {
  const { appName, windowTitle, url, text } = capture;
  return { appName, windowTitle, url, text };
}

/** Another app, window or page than `known`. */
export function isNewPage(known: PageContext | null, next: PageContext): boolean {
  if (!known) return true;
  return known.appName !== next.appName || known.windowTitle !== next.windowTitle || known.url !== next.url;
}

/**
 * Whether the window's context goes with a new highlight: on a new page, or when the page's text changed and
 * the highlight isn't in the text the conversation has (unless the person left the text out).
 */
export function needsContext(
  known: PageContext | null,
  next: PageContext & { selection: string },
  omitText: boolean | undefined,
): boolean {
  if (isNewPage(known, next)) return true;
  if (omitText || !next.text || next.text === known?.text) return false;
  const selection = next.selection.trim();
  return !selection || !(known?.text ?? "").includes(selection);
}
