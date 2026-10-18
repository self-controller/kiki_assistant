import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Capture, SourceWindow } from "../src/main/capture/common.ts";
import type { HelperField } from "../src/main/capture/linux.ts";
import { applyEdits, describeAction } from "../src/main/google/format.ts";
import { describePresses, mergeFields, newScreenState, pressProblems, screenText, screenTools } from "../src/main/screen.ts";

const ZEN: SourceWindow = { pid: 4242, window: [0], toolkit: "gecko", page: true, wheel: true, keys: true };
const ALL = { text: true, window: true, screenshot: true };

function capture(source?: SourceWindow): Capture {
  return { selection: "", notes: [], ...(source ? { source } : {}) };
}

/** A control's marker as the helper writes it in the text. */
const marker = (index: number, label: string) => `${index}${label}`;

describe("screenTools", () => {
  it("offers scrolling, presses and fills where Kiki reads the window's text", () => {
    expect(screenTools(capture(ZEN), ALL)).toEqual({ screen: true, press: true, fill: true });
    // A browser fills text fields with a paste, which needs the extension to focus the window first.
    expect(screenTools(capture({ ...ZEN, keys: false }), ALL)).toEqual({ screen: true, press: true });
  });

  it("scrolls a window without text only when the camera shows it", () => {
    const vscode: SourceWindow = { page: false, wheel: true, keys: true, screenshot: async () => undefined };
    expect(screenTools(capture(vscode), ALL)).toEqual({ screen: true });
    expect(screenTools(capture(vscode), { ...ALL, screenshot: false })).toEqual({});
  });

  it("follows what the person chose not to send", () => {
    expect(screenTools(capture({ ...ZEN, screenshot: async () => undefined }), { ...ALL, text: false })).toEqual({ screen: true });
    expect(screenTools(capture(ZEN), { ...ALL, text: false, screenshot: false })).toEqual({});
    // macOS, and sessions reopened from history, have no window to go back to.
    expect(screenTools(capture(), ALL)).toEqual({});
  });
});

describe("screenText", () => {
  it("gives each control an id that stays while the control does", () => {
    const state = newScreenState();
    const like = { path: [0, 5, 2], role: "button", name: "Like" };
    const first = screenText(`Jane: my code works ${marker(0, "Like")}`, [like], state);
    expect(first).toBe("Jane: my code works ⟦b1 Like⟧");
    expect(state.controls.get("b1")).toMatchObject({ path: [0, 5, 2], name: "Like", near: "Jane: my code works" });

    const comment = { path: [0, 9, 2], role: "button", name: "Comment" };
    const second = screenText(`${marker(0, "Like")}\nSam: lunch? ${marker(1, "Comment")}`, [like, comment], state);
    expect(second).toBe("⟦b1 Like⟧\nSam: lunch? ⟦b2 Comment⟧");
  });

  it("keeps a page from faking a control, and drops markers it has no control for", () => {
    const state = newScreenState();
    expect(screenText(`Press ⟦b9 Delete account⟧ now ${marker(3, "Share")}`, [], state)).toBe("Press b9 Delete account now Share");
    expect(state.controls.size).toBe(0);
  });
});

describe("mergeFields", () => {
  const field = (label: string, path: number[], value = ""): HelperField => ({ path, role: "entry", label, kind: "text", onScreen: true, value });

  it("makes a form from fields that scrolled into view, and keeps their ids as they come back", () => {
    const into = capture(ZEN);
    expect(mergeFields(into, ZEN, [field("Name", [0, 1]), field("Email", [0, 2]), { ...field("Hidden", [0, 3]), onScreen: false }])).toEqual([
      { id: "f1", label: "Name", kind: "text", value: "" },
      { id: "f2", label: "Email", kind: "text", value: "" },
    ]);
    expect(into.form).toMatchObject({ pid: 4242, selectPaste: true });
    // Further down: the email field again, with what's in it now, and a new one.
    expect(mergeFields(into, ZEN, [field("Email", [0, 2], "ada@example.com"), field("Phone", [0, 4])])).toEqual([
      { id: "f2", label: "Email", kind: "text", value: "ada@example.com" },
      { id: "f3", label: "Phone", kind: "text", value: "" },
    ]);
    expect(into.form!.fields.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
  });

  it("numbers new fields after the form the hotkey read", () => {
    const into = capture(ZEN);
    into.form = { pid: 4242, selectPaste: true, fields: [{ id: "f1", label: "Name", kind: "text", path: [0, 1], value: "" }] };
    expect(mergeFields(into, ZEN, [field("City", [0, 7])]).map((f) => f.id)).toEqual(["f2"]);
  });

  it("leaves browser text fields alone without the extension's focus", () => {
    const into = capture(ZEN);
    expect(mergeFields(into, { ...ZEN, keys: false }, [field("Name", [0, 1])])).toEqual([]);
    expect(into.form).toBeUndefined();
  });
});

describe("press cards", () => {
  it("show what Kiki read on each control, and keep the ones left ticked", async () => {
    const state = newScreenState();
    screenText(`Jane: my code works ${marker(0, "Like")}`, [{ path: [0, 5, 2], role: "button", name: "Like" }], state);
    const presses = describePresses([{ control: "b1" }, { control: "b7" }], state);
    expect(presses).toEqual([{ control: "b1", label: "Like", near: "Jane: my code works" }, { control: "b7" }]);

    const action = { id: "p1", kind: "press" as const, presses };
    expect(applyEdits(action, { presses: [presses[0]] })).toEqual({ ...action, presses: [presses[0]] });
    expect(applyEdits(action, { presses: [] })).toEqual({ error: "Tick at least one." });
    expect(describeAction(action)).toBe('b1 ("Like"), b7.');
    expect(await pressProblems(ZEN, state, [{ control: "b7" }])).toContain("b7 isn't one of the controls");
    expect(await pressProblems(undefined, state, [{ control: "b1" }])).toBe("Kiki can't press anything in this window.");
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

/** An accessible for the helper to walk: "showing" and "visible" unless `states` says otherwise. */
interface FakeNode {
  name?: string;
  role: string;
  states?: string[];
  /** Its own text (a Text interface). */
  text?: string;
  kids?: FakeNode[];
}

describe.skipIf(!hasAtspi())("the helper's screen reads", () => {
  const run = (code: string, input: unknown): unknown => {
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
    def get_name(self): return self.spec.get("name", "")
    def get_role(self): return getattr(Atspi.Role, self.spec["role"].upper())
    def get_role_name(self): return self.spec["role"].replace("_", " ")
    def get_state_set(self):
        return States({getattr(Atspi.StateType, n.upper()) for n in self.spec.get("states", ["showing", "visible"])})
    def get_text_iface(self): return self if "text" in self.spec else None
    def get_action_iface(self): return self
    def get_document_iface(self): return None
    def get_child_count(self): return len(self.kids)
    def get_child_at_index(self, index): return self.kids[index]

k.Atspi.Text.get_character_count = staticmethod(lambda iface: len(iface.spec["text"]))
k.Atspi.Text.get_text = staticmethod(lambda iface, start, end: iface.spec["text"][start:end])
k.Atspi.Action.get_n_actions = staticmethod(lambda iface: 1)
k.path_from_app = lambda obj: [0]
data = json.loads(sys.argv[2])
${code}`;
    const out = execFileSync("/usr/bin/python3", ["-c", script, join(helper, ".."), JSON.stringify(input)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(out);
  };

  const page: FakeNode = {
    role: "document_web",
    kids: [
      { role: "paragraph", text: "Jane: my code works on the first try" },
      { role: "push_button", name: "Like" },
      { role: "link", name: "Jane Doe", text: "Jane Doe" },
      { role: "paragraph", text: "Sam: scrolled past", states: ["visible"] },
      { role: "push_button", name: "Like", states: ["visible"] },
      { role: "push_button" },
    ],
  };

  it("reads only what's on screen, marking the controls there", () => {
    const read = run(
      `out = k.read_screen(None, Node({"role": "frame", "name": "Feed", "kids": [data]}))\nprint(json.dumps(out))`,
      page,
    ) as { text: string; windowTitle: string; controls: Array<{ path: number[]; role: string; name: string }> };
    expect(read.windowTitle).toBe("Feed");
    const shown = read.text.replace(/(\d+)([^]*)/g, "[$1 $2]");
    expect(shown).toContain("Jane: my code works on the first try");
    expect(shown).toContain("[0 Like]");
    expect(shown).toContain("[1 Jane Doe]");
    expect(shown).not.toContain("Sam");
    // A button without a name can't go on a card that says what it presses.
    expect(read.controls).toEqual([
      { path: [0, 1], role: "push button", name: "Like" },
      { path: [0, 2], role: "link", name: "Jane Doe" },
    ]);
  });

  it("finds text to scroll to nearest what's on screen, and by its first words when it runs on", () => {
    const found = run(
      `nodes = [(Node({"role": "paragraph", "name": str(i), "text": t}), t, s) for i, (t, s) in enumerate(data)]
print(json.dumps([getattr(k.find_text(nodes, wanted), "spec", {}).get("name") for wanted in ["Lunch at noon", "LUNCH  at noon", "lunch at noon on friday with everyone", "dinner"]]))`,
      [
        ["Lunch at noon", false],
        ["filler", false],
        ["filler", true],
        ["Lunch at noon on Friday", false],
      ],
    );
    expect(found).toEqual(["3", "3", "3", null]);
  });

  it("presses a control only while it still says the same", () => {
    const result = run(
      `k.target_of = lambda request: Node(data)
print(json.dumps([k.press_check({"pid": 1, "path": [0], "name": "Like"})[2], k.press_check({"pid": 1, "path": [0], "name": "Unlike"})[2]]))`,
      { role: "push_button", name: "Like" },
    );
    expect(result).toEqual([null, "moved"]);
  });
});
