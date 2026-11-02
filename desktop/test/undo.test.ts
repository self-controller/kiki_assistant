import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Capture, EditTarget } from "../src/main/capture/common.ts";
import { retargetUndo } from "../src/main/edit.ts";
import { MAX_REPEATED_KEYS } from "../src/main/gnomeShell.ts";
import { orderSteps, pasteUndoKeys, selectPasteStep, UndoStack, writeStep, type UndoRecord, type UndoStep } from "../src/main/undo.ts";

const helper = join(import.meta.dirname, "../resources/kiki_context.py");

function hasAtspi(): boolean {
  try {
    execFileSync("/usr/bin/python3", [helper, "--check"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const PLACE = { pid: 4242, path: [0, 3, 1], role: "text" };

describe("pasteUndoKeys", () => {
  it("takes a terminal paste back with one Backspace per character, trailing newlines left out", () => {
    expect(pasteUndoKeys("terminal", "ls -la | sort\n")).toEqual(["backspace*13"]);
    // Characters, not UTF-16 units: an emoji is one Backspace.
    expect(pasteUndoKeys("terminal", "echo 🎉")).toEqual(["backspace*6"]);
    expect(pasteUndoKeys("terminal", "\n\n")).toEqual([]);
    expect(pasteUndoKeys("terminal", "x".repeat(MAX_REPEATED_KEYS))).toEqual([`backspace*${MAX_REPEATED_KEYS}`]);
    expect(pasteUndoKeys("terminal", "x".repeat(MAX_REPEATED_KEYS + 1))).toBeNull();
  });

  it("presses Ctrl+Z everywhere else", () => {
    for (const kind of ["editor", "field", "unknown", "docs"] as const) expect(pasteUndoKeys(kind, "anything\n")).toEqual(["ctrl+z"]);
  });
});

describe("orderSteps", () => {
  it("undoes the later text first within one object, and leaves other objects' order alone", () => {
    const steps: UndoStep[] = [
      writeStep(PLACE, 6, "world", "wrold"),
      writeStep({ ...PLACE, path: [0, 3, 2] }, 2, "the", "teh"),
      writeStep(PLACE, 40, "friends", "freinds"),
    ];
    expect(orderSteps(steps).map((step) => ("start" in step ? step.start : -1))).toEqual([40, 6, 2]);
  });
});

describe("UndoStack", () => {
  const capture = (): Capture => ({ selection: "", notes: [] });
  const record = (id: string, capture: Capture, steps: UndoStep[]): UndoRecord => ({ id, kind: "edit", capture, steps, skipped: [] });

  it("undoes writes in any order, but a paste only from the top and in its own window", () => {
    const window = capture();
    const stack = new UndoStack();
    stack.push(record("a", window, [writeStep(PLACE, 6, "world", "wrold")]));
    stack.push(record("b", window, [{ type: "keys", steps: ["ctrl+z"] }]));
    stack.push(record("c", window, [selectPasteStep(PLACE, 0, "Hello", "Hi")]));
    expect(stack.peek("a", window)).toEqual({ record: expect.objectContaining({ id: "a" }) });
    expect(stack.peek("b", window)).toEqual({ error: expect.stringContaining("Undo the newer card first") });
    stack.remove("c");
    expect(stack.peek("b", window)).toEqual({ record: expect.objectContaining({ id: "b" }) });
    // The hotkey moved the session to another window: the keystrokes would land there.
    expect(stack.peek("b", capture())).toEqual({ error: expect.stringContaining("another window") });
    stack.remove("b");
    expect(stack.has("b")).toBe(false);
    expect(stack.peek("b", window)).toEqual({ error: "Kiki can't undo this anymore." });
  });
});

describe("retargetUndo", () => {
  const target = (): EditTarget => ({
    mode: "replace",
    original: "the cat",
    kind: "editor",
    atspi: { pid: 4242, path: [0, 3, 1], role: "text", start: 10, end: 17 },
    paste: true,
  });

  it("puts the target back on the original text after a write is undone", () => {
    const next = target();
    retargetUndo(next, writeStep(PLACE, 10, "the cat", "teh c"));
    expect(next).toMatchObject({ mode: "replace", original: "teh c", atspi: { start: 10, end: 15 } });
    const inserted = target();
    retargetUndo(inserted, selectPasteStep(PLACE, 10, "the cat", ""));
    expect(inserted).toMatchObject({ mode: "insert", original: "", atspi: { start: 10, end: 10 } });
  });

  it("falls back to inserting at the cursor after keystrokes, or a write in another object", () => {
    const keys = target();
    retargetUndo(keys, { type: "keys", steps: ["ctrl+z"] });
    expect(keys.atspi).toBeUndefined();
    expect(keys).toMatchObject({ mode: "insert", original: "" });
    const elsewhere = target();
    retargetUndo(elsewhere, writeStep({ ...PLACE, path: [9] }, 10, "the cat", "teh c"));
    expect(elsewhere.atspi).toBeUndefined();
  });
});

describe.skipIf(!hasAtspi())("the helper's apply-changes", () => {
  it("says where each change went, from the last one to the first, so Undo can put the originals back", () => {
    const script = `
import json, sys
sys.path.insert(0, sys.argv[1])
import kiki_context as k
from gi.repository import Atspi

class Node:
    def __init__(self, name, text, role, kids=()):
        self.name, self.text, self.role, self.kids = name, text, role, list(kids)
    def get_role(self): return self.role
    def get_role_name(self): return "section"
    def get_text_iface(self): return self
    def get_child_count(self): return len(self.kids)
    def get_child_at_index(self, index): return self.kids[index]

k.Atspi.Text.get_character_count = staticmethod(lambda iface: len(iface.text))
k.Atspi.Text.get_text = staticmethod(lambda iface, start, end: iface.text[start:end])
lines, changes = json.loads(sys.argv[2])
kids = [Node(f"line{i}", line, Atspi.Role.SECTION) for i, line in enumerate(lines)]
root = Node("root", "\\ufffc" * len(kids), Atspi.Role.ENTRY, kids)
k.target_of = lambda request: root
k.path_from_app = lambda node: [int(node.name[4:])]
k.write_at = lambda node, start, expected, text, whole=False: {"ok": True, "start": start, "end": start + len(text)}
print(json.dumps(k.apply_changes({"pid": 1, "path": [0], "changes": changes})))`;
    const lines = ["Hello wrold and friends.", "Second line with teh typo."];
    const changes = [
      { find: "wrold", replace: "world" },
      { find: "teh typo", replace: "the typo" },
    ];
    const out = execFileSync("/usr/bin/python3", ["-c", script, join(helper, ".."), JSON.stringify([lines, changes])], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(JSON.parse(out)).toEqual({
      ok: true,
      applied: [1, 0],
      written: [
        { index: 1, path: [1], role: "section", start: 17, end: 25 },
        { index: 0, path: [0], role: "section", start: 6, end: 11 },
      ],
    });
  });
});
