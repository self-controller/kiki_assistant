// Opens the searches Claude asks for (`open_search`) in the person's browser. The URL is built here from a
// fixed list of places, never taken from the server, so all Kiki can ever open this way is a search.
import {
  LIMITS,
  SEARCH_PLACES,
  SEARCH_SITE_PATTERN,
  SITE_SEARCH_PLACES,
  type SearchPlace,
  type ToolResult,
} from "@kiki/shared";
import { shell } from "electron";

function isPlace(value: unknown): value is SearchPlace {
  return (SEARCH_PLACES as readonly unknown[]).includes(value);
}

/** The search's URL, or null when the input isn't a search Kiki opens. */
export function searchUrl(input: Record<string, unknown>): string | null {
  const { where, query, site } = input;
  if (!isPlace(where) || typeof query !== "string") return null;
  const terms = query.trim();
  if (!terms || terms.length > LIMITS.searchQueryChars) return null;
  if (site !== undefined) {
    if (typeof site !== "string" || !SEARCH_SITE_PATTERN.test(site) || !SITE_SEARCH_PLACES.includes(where)) return null;
  }
  const q = encodeURIComponent(site ? `site:${site} ${terms}` : terms);
  switch (where) {
    case "web":
      return `https://www.google.com/search?q=${q}`;
    case "images":
      return `https://www.google.com/search?udm=2&q=${q}`;
    case "videos":
      return `https://www.youtube.com/results?search_query=${q}`;
    case "maps":
      return `https://www.google.com/maps/search/?api=1&query=${q}`;
    case "news":
      return `https://news.google.com/search?q=${q}`;
  }
}

/** Runs `open_search` for Claude. Errors come back as error results, never thrown. */
export async function openSearch(id: string, input: Record<string, unknown>): Promise<ToolResult> {
  const url = searchUrl(input);
  if (!url) return { id, content: "That isn't a search Kiki can open.", isError: true };
  try {
    await shell.openExternal(url);
    return { id, content: "Opened it in a new tab of the person's browser." };
  } catch (error) {
    return { id, content: `Couldn't open the browser: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}
