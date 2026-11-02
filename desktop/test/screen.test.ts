import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Capture, SourceWindow } from "../src/main/capture/common.ts";
import type { HelperField } from "../src/main/capture/linux.ts";
import { applyEdits, describeAction } from "../src/main/google/format.ts";
import {
  clickControl,
  clickRefusal,
  dedupeScreen,
  describePresses,
  diffScreen,
  mergeFields,
  newScreenState,
  pressProblems,
  screenText,
  screenTools,
  type ControlTarget,
} from "../src/main/screen.ts";

const ZEN: SourceWindow = { pid: 4242, window: [0], toolkit: "gecko", page: true, wheel: true, keys: true };
const ALL = { text: true, window: true, screenshot: true };

function capture(source?: SourceWindow): Capture {
  return { selection: "", notes: [], ...(source ? { source } : {}) };
}

/** A control's marker as the helper writes it in the text. */
const marker = (index: number, label: string) => `${index}${label}`;

describe("screenTools", () => {
  it("offers scrolling, clicks, presses and fills where Kiki reads the window's text", () => {
    expect(screenTools(capture(ZEN), ALL)).toEqual({ screen: true, press: true, click: true, fill: true });
    // A browser fills text fields with a paste, which needs the extension to focus the window first.
    expect(screenTools(capture({ ...ZEN, keys: false }), ALL)).toEqual({ screen: true, press: true, click: true });
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

describe("dedupeScreen", () => {
  const feed = (...posts: string[]) => posts.join("\n");

  it("leaves out the lines a screen shares with the one before, after a scroll down or up", () => {
    const first = feed("Jane: my code works", "on the first try", "Sam: lunch?", "Lee: new photo", "of the lake", "at dawn");
    const second = feed("Lee: new photo", "of the lake", "at dawn", "Kim: hiring", "two engineers");
    expect(dedupeScreen(first, second, "down")).toEqual({
      text: feed("(The first 3 lines were on the previous screen.)", "Kim: hiring", "two engineers"),
      shared: 3,
    });
    expect(dedupeScreen(second, first, "up")).toEqual({
      text: feed("Jane: my code works", "on the first try", "Sam: lunch?", "(The last 3 lines were on the previous screen.)"),
      shared: 3,
    });
  });

  it("matches controls whose index changed between reads, and keeps small overlaps", () => {
    const first = feed("Jane: my code works on the first try", `${marker(0, "Like")} ${marker(1, "Comment")}`);
    const second = feed("Jane: my code works on the first try", `${marker(3, "Like")} ${marker(4, "Comment")}`, "Sam: lunch?");
    expect(dedupeScreen(first, second, "down")).toEqual({ text: feed("(The first 2 lines were on the previous screen.)", "Sam: lunch?"), shared: 2 });
    // One short line (a heading, "Like") says nothing about where the last screen ended.
    expect(dedupeScreen(feed("Posts", "Like"), feed("Like", "Sam: lunch?"), "down")).toEqual({ text: feed("Like", "Sam: lunch?"), shared: 0 });
  });

  it("says when nothing is new, and leaves the first screen alone", () => {
    expect(dedupeScreen("A\nB\nC", "A\nB\nC", "down")).toEqual({ text: "(Nothing new: all of this screen was on the previous one.)", shared: 3 });
    expect(dedupeScreen(undefined, "A\nB", "down")).toEqual({ text: "A\nB", shared: 0 });
    expect(dedupeScreen("X\nY", "A\nB", "down")).toEqual({ text: "A\nB", shared: 0 });
  });
});

describe("diffScreen", () => {
  const lines = (count: number, prefix = "Line") => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);

  it("folds the lines a page kept into a note, with a line of context around what changed", () => {
    const before = [...lines(10), "Comments (3)", ...lines(8, "Comment")].join("\n");
    const after = [...lines(10), "Comments (4)", "Comment new", ...lines(8, "Comment")].join("\n");
    const { text, diffed } = diffScreen(before, after);
    expect(diffed).toBe(true);
    expect(text.split("\n")).toEqual([
      "(… 9 lines unchanged, as in your last look …)",
      "Line 10",
      "Comments (4)",
      "Comment new",
      "Comment 1",
      "(… 7 lines unchanged, as in your last look …)",
    ]);
  });

  it("keeps short unchanged runs, and sends the whole screen when most of it changed", () => {
    const before = ["A", "B", "C", "D"].join("\n");
    expect(diffScreen(before, ["A", "B", "X", "D"].join("\n"))).toEqual({ text: "A\nB\nX\nD", diffed: true });
    const changed = ["A", "x", "y", "z", "w"].join("\n");
    expect(diffScreen(before, changed)).toEqual({ text: changed, diffed: false });
  });

  it("says when nothing changed, and leaves a first read alone", () => {
    expect(diffScreen("A\nB", "A\nB")).toEqual({ text: "(The page reads the same as your last look.)", diffed: true });
    expect(diffScreen(undefined, "A\nB")).toEqual({ text: "A\nB", diffed: false });
    expect(diffScreen("A\nB", "")).toEqual({ text: "", diffed: false });
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

  it("numbers fields on a page a click opened after the ones on the page it left", () => {
    const into = capture(ZEN);
    into.form = { pid: 4242, selectPaste: true, fields: [], lastId: 3 };
    expect(mergeFields(into, ZEN, [field("Search", [0, 2])]).map((f) => f.id)).toEqual(["f4"]);
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

describe("clicks", () => {
  const control = (role: string, name: string): ControlTarget => ({ id: "b4", path: [0, 4], role, name, near: "" });

  it("press links, tabs and plain buttons right away", () => {
    expect(clickRefusal(control("link", "MIT license"))).toBeNull();
    expect(clickRefusal(control("page tab", "Issues"))).toBeNull();
    expect(clickRefusal(control("menu item", "Newest first"))).toBeNull();
    expect(clickRefusal(control("push button", "Show more"))).toBeNull();
  });

  it("press the same things in Kiki's browser, by Chrome's role names", () => {
    expect(clickRefusal(control("tab", "Issues"))).toBeNull();
    expect(clickRefusal(control("menuitem", "Newest first"))).toBeNull();
    expect(clickRefusal(control("button", "Show more"))).toBeNull();
    expect(clickRefusal(control("treeitem", "src"))).toBeNull();
    expect(clickRefusal(control("option", "Blue"))).toBeNull();
    expect(clickRefusal(control("button", "Like"))).toContain("propose_press");
    expect(clickRefusal(control("togglebutton", "Reactions"))).toContain("propose_press");
  });

  it("press anything but what pays when the person set Kiki to act without asking", () => {
    const auto = { auto: true };
    expect(clickRefusal(control("push button", "Like"), auto)).toBeNull();
    expect(clickRefusal(control("toggle button", "Follow"), auto)).toBeNull();
    expect(clickRefusal(control("button", "Send"), auto)).toBeNull();
    expect(clickRefusal(control("check box", "Remember me"), auto)).toBeNull();
    for (const name of ["Buy now", "Checkout", "Place your order", "Pay", "Confirm payment", "Subscribe now"]) {
      expect(clickRefusal(control("button", name), auto), name).toContain("pays for something");
    }
    // Off, the usual rule holds.
    expect(clickRefusal(control("push button", "Like"), { auto: false })).toContain("propose_press");
  });

  it("answer a cookie notice right away, with its own buttons", () => {
    expect(clickRefusal({ ...control("button", "Accept all"), consent: true })).toBeNull();
    expect(clickRefusal({ ...control("button", "Reject all"), consent: true })).toBeNull();
    // Without the notice around it, an Accept button may accept anything.
    expect(clickRefusal(control("button", "Accept all"))).toContain("propose_press");
  });

  it("leave toggles and anything that changes something to a press card", () => {
    expect(clickRefusal(control("toggle button", "Reactions"))).toContain("propose_press");
    expect(clickRefusal(control("push button", "Like"))).toContain("b4 (Like) may change something");
    for (const name of ["Send", "Delete repository", "Follow", "Buy now", "Sign out", "Star this repository", "Download ZIP"]) {
      expect(clickRefusal(control("push button", name)), name).not.toBeNull();
      expect(clickRefusal(control("link", name)), name).not.toBeNull();
    }
    // Unknown roles (a check box is a field) aren't clicked either.
    expect(clickRefusal(control("check box", "Remember me"))).not.toBeNull();
  });

  it("only click controls Kiki read, and never one that needs a card", async () => {
    const state = newScreenState();
    screenText(`Jane: my code works ${marker(0, "Like")} ${marker(1, "Jane Doe")}`, [
      { path: [0, 5, 2], role: "push button", name: "Like" },
      { path: [0, 5, 3], role: "link", name: "Jane Doe" },
    ], state);
    const click = (control: string, source = ZEN) => clickControl(capture(source), state, { id: "t1", input: { control } }, ALL);
    expect((await click("b9")).result).toMatchObject({ isError: true, content: expect.stringContaining("look or scroll first") });
    expect((await click("b1")).result).toMatchObject({ isError: true, content: expect.stringContaining("propose_press") });
    expect((await click("b2", { ...ZEN, pid: undefined })).result.content).toBe("Kiki can't click anything in this window.");
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
    def get_component_iface(self): return None
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

  it("reads a container Firefox left without “showing” while its box is in view", () => {
    const read = run(
      `k.window_box = lambda obj: tuple(obj.spec["box"]) if "box" in obj.spec else None
out = k.read_screen(None, Node({"role": "frame", "name": "Issues", "kids": [data]}))
print(json.dumps(out["text"]))`,
      {
        role: "document_web",
        box: [0, 0, 1000, 800],
        kids: [
          { role: "section", states: ["visible"], box: [200, -40, 800, 2000], kids: [{ role: "link", name: "TypeError: Missing parameter", text: "TypeError: Missing parameter" }] },
          { role: "section", states: ["visible"], box: [200, 2400, 800, 900], kids: [{ role: "paragraph", text: "Further down" }] },
          { role: "section", states: ["visible"], kids: [{ role: "paragraph", text: "Nowhere" }] },
        ],
      },
    ) as string;
    expect(read).toContain("TypeError: Missing parameter");
    expect(read).not.toContain("Further down");
    expect(read).not.toContain("Nowhere");
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

  it("clicks, then waits for the page it opened to load and draw before reading the screen", () => {
    const result = run(
      `k.target_of = lambda request: Node({"role": "link", "name": "MIT license"})
k.Atspi.Action.get_action_name = staticmethod(lambda iface, index: "jump")
k.Atspi.Action.do_action = staticmethod(lambda iface, index: True)
k.CLICK_QUIET_SECONDS, k.CLICK_SETTLE_SECONDS, k.CLICK_LOAD_SECONDS = 0.3, 0, 2
frame = Node({"role": "frame", "name": "LICENSE", "kids": [data]})
k.find_source = lambda pid, window: (None, frame)
request = {"pid": 1, "window": [0], "path": [0, 2], "role": "link", "name": "MIT license"}
urls = iter(["https://github.com/x/y", "https://github.com/x/y", "https://github.com/x/y?tab=MIT-1-ov-file"])
k.page_url = lambda window: next(urls, "https://github.com/x/y?tab=MIT-1-ov-file")
loading = iter([True, True, False])
k.page_loading = lambda window: next(loading, False)
# The address changes first; the page draws the license a moment later.
screens = iter(["repo", "repo", "repo", "license", "license", "license"])
k.read_screen = lambda app, window: {"text": next(screens, "after"), "windowTitle": "x/y"}
opened = k.click(request)
# A click that opens nothing reads the screen once it's still.
k.page_url = lambda window: "https://github.com/x/y"
screens = iter(["list", "list longer", "list longest", "list longest"])
in_place = k.click(request)
k.target_of = lambda request: Node({"role": "link", "name": "Apache license"})
moved = k.click(request)
print(json.dumps([opened["ok"], opened["navigated"], opened["text"], next(loading, "done"), in_place["navigated"], in_place["text"], moved]))`,
      page,
    );
    expect(result).toEqual([true, true, "license", "done", false, "list longest", { ok: false, reason: "moved" }]);
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
