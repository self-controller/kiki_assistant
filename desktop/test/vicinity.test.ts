import { describe, expect, it } from "vitest";
import { cropAround } from "../resources/gnome-extension/kiki-popup@kiki.app/crop.js";
import { trimLines } from "../src/main/capture/index.ts";
import { pageRulesOutPrimary, primaryFitsVicinity } from "../src/main/capture/linux.ts";

/** "line 1\nline 2…" for lines `from` to `to`. */
function lines(from: number, to: number): string {
  return Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join("\n");
}

describe("trimLines", () => {
  const budget = { before: 3, after: 2, chars: 10_000 };

  it("keeps whole lines around a selection that starts and ends mid-line", () => {
    const out = trimLines(
      { kind: "editor", before: `${lines(1, 10)}\nmid`, anchor: "dle sel", after: `ected\n${lines(11, 20)}` },
      budget,
    );
    expect(out).toBe(["…", "line 8", "line 9", "line 10", "middle selected", "line 11", "line 12", "…"].join("\n"));
  });

  it("keeps the output above a terminal's cursor, without the blank rows under it", () => {
    const out = trimLines(
      { kind: "terminal", before: `${lines(1, 5)}\n$ `, anchor: "", after: "\n\n   \n\n" },
      { before: 90, after: 10, chars: 8_000 },
    );
    expect(out).toBe(`${lines(1, 5)}\n$`);
  });

  it("keeps indentation and tabs, and collapses runs of blank lines", () => {
    const out = trimLines(
      { kind: "editor", before: "def f():\n\n\n\n    if x:\n\t", anchor: "return 1", after: "  \n" },
      { ...budget, before: 10 },
    );
    expect(out).toBe("def f():\n\n    if x:\n\treturn 1");
  });

  it("handles CRLF line endings", () => {
    const out = trimLines({ kind: "editor", before: "a\r\nb\r\n", anchor: "c", after: "\r\nd\r\n" }, budget);
    expect(out).toBe("a\nb\nc\nd");
  });

  it("drops the farthest lines to fit the character budget, keeping the before/after ratio", () => {
    // Every row is 9 characters plus its line break.
    const rows = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => `row ${String(from + i).padStart(5, "0")}`).join("\n");
    const out = trimLines(
      { kind: "terminal", before: `${rows(1, 100)}\n`, anchor: "SELECTED", after: `\n${rows(101, 200)}` },
      { before: 90, after: 10, chars: 300 },
    )!;
    const kept = out.split("\n");
    expect(kept[0]).toBe("…");
    expect(kept.at(-1)).toBe("…");
    const content = kept.slice(1, -1);
    expect(content.join("\n").length).toBeLessThanOrEqual(300);
    const at = content.indexOf("SELECTED");
    // The nearest rows survive on both sides, about nine above for every one below.
    expect(content[at - 1]).toBe("row 00100");
    expect(content[at + 1]).toBe("row 00101");
    const above = at;
    const below = content.length - at - 1;
    expect(above).toBeGreaterThanOrEqual(below * 8);
    expect(below).toBeGreaterThanOrEqual(2);
  });

  it("gives up when the selection's own lines don't fit", () => {
    const vicinity = { kind: "editor" as const, before: "", anchor: "x".repeat(50), after: "" };
    expect(trimLines(vicinity, { before: 1, after: 1, chars: 20 })).toBeUndefined();
  });
});

describe("cropAround", () => {
  const window = { x: 100, y: 50, width: 2000, height: 1200 };

  it("centers the crop across the pointer, with most of it above", () => {
    expect(cropAround({ x: 1100, y: 650 }, window, 1400, 700)).toEqual({ x: 400, y: 183, width: 1400, height: 700 });
  });

  it("moves the crop inside the window near its edges", () => {
    expect(cropAround({ x: 150, y: 60 }, window, 1400, 700)).toEqual({ x: 100, y: 50, width: 1400, height: 700 });
    expect(cropAround({ x: 2090, y: 1240 }, window, 1400, 700)).toEqual({ x: 700, y: 550, width: 1400, height: 700 });
  });

  it("takes the whole window when it is smaller than the crop", () => {
    const small = { x: 10, y: 20, width: 800, height: 400 };
    expect(cropAround({ x: 400, y: 200 }, small, 1400, 700)).toEqual(small);
  });

  it("takes the whole window when the pointer is outside it", () => {
    expect(cropAround({ x: 5, y: 5 }, window, 1400, 700)).toEqual(window);
  });
});

describe("primaryFitsVicinity", () => {
  const terminal = { kind: "terminal" as const, before: "$ ls\nREADME.md   package.json\n$ ", anchor: "", after: "" };

  it("keeps a highlight that the terminal shows, even with different spacing", () => {
    expect(primaryFitsVicinity("README.md package.json", terminal)).toBe(true);
  });

  it("drops a highlight from another window when the terminal only reports its caret", () => {
    expect(primaryFitsVicinity("baseline migration", terminal)).toBe(false);
  });

  it("leaves the primary selection alone without a caret-only vicinity", () => {
    expect(primaryFitsVicinity("anything", undefined)).toBe(true);
    expect(primaryFitsVicinity("anything", { ...terminal, anchor: "ls" })).toBe(true);
  });
});

describe("pageRulesOutPrimary", () => {
  const page = { ok: true, source: "document" as const, url: "https://www.google.com/search?q=vm" };

  it("ignores the primary selection on a page with nothing highlighted", () => {
    expect(pageRulesOutPrimary({ ...page, pageSelected: false })).toBe(true);
  });

  it("keeps it when the page has a highlight, or doesn't say", () => {
    expect(pageRulesOutPrimary({ ...page, pageSelected: true })).toBe(false);
    expect(pageRulesOutPrimary(page)).toBe(false);
  });

  it("keeps it in a Google Doc, which draws its own highlight", () => {
    const doc = { ...page, url: "https://docs.google.com/document/d/abc/edit", pageSelected: false };
    expect(pageRulesOutPrimary(doc)).toBe(false);
  });

  it("leaves other windows and failed reads to the other checks", () => {
    expect(pageRulesOutPrimary({ ok: true, source: "terminal", pageSelected: false })).toBe(false);
    expect(pageRulesOutPrimary({ ok: true, source: "window", pageSelected: false })).toBe(false);
    expect(pageRulesOutPrimary({ ok: false, error: "timed out" })).toBe(false);
  });
});
