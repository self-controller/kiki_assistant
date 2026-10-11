import { describe, expect, it } from "vitest";
import { FADE_MS, freshRanges, revealTo } from "../src/renderer/reveal.ts";

describe("answer text reveal", () => {
  const text = "Kiki shows the answer a few words at a time, so it reads smoothly as it streams in.";

  it("shows whole words", () => {
    const end = revealTo(text, 0, 16);
    expect(end).toBeGreaterThan(0);
    expect(text[end] === undefined || /\s/.test(text[end]!)).toBe(true);
  });

  it("doesn't stop on a bare list marker", () => {
    const list = "Intro.\n- First item\n- Second";
    // One frame from "Intro." reaches only the "-".
    expect(list.slice(0, revealTo(list, 6, 16))).toBe("Intro.\n- First");
  });

  it("shows everything once caught up", () => {
    expect(revealTo(text, text.length, 16)).toBe(text.length);
    expect(revealTo("", 0, 16)).toBe(0);
  });

  it("keeps a slow pace for a little text and catches up with a lot", () => {
    // One 16 ms frame with a short backlog shows a word or two, not the whole thing.
    expect(revealTo(text, 0, 16)).toBeLessThan(12);
    const long = "word ".repeat(120);
    let shown = 0;
    let frames = 0;
    while (shown < long.length && frames < 1000) {
      shown = revealTo(long, shown, 16);
      frames++;
    }
    // 600 characters arriving at once take well under a second to show.
    expect(frames * 16).toBeLessThan(1000);
    expect(frames).toBeGreaterThan(5);
  });

  it("fades in each run from where it starts to where the next one does", () => {
    const reveals = [
      { start: 0, time: 0 },
      { start: 10, time: 100 },
      { start: 25, time: 300 },
    ];
    expect(freshRanges(reveals, 40, 350)).toEqual([
      { start: 0, end: 10, age: 350 },
      { start: 10, end: 25, age: 250 },
      { start: 25, end: 40, age: 50 },
    ]);
    // Older runs have finished fading; the text shrank under the newest.
    expect(freshRanges(reveals, 20, FADE_MS + 50)).toEqual([{ start: 10, end: 20, age: FADE_MS - 50 }]);
  });
});
