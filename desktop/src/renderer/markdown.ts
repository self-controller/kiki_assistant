// Turns an answer's markdown into HTML: code blocks highlighted, with their language and a copy button, and
// LaTeX math rendered with KaTeX. Pure string functions (no DOM), so they're testable; popup.ts sanitizes
// the HTML and puts the icon in each copy button.
import hljs from "highlight.js/lib/common";
import katex from "katex";
import { Marked, type Tokens, type TokenizerAndRendererExtension } from "marked";

/** Formulas and finished code blocks already rendered, by source: an answer renders a block again as it settles. */
const mathCache = new Map<string, string>();
const codeCache = new Map<string, string>();
const CACHE_SIZE = 200;

function cached(cache: Map<string, string>, key: string, render: () => string): string {
  let html = cache.get(key);
  if (html === undefined) {
    if (cache.size >= CACHE_SIZE) cache.clear();
    html = render();
    cache.set(key, html);
  }
  return html;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function renderMath(tex: string, display: boolean): string {
  return cached(mathCache, `${display ? "$$" : "$"}${tex}`, () =>
    katex.renderToString(tex, { displayMode: display, output: "html", throwOnError: false, strict: "ignore" }),
  );
}

interface MathToken extends Tokens.Generic {
  type: "blockMath" | "inlineMath";
  raw: string;
  tex: string;
  display: boolean;
}

/** A formula on its own lines: `$$…$$` or `\[…\]`. */
const BLOCK_MATH = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]) *(?:\n+|$)/;
/** Display math inside a paragraph, then `\(…\)`. */
const INLINE_DISPLAY = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])/;
const INLINE_PAREN = /^\\\(([\s\S]+?)\\\)/;
/**
 * `$…$` the way Pandoc reads it: a non-space right after the opening `$` and right before the closing one,
 * no digit right after it, all on one line. So "$5 and $10" stays money.
 */
const INLINE_DOLLAR = /^\$(?![\s$])((?:\\.|[^\\\n$])*?[^\\\s$])\$(?!\d)/;

function mathToken(type: MathToken["type"], raw: string, tex: string | undefined, display: boolean): MathToken | undefined {
  const trimmed = tex?.trim();
  return trimmed ? { type, raw, tex: trimmed, display } : undefined;
}

const math: TokenizerAndRendererExtension[] = [
  {
    name: "blockMath",
    level: "block",
    // A formula's first line ends the paragraph before it.
    start: (src) => {
      const match = /\n {0,3}(?:\$\$|\\\[)/.exec(src);
      return match ? match.index + 1 : undefined;
    },
    tokenizer(src) {
      const match = BLOCK_MATH.exec(src);
      return match ? mathToken("blockMath", match[0], match[1] ?? match[2], true) : undefined;
    },
    renderer: (token) => `${renderMath((token as MathToken).tex, true)}\n`,
  },
  {
    name: "inlineMath",
    level: "inline",
    start: (src) => {
      const at = src.search(/\$|\\[([]/);
      return at === -1 ? undefined : at;
    },
    // Runs before marked's escapes, which would turn `\(` into "(".
    tokenizer(src) {
      let match = INLINE_DISPLAY.exec(src);
      if (match) return mathToken("inlineMath", match[0], match[1] ?? match[2], true);
      match = INLINE_PAREN.exec(src) ?? INLINE_DOLLAR.exec(src);
      return match ? mathToken("inlineMath", match[0], match[1], false) : undefined;
    },
    renderer: (token) => renderMath((token as MathToken).tex, (token as MathToken).display),
  },
];

/** A fenced block: its language and a copy button above the code, highlighted when the language is known. */
function codeBlock({ text, lang, raw }: Tokens.Code): string {
  const language = /^\S*/.exec(lang ?? "")![0];
  const code = text.replace(/\n$/, "");
  // No guessing: a guess could change as the code streams in, recoloring it.
  const known = language && hljs.getLanguage(language) ? language : "";
  const highlight = () => hljs.highlight(code, { language: known, ignoreIllegals: true }).value;
  // One still streaming in changes every frame: only a closed block is worth remembering.
  const closed = /\n {0,3}(`{3,}|~{3,}) *\n?$/.test(raw);
  const body = known ? (closed ? cached(codeCache, `${known}\n${code}`, highlight) : highlight()) : escapeHtml(code);
  const label = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : "";
  const codeClass = known ? ` class="hljs language-${escapeHtml(known)}"` : "";
  return (
    `<div class="code-block"><div class="code-head">${label}` +
    `<button type="button" class="code-copy" aria-label="Copy code" title="Copy"></button></div>` +
    `<pre><code${codeClass}>${body}</code></pre></div>\n`
  );
}

const marked = new Marked({ gfm: true, extensions: math, renderer: { code: codeBlock } });

/** The HTML for an answer's markdown, still to be sanitized. */
export function markdownToHtml(markdown: string): string {
  return marked.parse(markdown, { async: false });
}

/**
 * An answer streaming in, split where the block being written starts: `settled` holds the blocks before it
 * (which render the same from now on), `live` the last one, from the last blank line or closed code fence.
 * `open`: `live` is a code block still streaming in (code can hold blank lines, so it's live as a whole).
 */
export function splitLive(markdown: string): { settled: string; live: string; open: boolean } {
  let fence: string | null = null;
  let fenceAt = 0;
  let from = 0;
  for (const match of markdown.matchAll(/^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/gm)) {
    const marker = match[1]!;
    if (!fence) {
      fence = marker;
      fenceAt = match.index;
    } else if (marker[0] === fence[0] && marker.length >= fence.length && !match[0].trim().slice(marker.length)) {
      fence = null;
      from = match.index + match[0].length;
    }
  }
  const blank = markdown.lastIndexOf("\n\n", (fence ? fenceAt : markdown.length) - 1);
  const at = Math.max(from, blank < 0 ? 0 : blank + 2);
  return { settled: markdown.slice(0, at), live: markdown.slice(at), open: fence !== null };
}

/**
 * While an answer streams in: `markdown` without a formula that has started at its end but not finished, so
 * its TeX never shows raw. The formula appears whole once its closing delimiter arrives.
 */
export function holdBack(markdown: string): string {
  const { settled, live, open } = splitLive(markdown);
  return open ? markdown : settled + holdLive(live);
}

/** `holdBack` for the block being written (never a code block), on its own. */
export function holdLive(markdown: string): string {
  let at = 0;
  while (at < markdown.length) {
    const char = markdown[at]!;
    if (char === "`") {
      // A code span: its `$` are code.
      const ticks = /^`+/.exec(markdown.slice(at))![0];
      const close = markdown.indexOf(ticks, at + ticks.length);
      if (close === -1) return markdown;
      at = close + ticks.length;
    } else if (char === "\\") {
      const next = markdown[at + 1];
      if (next === "(" || next === "[") {
        const close = markdown.indexOf(next === "(" ? "\\)" : "\\]", at + 2);
        if (close === -1) return markdown.slice(0, at);
        at = close + 2;
      } else {
        at += 2;
      }
    } else if (char === "$" && markdown[at + 1] === "$") {
      const close = markdown.indexOf("$$", at + 2);
      if (close === -1) return markdown.slice(0, at);
      at = close + 2;
    } else if (char === "$") {
      const next = markdown[at + 1];
      // "$5" is money, and "$ " isn't a formula.
      if (next !== undefined && /[\s\d]/.test(next)) {
        at++;
        continue;
      }
      const end = markdown.indexOf("\n", at);
      const line = markdown.slice(at + 1, end === -1 ? undefined : end);
      const close = line.search(/(?<!\\)\$/);
      if (close !== -1) at += close + 2;
      // A line that ended without a closing `$` had no formula; one still being written may.
      else if (end !== -1) at++;
      else return markdown.slice(0, at);
    } else {
      at++;
    }
  }
  return markdown;
}
