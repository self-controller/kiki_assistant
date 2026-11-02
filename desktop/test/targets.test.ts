import { describe, expect, it } from "vitest";
import { newScreenState, screenText } from "../src/main/screen.ts";
import { newTargets, readyNote, sensitiveText, targetLabel, waitsForPerson, type Target } from "../src/main/targets.ts";

describe("sensitiveText", () => {
  it("spots card numbers, ID numbers, account numbers and keys", () => {
    expect(sensitiveText("4242 4242 4242 4242")).toBe("a card number");
    expect(sensitiveText("4242-4242-4242-4243")).toBeNull();
    expect(sensitiveText("my SSN is 123-45-6789")).toBe("an ID number");
    expect(sensitiveText("GB82WEST12345698765432")).toBe("an account number");
    expect(sensitiveText("sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).toBe("an API key");
    expect(sensitiveText("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe("an API key");
    expect(sensitiveText("0123456789abcdef0123456789abcdef")).toBe("a key or token");
  });

  it("lets ordinary text through", () => {
    expect(sensitiveText("cute puppies")).toBeNull();
    expect(sensitiveText("221B Baker Street")).toBeNull();
    expect(sensitiveText("order 12345")).toBeNull();
  });
});

describe("waitsForPerson", () => {
  const screen = newScreenState();
  screenText(`\ue0010\ue002Like\ue003 \ue0011\ue002Buy now\ue003`, [
    { path: [0, 1], role: "push button", name: "Like" },
    { path: [0, 2], role: "push button", name: "Buy now" },
  ], screen);
  const target: Target = {
    kind: "window",
    source: true,
    screen,
    capture: {
      selection: "",
      notes: [],
      form: {
        pid: 1,
        selectPaste: false,
        fields: [
          { id: "f1", label: "Name", kind: "text", value: "", path: [0, 3] },
          { id: "f2", label: "Password", kind: "text", value: "", path: [0, 4], password: true },
        ],
      },
    },
  };

  it("lets ordinary cards through when Kiki acts without asking", () => {
    expect(waitsForPerson(target, { id: "a", kind: "fill", fields: [{ field: "f1", value: "Ada" }] })).toBeNull();
    expect(waitsForPerson(target, { id: "a", kind: "press", presses: [{ control: "b1" }] })).toBeNull();
    expect(waitsForPerson(target, { id: "a", kind: "edit", text: "Fixed the typo." })).toBeNull();
    expect(waitsForPerson(target, { id: "a", kind: "changes", changes: [{ find: "teh", replace: "the" }] })).toBeNull();
  });

  it("keeps passwords, sensitive numbers and payments for the person", () => {
    expect(waitsForPerson(target, { id: "a", kind: "fill", fields: [{ field: "f2", value: "hunter2" }] })).toBe("it fills a password field");
    expect(waitsForPerson(target, { id: "a", kind: "fill", fields: [{ field: "f1", value: "4242 4242 4242 4242" }] })).toBe("it types a card number");
    expect(waitsForPerson(target, { id: "a", kind: "press", presses: [{ control: "b1" }, { control: "b2" }] })).toBe("it pays for something");
    expect(waitsForPerson(target, { id: "a", kind: "edit", text: "SSN 123-45-6789" })).toBe("it writes an ID number");
    expect(waitsForPerson(target, { id: "a", kind: "changes", changes: [{ find: "x", replace: "4242424242424242" }] })).toBe("it writes a card number");
  });
});

describe("readyNote", () => {
  const ready = { url: "https://example.com/next", quiet: true, waitedMs: 420 };

  it("says where the page went, and when it's still loading", () => {
    expect(readyNote(undefined)).toEqual([]);
    expect(readyNote({ ...ready, navigated: "none", loading: false })).toEqual([]);
    expect(readyNote({ ...ready, navigated: "page", loading: false })).toEqual(["The page changed to https://example.com/next."]);
    expect(readyNote({ ...ready, navigated: "in-page", loading: false })).toEqual(["The address changed to https://example.com/next (the same page, updated in place)."]);
    expect(readyNote({ ...ready, navigated: "page", loading: true, waitedMs: 8_200 })).toEqual([
      "The page changed to https://example.com/next.",
      "The page is still loading after 8 s, so what's below may be incomplete: act on it, or look again in a moment.",
    ]);
  });
});

describe("targets", () => {
  it("start on the window the question came from, with no chip", () => {
    const capture = { selection: "", appName: "Zen", windowTitle: "Example", notes: [] };
    const targets = newTargets(capture, newScreenState());
    expect(targets.current).toBe(targets.source);
    expect(targetLabel(targets.current)).toEqual({ kind: "window", label: null });
    expect(targetLabel({ kind: "window", capture: { ...capture, appName: "Files", windowTitle: "Downloads" }, screen: newScreenState(), source: false })).toEqual({
      kind: "window",
      label: "Files — Downloads",
    });
  });
});
