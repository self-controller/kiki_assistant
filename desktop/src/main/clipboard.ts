// Kiki copies and pastes through the person's clipboard; these put back what was there.
import { clipboard, ClipboardItem, type ClipboardBookmark } from "electron";
import { setClipboard } from "./gnomeShell.ts";
import { isWayland } from "./windows.ts";

/**
 * Puts `text` on the clipboard for a paste. GNOME drops a clipboard write from an app that doesn't have the
 * keyboard, so once Kiki has handed it to the window it pastes into, only the GNOME helper (v9) can write it.
 * False when nobody can: an older helper, and Kiki without the keyboard.
 */
export async function clipboardForPaste(text: string, kikiHasKeyboard: boolean): Promise<boolean> {
  if (isWayland && (await setClipboard(text))) return true;
  if (isWayland && !kikiHasKeyboard) return false;
  await clipboard.writeText(text);
  return true;
}

/** Reads every format on the clipboard now, so it can be put back later. */
export async function snapshotClipboard(): Promise<ClipboardItem[]> {
  const items = await clipboard.read();
  return Promise.all(
    items.map(async (item) => {
      const entries: Record<string, Blob | ClipboardBookmark> = {};
      for (const type of item.types) {
        try {
          entries[type] = await item.getType(type);
        } catch {
          // Skip formats that can't be read back.
        }
      }
      return new ClipboardItem(entries);
    }),
  );
}

/** The plain text in a snapshot, if it has any. */
async function plainText(saved: ClipboardItem[]): Promise<string | undefined> {
  const item = saved.find((candidate) => candidate.types.includes("text/plain"));
  return item?.getType("text/plain").then((blob) => blob.text(), () => undefined);
}

/**
 * Saves the clipboard now, while Kiki has the keyboard; the function it returns puts it back (or empties it,
 * if it was empty). By then the keyboard is elsewhere on Wayland, so the GNOME helper puts back its text.
 */
export async function keepClipboard(): Promise<() => Promise<void>> {
  const saved = await snapshotClipboard().catch(() => []);
  return async () => {
    if (isWayland) {
      const text = saved.length > 0 ? await plainText(saved) : "";
      if (text !== undefined && (await setClipboard(text))) return;
    }
    if (saved.length > 0) await clipboard.write(saved).catch(() => clipboard.clear());
    else clipboard.clear();
  };
}
