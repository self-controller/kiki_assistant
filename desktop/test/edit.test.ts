import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { ProposedAction } from "@kiki/shared";
import { describe, expect, it } from "vitest";
import type { EditTarget } from "../src/main/capture/common.ts";
import { linuxEditTarget, withoutText } from "../src/main/capture/linux.ts";
import { editInfo, retarget } from "../src/main/edit.ts";
import { applyEdits, describeAction } from "../src/main/google/format.ts";

const EDIT: Extract<ProposedAction, { kind: "edit" }> = { id: "x1", kind: "edit", text: "  return total;\n" };

const FIELD = {
  pid: 4242,
  path: [0, 3, 1],
  role: "text",
  start: 10,
  end: 15,
  expected: "teh c",
  editable: true,
  kind: "editor" as const,
};

describe("linuxEditTarget", () => {
  it("writes over AT-SPI where the text is editable, and pastes as a fallback", () => {
    const target = linuxEditTarget({ ok: true, source: "editor", edit: FIELD }, "teh c", true);
    expect(target).toEqual({
      mode: "replace",
      original: "teh c",
      kind: "editor",
      atspi: { pid: 4242, path: [0, 3, 1], role: "text", start: 10, end: 15 },
      paste: true,
    });
    expect(linuxEditTarget({ ok: true, edit: { ...FIELD, start: 10, end: 10, expected: "" } }, "", false)).toMatchObject({
      mode: "insert",
      original: "",
      paste: false,
    });
  });

  it("pastes where AT-SPI can't write, and needs the extension for it", () => {
    const rich = { ok: true, edit: { ...FIELD, editable: false, kind: "field" as const } };
    expect(linuxEditTarget(rich, "teh c", true)).toEqual({ mode: "replace", original: "teh c", kind: "field", paste: true });
    expect(linuxEditTarget(rich, "teh c", false)).toBeUndefined();
  });

  it("inserts at a terminal's prompt, whatever is highlighted", () => {
    const terminal = { ok: true, source: "terminal" as const, edit: { ...FIELD, editable: false, kind: "terminal" as const } };
    expect(linuxEditTarget(terminal, "ls output", true)).toMatchObject({ mode: "insert", original: "", kind: "terminal" });
  });

  it("pastes into apps that share no text, but not into pages without a cursor", () => {
    expect(linuxEditTarget({ ok: true, source: "none" }, "const a = 1", true)).toEqual({
      mode: "replace",
      original: "const a = 1",
      kind: "unknown",
      paste: true,
    });
    expect(linuxEditTarget({ ok: true, source: "none" }, "", true)).toMatchObject({ mode: "insert" });
    expect(linuxEditTarget({ ok: true, source: "document", text: "An article." }, "article", true)).toBeUndefined();
    expect(linuxEditTarget({ ok: false, error: "timed out" }, "article", true)).toBeUndefined();
  });

  it("knows a page has text when the quick read left it for later", () => {
    expect(linuxEditTarget({ ok: true, source: "document", text: "", hasText: true }, "article", true)).toBeUndefined();
    expect(linuxEditTarget({ ok: true, source: "window", text: "", hasText: false }, "", true)).toMatchObject({ kind: "unknown" });
  });
});

describe("withoutText", () => {
  it("keeps what's highlighted and the cursor, and drops the text around them", () => {
    const vicinity = { kind: "editor" as const, before: "let ", anchor: "teh c", after: " = 1;" };
    const context = withoutText({
      ok: true,
      source: "editor",
      selection: "teh c",
      vicinity,
      edit: { ...FIELD, full: { text: "let teh c = 1;" } },
    });
    expect(context).toEqual({ ok: true, source: "editor", selection: "teh c", edit: FIELD, hasText: true });
    // Without its text, an editor is still somewhere to write in, not an app that shares none.
    expect(linuxEditTarget(withoutText({ ok: true, source: "editor", vicinity }), "", true)).toBeUndefined();
    expect(withoutText({ ok: true, source: "none" })).toEqual({ ok: true, source: "none" });
  });

  it("drops a page's text and its form", () => {
    const fields = [{ path: [1], label: "Name", kind: "text" as const, onScreen: true, value: "Ada" }];
    expect(withoutText({ ok: true, source: "document", text: "An article.", focus: 3, fields, url: "https://a.example" })).toEqual({
      ok: true,
      source: "document",
      url: "https://a.example",
      hasText: true,
    });
  });
});

describe("retarget", () => {
  const target = (): EditTarget => ({
    mode: "replace",
    original: "teh c",
    kind: "editor",
    atspi: { pid: 1, path: [0], start: 10, end: 15 },
    paste: true,
  });

  it("moves onto Kiki's text after a direct write", () => {
    const next = target();
    retarget(next, "the cat", { start: 10, end: 17 });
    expect(next).toMatchObject({ mode: "replace", original: "the cat", atspi: { start: 10, end: 17 } });
    // Still written over AT-SPI, so changes in several places can go there too.
    expect(editInfo(next)).toEqual({ mode: "replace", kind: "editor", original: "the cat", changes: "text" });
  });

  it("inserts at the cursor after a paste, which leaves nothing highlighted", () => {
    const next = target();
    retarget(next, "the cat");
    expect(next.atspi).toBeUndefined();
    expect(next).toMatchObject({ mode: "insert", original: "" });
  });
});

describe("edit cards", () => {
  it("keeps the person's edits, whitespace and all", () => {
    expect(applyEdits(EDIT, { text: "\treturn sum;\n", kind: "task", id: "other" })).toEqual({
      id: "x1",
      kind: "edit",
      text: "\treturn sum;\n",
    });
    expect(applyEdits(EDIT, {})).toEqual(EDIT);
    expect(applyEdits(EDIT, { text: "  \n" })).toEqual({ error: "There's no text to put in." });
  });

  it("describes the text for Claude", () => {
    expect(describeAction(EDIT)).toBe('The text "  return total;\n" (16 characters).');
    expect(describeAction({ ...EDIT, text: "a".repeat(300) })).toContain(`"${"a".repeat(200)}…" (300 characters)`);
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

describe.skipIf(!hasAtspi())("the helper's relocate", () => {
  const relocate = (text: string, expected: string, at: number): number | null => {
    const script = `import json, sys; sys.path.insert(0, sys.argv[1]); import kiki_context as k; print(json.dumps(k.relocate(*json.loads(sys.argv[2]))))`;
    const out = execFileSync("/usr/bin/python3", ["-c", script, join(helper, ".."), JSON.stringify([text, expected, at])], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(out) as number | null;
  };

  it("finds the original where it was, or its one other place", () => {
    expect(relocate("hello world", "world", 6)).toBe(6);
    // Something was typed before it.
    expect(relocate("oh, hello world", "world", 6)).toBe(10);
    // Gone, or ambiguous.
    expect(relocate("hello there", "world", 6)).toBeNull();
    expect(relocate("world, world", "world", 3)).toBeNull();
    // Inserts go where the caret was, while that's in the text.
    expect(relocate("abc", "", 3)).toBe(3);
    expect(relocate("abc", "", 4)).toBeNull();
  });
});

/** An accessible for the helper to walk: "showing" and "visible" unless `states` says otherwise. */
interface FakeNode {
  name: string;
  role: "frame" | "tool_bar" | "panel" | "combo_box" | "entry" | "text" | "menu_bar";
  states?: string[];
  /** Has a Text interface, with this highlighted span. */
  text?: { span?: [number, number] };
  kids?: FakeNode[];
}

describe.skipIf(!hasAtspi())("the helper's find_anchor", () => {
  /** The name of the object find_anchor settles on, and whether it holds a highlight or just the cursor. */
  const anchor = (window: FakeNode): { selected?: string; focused?: string } => {
    const script = `
import json, sys
sys.path.insert(0, sys.argv[1])
import kiki_context as k
from gi.repository import Atspi

class States:
    def __init__(self, names): self.names = names
    def contains(self, state): return state in self.names

class Node:
    def __init__(self, spec):
        self.spec = spec
        self.kids = [Node(kid) for kid in spec.get("kids", [])]
    def get_role(self): return getattr(Atspi.Role, self.spec["role"].upper())
    def get_state_set(self):
        names = self.spec.get("states", ["showing", "visible"])
        return States({getattr(Atspi.StateType, name.upper()) for name in names})
    def get_text_iface(self): return self if "text" in self.spec else None
    def get_child_count(self): return len(self.kids)
    def get_child_at_index(self, index): return self.kids[index]

k.selected_span = lambda iface: tuple(iface.spec["text"]["span"]) if iface.spec["text"].get("span") else None
found = {}
k.find_anchor(Node(json.loads(sys.argv[2])), k.Budget(1, 5, 1000), found)
print(json.dumps({key: value[0].spec["name"] for key, value in found.items()}))`;
    const out = execFileSync("/usr/bin/python3", ["-c", script, join(helper, ".."), JSON.stringify(window)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(out) as { selected?: string; focused?: string };
  };

  const page: FakeNode = { name: "page", role: "panel", kids: [{ name: "body", role: "text", text: {} }] };

  it("finds the cursor in a browser's address bar, inside its toolbar", () => {
    const urlbar: FakeNode = {
      name: "Search...",
      role: "combo_box",
      states: ["showing", "visible", "focused", "editable"],
      text: {},
    };
    const window: FakeNode = { name: "Zen", role: "frame", kids: [{ name: "nav", role: "tool_bar", kids: [urlbar] }, page] };
    expect(anchor(window)).toEqual({ focused: "Search..." });
    const highlighted = { ...urlbar, text: { span: [0, 4] as [number, number] } };
    expect(anchor({ ...window, kids: [{ name: "nav", role: "tool_bar", kids: [highlighted] }, page] })).toEqual({
      selected: "Search...",
    });
  });

  it("ignores an old highlight left in a toolbar once the cursor is elsewhere", () => {
    const urlbar: FakeNode = { name: "Search...", role: "combo_box", text: { span: [0, 20] } };
    const window: FakeNode = { name: "Zen", role: "frame", kids: [{ name: "nav", role: "tool_bar", kids: [urlbar] }, page] };
    expect(anchor(window)).toEqual({});
  });

  it("still skips menus", () => {
    const field: FakeNode = { name: "in menu", role: "entry", states: ["showing", "visible", "focused"], text: {} };
    expect(anchor({ name: "app", role: "frame", kids: [{ name: "menus", role: "menu_bar", kids: [field] }] })).toEqual({});
  });
});
