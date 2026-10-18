// Kiki copies and pastes through the person's clipboard; these put back what was there.
import { clipboard, ClipboardItem, type ClipboardBookmark } from "electron";

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

/** Saves the clipboard now; the function it returns puts it back (or empties it, if it was empty). */
export async function keepClipboard(): Promise<() => Promise<void>> {
  const saved = await snapshotClipboard().catch(() => []);
  return async () => {
    if (saved.length > 0) await clipboard.write(saved).catch(() => clipboard.clear());
    else clipboard.clear();
  };
}
