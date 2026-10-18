import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { ProposedAction } from "@kiki/shared";
import { describe, expect, it } from "vitest";
import type { FormTarget } from "../src/main/capture/common.ts";
import { linuxEditTarget, linuxForm } from "../src/main/capture/linux.ts";
import { changeProblems, docsMatches, docsParts, fillProblems, formFields, newText } from "../src/main/changes.ts";
import { changesMode, editInfo } from "../src/main/edit.ts";
import { applyEdits, describeAction } from "../src/main/google/format.ts";
import { diffParts } from "../src/renderer/diff.ts";

const FIELD = {
  pid: 4242,
  path: [0, 3, 1],
  role: "entry",
  start: 0,
  end: 0,
  expected: "",
  editable: true,
  kind: "editor" as const,
  full: { text: "teh cat sat on teh mat" },
};

describe("where changes go", () => {
  it("writes directly in GTK, and selects and pastes in Zen once the helper can focus the window", () => {
    const gtk = linuxEditTarget({ ok: true, edit: { ...FIELD, toolkit: "gtk" } }, "", true, true);
    expect(gtk).toMatchObject({ atspi: { pid: 4242 }, full: FIELD.full });
    expect(gtk?.selectPaste).toBeUndefined();
    expect(changesMode(gtk)).toBe("text");

    const zen = linuxEditTarget({ ok: true, edit: { ...FIELD, toolkit: "gecko" } }, "", true, true);
    expect(zen).toMatchObject({ selectPaste: true, atspi: { pid: 4242 }, full: FIELD.full, keys: true });
    expect(editInfo(zen)).toMatchObject({ changes: "text", wholeText: true });

    // Helper v6: Zen takes a paste at its cursor, but nothing that needs selecting first.
    const older = linuxEditTarget({ ok: true, edit: { ...FIELD, toolkit: "gecko" } }, "", true, false);
    expect(older).toMatchObject({ paste: true });
    expect(older?.atspi).toBeUndefined();
    expect(changesMode(older)).toBeUndefined();
  });

  it("changes Google Docs through Find and replace, and pastes there without the newer helper", () => {
    const docs = { ok: true, pid: 77, url: "https://docs.google.com/document/d/abc/edit", edit: { ...FIELD, toolkit: "gecko" } };
    expect(linuxEditTarget(docs, "teh", true, true)).toEqual({
      mode: "replace",
      original: "teh",
      kind: "docs",
      paste: true,
      keys: true,
      pid: 77,
    });
    const pasteOnly = linuxEditTarget(docs, "", true, false);
    expect(pasteOnly).toMatchObject({ kind: "docs", mode: "insert" });
    expect(changesMode(pasteOnly)).toBeUndefined();
    expect(changesMode(linuxEditTarget(docs, "", true, true))).toBe("docs");
  });

  it("never offers changes in a terminal", () => {
    const terminal = linuxEditTarget({ ok: true, edit: { ...FIELD, kind: "terminal", editable: false, toolkit: "gtk" } }, "", true, true);
    expect(changesMode(terminal)).toBeUndefined();
  });
});

describe("forms", () => {
  const field = (kind: "text" | "textarea" | "checkbox", label: string, extra = {}) => ({
    path: [0, 1, label.length],
    role: kind === "checkbox" ? "check box" : "entry",
    label,
    kind,
    onScreen: true,
    ...(kind === "checkbox" ? { checked: false } : { value: "" }),
    ...extra,
  });

  it("is a form with two text fields on screen, numbered in reading order", () => {
    const context = {
      ok: true,
      pid: 9,
      toolkit: "gtk",
      fields: [
        field("text", "Name"),
        field("checkbox", "Agree"),
        field("text", "City", { value: "Paris" }),
        field("text", "Hidden", { onScreen: false }),
        // A field nobody labelled (often the document itself) isn't something to fill.
        field("textarea", "", { value: "a whole document" }),
      ],
    };
    const form = linuxForm(context, false)!;
    expect(form.selectPaste).toBe(false);
    expect(formFields(form)).toEqual([
      { id: "f1", label: "Name", kind: "text", value: "" },
      { id: "f2", label: "Agree", kind: "checkbox", checked: false },
      { id: "f3", label: "City", kind: "text", value: "Paris" },
    ]);
  });

  it("isn't a form with check boxes alone, in Google Docs, or in a browser without the newer helper", () => {
    const boxes = { ok: true, pid: 9, fields: [field("text", "Search"), field("checkbox", "a"), field("checkbox", "b")] };
    expect(linuxForm(boxes, true)).toBeUndefined();
    const two = [field("text", "Name"), field("text", "City")];
    expect(linuxForm({ ok: true, pid: 9, toolkit: "gecko", fields: two }, false)).toBeUndefined();
    expect(linuxForm({ ok: true, pid: 9, toolkit: "gecko", fields: two }, true)?.selectPaste).toBe(true);
    expect(linuxForm({ ok: true, pid: 9, url: "https://docs.google.com/document/d/x/edit", fields: two }, true)).toBeUndefined();
  });

  it("tells Claude which values don't fit", () => {
    const form: FormTarget = {
      pid: 9,
      selectPaste: false,
      fields: [
        { id: "f1", label: "Name", kind: "text", value: "", path: [1] },
        { id: "f2", label: "Agree", kind: "checkbox", checked: false, path: [2] },
        { id: "f3", label: "Plan", kind: "radio", checked: false, path: [3] },
      ],
    };
    expect(fillProblems(form, [{ field: "f1", value: "Ada" }, { field: "f2", value: true }])).toBeNull();
    const problems = fillProblems(form, [
      { field: "f9", value: "x" },
      { field: "f2", value: "yes" },
      { field: "f1", value: "two\nlines" },
      { field: "f3", value: false },
    ])!;
    expect(problems).toContain("f9 isn't one of the fields");
    expect(problems).toContain("f2 is a checkbox: use true or false.");
    expect(problems).toContain("f1 takes one line of text.");
    expect(problems).toContain("f3 is a radio button");
    expect(fillProblems(undefined, [])).toContain("can't fill a form");
  });
});

describe("change checks", () => {
  const changes = [
    { find: "teh cat", replace: "the cat" },
    { find: "teh", replace: "the" },
    { find: "mat.\nIt", replace: "mat. It" },
  ];

  it("explains each change that doesn't fit, and passes when they all do", () => {
    const problems = changeProblems(changes, [
      { status: "ok", count: 1 },
      { status: "ambiguous", count: 2 },
      { status: "spans", count: 1 },
    ])!;
    expect(problems).toContain('Change 2: "teh" appears 2 times; include more of the words around it');
    expect(problems).toContain("Change 3: \"mat.\\nIt\" runs from one line or paragraph into the next");
    expect(problems).not.toContain("Change 1");
    expect(changeProblems(changes.slice(0, 1), [{ status: "ok", count: 1 }])).toBeNull();
  });

  it("makes the copy-all text with each change that has one match", () => {
    expect(newText("teh cat sat on teh mat", [{ find: "teh cat", replace: "the cat" }, { find: "teh", replace: "x" }])).toBe(
      "the cat sat on teh mat",
    );
  });

  it("reads Docs' Find and replace dialog", () => {
    const dialog = {
      fields: [
        { path: [1], name: "Find", text: "" },
        { path: [2], name: "Replace with", text: "" },
      ],
      checks: [
        { path: [3], name: "Match case", checked: false },
        { path: [4], name: "Match using regular expressions", checked: false },
      ],
      buttons: [
        { path: [5], name: "Replace" },
        { path: [6], name: "Replace all" },
      ],
      count: "1 of 3",
    };
    expect(docsParts(dialog)).toMatchObject({
      find: { path: [1] },
      replace: { path: [2] },
      matchCase: { path: [3] },
      regex: { path: [4] },
      replaceAll: { path: [6] },
    });
    expect(docsMatches("1 of 3")).toBe(3);
    expect(docsMatches("No results")).toBe(0);
    expect(docsMatches(null)).toBeNull();
  });
});

describe("changes and fill cards", () => {
  const changes: Extract<ProposedAction, { kind: "changes" }> = {
    id: "c1",
    kind: "changes",
    changes: [
      { find: "teh cat", replace: "the cat" },
      { find: "wrold", replace: "world" },
    ],
  };

  it("keeps the ticked changes with the person's replacements, never a different find", () => {
    const edited = applyEdits(changes, {
      changes: [
        { find: "wrold", replace: "World" },
        { find: "sneaky", replace: "x" },
      ],
    });
    expect(edited).toEqual({ id: "c1", kind: "changes", changes: [{ find: "wrold", replace: "World" }] });
    expect(applyEdits(changes, { changes: [] })).toEqual({ error: "Tick at least one change." });
  });

  it("keeps a check box a check box", () => {
    const fill: ProposedAction = { id: "f", kind: "fill", fields: [{ field: "f1", value: "Ada" }, { field: "f2", value: true }] };
    expect(applyEdits(fill, { fields: [{ field: "f2", value: "yes" }, { field: "f1", value: "Ada L." }] })).toEqual({
      id: "f",
      kind: "fill",
      fields: [
        { field: "f1", value: "Ada L." },
        { field: "f2", value: true },
      ],
    });
  });

  it("describes them for Claude", () => {
    expect(describeAction(changes)).toBe('2 changes: "teh cat" → "the cat"; "wrold" → "world".');
    expect(describeAction({ id: "f", kind: "fill", fields: [{ field: "f2", value: false }] })).toBe("1 field: f2 = unchecked.");
  });

  it("shows what differs, in whole words", () => {
    expect(diffParts("teh cat sat", "the cat sat")).toEqual({ head: "", removed: "teh", added: "the", tail: " cat sat" });
    expect(diffParts("It was wrold class", "It was world class")).toEqual({
      head: "It was ",
      removed: "wrold",
      added: "world",
      tail: " class",
    });
    expect(diffParts("a very bad idea", "a bad idea")).toMatchObject({ removed: "very ", added: "" });
  });
});

const helper = join(import.meta.dirname, "..", "resources", "kiki_context.py");

function hasAtspi(): boolean {
  try {
    execFileSync("/usr/bin/python3", [helper, "--check"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasAtspi())("the helper's change finding", () => {
  /**
   * Flattens fake rich text (a compose box: one line per child, standing in its text as U+FFFC) and finds
   * each change in it.
   */
  const locate = (lines: string[], finds: string[]) => {
    const script = `
import json, sys
sys.path.insert(0, sys.argv[1])
import kiki_context as k
from gi.repository import Atspi

class Node:
    def __init__(self, name, text, role, kids=()):
        self.name, self.text, self.role, self.kids = name, text, role, list(kids)
    def get_role(self): return self.role
    def get_text_iface(self): return self
    def get_child_count(self): return len(self.kids)
    def get_child_at_index(self, index): return self.kids[index]

k.Atspi.Text.get_character_count = staticmethod(lambda iface: len(iface.text))
k.Atspi.Text.get_text = staticmethod(lambda iface, start, end: iface.text[start:end])
lines, finds = json.loads(sys.argv[2])
kids = [Node(f"line{i}", line, Atspi.Role.SECTION) for i, line in enumerate(lines)]
root = Node("root", "\\ufffc" * len(kids), Atspi.Role.ENTRY, kids)
text, placed = k.flatten(root)
results = k.locate_changes(text, placed, [{"find": f} for f in finds])
print(json.dumps({"text": text, "results": [{**k.public(r), **({"node": r["node"].name, "start": r["start"]} if r["status"] == "ok" else {})} for r in results]}))`;
    const out = execFileSync("/usr/bin/python3", ["-c", script, join(helper, ".."), JSON.stringify([lines, finds])], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(out) as { text: string; results: Array<{ status: string; count: number; node?: string; start?: number }> };
  };

  it("joins the lines of rich text and finds each change in the line holding it", () => {
    const { text, results } = locate(
      ["Hello wrold and teh friends.", "Second line with teh typo."],
      ["wrold", "teh", "teh typo", "friends.\nSecond", "nope", "wrold and"],
    );
    expect(text).toBe("Hello wrold and teh friends.\nSecond line with teh typo.");
    expect(results).toEqual([
      { status: "ok", count: 1, node: "line0", start: 6 },
      { status: "ambiguous", count: 2 },
      { status: "ok", count: 1, node: "line1", start: 17 },
      { status: "spans", count: 1 },
      { status: "missing", count: 0 },
      { status: "overlaps", count: 1 },
    ]);
  });
});
