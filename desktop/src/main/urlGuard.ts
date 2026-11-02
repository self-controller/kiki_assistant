// Whether Kiki may open an address in its own browser. The model picks the address, so this keeps it from being
// a way out for what's on the person's screen: an address made of the highlight, the page's text or a field's
// value would send that text to whoever runs the site (the reason Kiki had no open_url before).
import type { Capture } from "./capture/common.ts";

/** A run of the address this long that also appears on screen counts as the screen's text carried in it. */
const CARRIED_CHARS = 24;
/** How much of the address is checked. */
const MAX_URL_TEXT = 2_000;

/** Hosts on this computer or the local network: opened only when the person asked for that address. */
function isLocalHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "localhost" || bare.endsWith(".localhost") || bare.endsWith(".local") || bare === "0.0.0.0") return true;
  if (bare === "::1" || bare.startsWith("fe80:") || bare.startsWith("fc") || bare.startsWith("fd")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The address's path, query and fragment as text, decoded. */
function urlText(url: URL): string {
  const raw = `${url.pathname}${url.search}${url.hash}`.slice(0, MAX_URL_TEXT).replace(/\+/g, " ");
  try {
    return squash(decodeURIComponent(raw));
  } catch {
    return squash(raw);
  }
}

/** Everything on the screen the model saw for this window: the highlight, the text, the editable text, the fields. */
function screenText(capture: Capture | undefined): string {
  if (!capture) return "";
  const parts = [
    capture.selection,
    capture.text ?? "",
    capture.editTarget?.full?.text ?? "",
    ...(capture.form?.fields ?? []).map((field) => field.value ?? ""),
  ];
  return squash(parts.join("\n"));
}

/**
 * The first run of the address that came from the screen, or null. Links shown on the page are fine: the
 * address as a whole appears there. So is what the person typed in their question.
 */
export function carriedText(url: URL, capture: Capture | undefined, question: string): string | null {
  const screen = screenText(capture);
  if (!screen) return null;
  const shown = `${url.host}${url.pathname}`.toLowerCase();
  if (screen.includes(url.href.toLowerCase()) || (url.pathname.length > 1 && screen.includes(shown))) return null;
  const text = urlText(url);
  const asked = squash(question);
  for (let start = 0; start + CARRIED_CHARS <= text.length; start++) {
    const run = text.slice(start, start + CARRIED_CHARS);
    // Something without letters (ids, numbers, separators) says nothing about the person.
    if (!/\p{L}{3}/u.test(run)) continue;
    if (screen.includes(run) && !asked.includes(run)) return run;
  }
  return null;
}

/**
 * Why Kiki won't open `url` for this question, or null when it may: only http(s); local addresses only when the
 * person named them; never an address that carries the screen's text.
 */
export function checkUrl(url: string, capture: Capture | undefined, question: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "That isn't a web address.";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "Only http(s) pages can be opened.";
  if (!parsed.hostname) return "That address has no site in it.";
  if (isLocalHost(parsed.hostname) && !question.toLowerCase().includes(parsed.hostname.toLowerCase())) {
    return `Kiki opens addresses on this computer or network (${parsed.hostname}) only when the person gives that address.`;
  }
  const carried = carriedText(parsed, capture, question);
  if (carried) {
    return `That address carries text from the screen (“${carried}…”), so Kiki won't open it: use the address the person gave, or the site's own search page without that text.`;
  }
  return null;
}
