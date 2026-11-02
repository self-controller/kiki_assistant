import { describe, expect, it } from "vitest";
import { isNewPage, needsContext, pageOf } from "../src/main/recapture.ts";

describe("a highlight the hotkey brings into an open chat", () => {
  const page = {
    appName: "Zen",
    windowTitle: "Kiki docs",
    url: "https://kiki.app/docs",
    text: "Kiki is a triangle. It sits on the box.",
  };

  it("is on a new page in another app, window or address", () => {
    expect(isNewPage(page, page)).toBe(false);
    expect(isNewPage(page, { ...page, windowTitle: "Other" })).toBe(true);
    expect(isNewPage(page, { ...page, url: "https://kiki.app/faq" })).toBe(true);
    expect(isNewPage(null, page)).toBe(true);
    expect(pageOf({ ...page, selection: "x" } as typeof page)).toEqual(page);
  });

  it("brings the window's context from a new page", () => {
    expect(needsContext(page, { ...page, url: "https://kiki.app/faq", selection: "FAQ" }, false)).toBe(true);
  });

  it("leaves the context out when the conversation's text has the highlight", () => {
    const next = { ...page, text: "It sits on the box. More below.", selection: "sits on the box" };
    expect(needsContext(page, next, false)).toBe(false);
    expect(needsContext(page, { ...page, selection: "triangle" }, false)).toBe(false);
  });

  it("brings new text on the same page when the highlight is outside what was sent", () => {
    const next = { ...page, text: "Further down: the popup stays on top.", selection: "stays on top" };
    expect(needsContext(page, next, false)).toBe(true);
    // Unless the person left the text out.
    expect(needsContext(page, next, true)).toBe(false);
  });

  it("brings changed text when nothing is highlighted", () => {
    expect(needsContext(page, { ...page, text: "New messages", selection: "" }, false)).toBe(true);
    expect(needsContext(page, { ...page, selection: "" }, false)).toBe(false);
  });
});
