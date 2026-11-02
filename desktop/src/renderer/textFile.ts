// Reads a file the person attached (Markdown, notes, code) as the text Kiki sends with the question.
import { LIMITS } from "@kiki/shared";

/** Bigger files aren't read at all: Kiki would send only the start of them anyway. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** A file's text, cut to LIMITS.fileChars, or null when it isn't UTF-8 text (a PDF, a zip, a program). */
export function readTextFile(bytes: Uint8Array): { text: string; truncated: boolean } | null {
  if (bytes.subarray(0, 8192).includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (text.length <= LIMITS.fileChars) return { text, truncated: false };
  let end = LIMITS.fileChars;
  // Don't split an emoji or other character that takes two UTF-16 units.
  if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return { text: text.slice(0, end), truncated: true };
}
