// Window titles: apps put their own name at the end, which Kiki already sends as the app.

/** `title` without the app's name at its end, as in "Feed — Zen Browser" or "main.ts - kiki - Visual Studio Code". */
export function stripSuffix(title: string, suffixes: RegExp[]): string {
  for (const suffix of suffixes) {
    const stripped = title.replace(suffix, "").trim();
    if (stripped && stripped !== title.trim()) return stripped;
  }
  return title;
}

/** " - Google Chrome", " — Mozilla Firefox": the app's name after a dash, maybe followed by a profile's. */
export function nameSuffix(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[\\s\\u200b]+");
  return new RegExp(`\\s+[-–—]\\s+${escaped}(?:\\s+[-–—]\\s+.*)?$`, "u");
}
