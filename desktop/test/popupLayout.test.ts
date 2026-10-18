import { describe, expect, it } from "vitest";
import {
  cardBottomIn,
  insideHitRect,
  INSETS,
  popupGeometry,
} from "../resources/gnome-extension/kiki-popup@kiki.app/placement.js";
import { inside, scrollPoint } from "../resources/gnome-extension/kiki-popup@kiki.app/scroll.js";
import { formatSeconds, paragraphs, thoughtLine } from "../src/renderer/feed.ts";
import { POPUP_WIDTH, springStep, type Spring } from "../src/renderer/layout.ts";

// A 1728×1080 monitor under a 32px top bar, and a second monitor to its right.
const workArea = { x: 0, y: 32, width: 1728, height: 1048 };
const second = { x: 1728, y: 0, width: 1920, height: 1080 };

/** Where the chat box's corners land on screen. */
function card(geometry: ReturnType<typeof popupGeometry>, height: number) {
  return {
    left: geometry.x + INSETS.left,
    top: geometry.y + geometry.anchorY - height,
    bottom: geometry.y + geometry.anchorY,
  };
}

describe("popup placement", () => {
  it("opens with the chat box's corner just below and right of the pointer", () => {
    const geometry = popupGeometry({ x: 300, y: 200 }, 120, workArea);
    expect(card(geometry, 120)).toEqual({ left: 306, top: 206, bottom: 326 });
    expect(geometry.width).toBe(POPUP_WIDTH);
  });

  it("opens above the pointer near the bottom of the screen", () => {
    const geometry = popupGeometry({ x: 300, y: 1000 }, 120, workArea);
    expect(card(geometry, 120)).toMatchObject({ left: 306, bottom: 994 });
  });

  it("sizes the window once for the tallest chat box, inside the work area", () => {
    const geometry = popupGeometry({ x: 300, y: 200 }, 120, workArea);
    expect(geometry.maxCard).toBe(560);
    expect(geometry.height).toBe(INSETS.top + 560 + INSETS.bottom);
    expect(popupGeometry({ x: 0, y: 0 }, 120, { x: 0, y: 0, width: 800, height: 500 }).maxCard).toBe(350);
    for (const pointer of [{ x: 1700, y: 40 }, { x: 0, y: 1079 }, { x: 900, y: 600 }]) {
      const { x, y, width, height } = popupGeometry(pointer, 120, workArea);
      expect(x).toBeGreaterThanOrEqual(workArea.x);
      expect(y).toBeGreaterThanOrEqual(workArea.y);
      expect(x + width).toBeLessThanOrEqual(workArea.x + workArea.width);
      expect(y + height).toBeLessThanOrEqual(workArea.y + workArea.height);
    }
  });

  it("keeps the chat box where it opened near the top of the screen", () => {
    // The window can't reach above the top bar, so the box sits partway down it.
    const geometry = popupGeometry({ x: 300, y: 60 }, 120, workArea);
    expect(geometry.y).toBe(32);
    expect(card(geometry, 120)).toEqual({ left: 306, top: 66, bottom: 186 });
  });

  it("works on a monitor that doesn't start at 0, 0", () => {
    expect(card(popupGeometry({ x: 1800, y: 500 }, 120, second), 120)).toEqual({ left: 1806, top: 506, bottom: 626 });
    expect(popupGeometry({ x: 1600, y: 500 }, 120, second).x).toBe(1728);
  });
});

describe("chat box position in the window", () => {
  const height = INSETS.top + 560 + INSETS.bottom;

  it("grows upward from where it opened", () => {
    expect(cardBottomIn(500, 120, height)).toBe(500);
    expect(cardBottomIn(500, 400, height)).toBe(500);
  });

  it("slides down as it grows past the top, one pixel per pixel", () => {
    expect(cardBottomIn(154, 114, height)).toBe(154);
    expect(cardBottomIn(154, 115, height)).toBe(155);
    expect(cardBottomIn(154, 300, height)).toBe(340);
    // Never past the bottom of the window.
    expect(cardBottomIn(154, 5000, height)).toBe(height - INSETS.bottom);
  });
});

describe("chat box growth", () => {
  const run = (spring: Spring, target: number, frames: number, dt = 16) => {
    const values: number[] = [];
    for (let i = 0; i < frames; i++) {
      spring = springStep(spring, target, dt);
      values.push(spring.value);
    }
    return { spring, values };
  };

  it("settles within about two thirds of a second", () => {
    expect(run({ value: 200, velocity: 0 }, 300, 19).spring.value).toBeGreaterThan(290);
    const { spring } = run({ value: 200, velocity: 0 }, 300, 45);
    expect(Math.abs(spring.value - 300)).toBeLessThan(0.5);
    expect(Math.abs(spring.velocity)).toBeLessThan(10);
  });

  it("bounces only slightly, without jumps", () => {
    const { values } = run({ value: 200, velocity: 0 }, 300, 60);
    // A soft spring: at most 2% past the target.
    expect(Math.max(...values)).toBeLessThan(302);
    expect(Math.max(...values)).toBeGreaterThan(300);
    // No jumps: the biggest step of a 100px move is well under half of it.
    expect(Math.max(...values.map((value, index) => value - (values[index - 1] ?? 200)))).toBeLessThan(30);
  });

  it("moves the same however often it's stepped", () => {
    const once = springStep({ value: 200, velocity: 0 }, 300, 16);
    const twice = springStep(springStep({ value: 200, velocity: 0 }, 300, 8), 300, 8);
    expect(twice.value).toBeCloseTo(once.value, 6);
    expect(twice.velocity).toBeCloseTo(once.velocity, 6);
  });
});

describe("thinking feed text", () => {
  it("splits streamed summaries into paragraphs", () => {
    expect(paragraphs("First.\n\nSecond part\n \nThird")).toEqual(["First.", "Second part", "Third"]);
    expect(paragraphs("Still streaming\n\n")).toEqual(["Still streaming"]);
  });

  it("uses a bold lead-in or the first sentence, without the final period", () => {
    expect(thoughtLine("**Reading the paper on quantization.** It covers int4 and int8.")).toBe(
      "Reading the paper on quantization",
    );
    expect(thoughtLine("The user wants a definition. I'll check the page first.")).toBe(
      "The user wants a definition",
    );
    expect(thoughtLine("Checking `v2.1` on [the site](https://example.com) now")).toBe(
      "Checking v2.1 on the site now",
    );
  });

  it("cuts long lines at a word boundary", () => {
    const line = thoughtLine(`${"word ".repeat(40)}end.`, 30);
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(31);
    expect(line).not.toMatch(/ …$/);
  });

  it("formats elapsed time", () => {
    expect(formatSeconds(400)).toBe("1s");
    expect(formatSeconds(6_200)).toBe("6s");
    expect(formatSeconds(75_000)).toBe("1m 15s");
  });
});

describe("popup click-through", () => {
  // The window at (100, 50); the chat box (with Kiki and its ✕) at (16, 300) in it, 440×200.
  const frame = { x: 100, y: 50, width: 472, height: 600 };
  const hit = { x: 16, y: 300, width: 440, height: 200 };

  it("takes clicks over the chat box", () => {
    expect(insideHitRect({ x: 116, y: 350 }, frame, hit)).toBe(true);
    expect(insideHitRect({ x: 556, y: 550 }, frame, hit)).toBe(true);
  });

  it("lets clicks on the transparent space around it through", () => {
    // Above the box, in the window's transparent top.
    expect(insideHitRect({ x: 300, y: 200 }, frame, hit)).toBe(false);
    // Left of the box, inside the window's inset.
    expect(insideHitRect({ x: 105, y: 400 }, frame, hit)).toBe(false);
    // Outside the window.
    expect(insideHitRect({ x: 20, y: 400 }, frame, hit)).toBe(false);
  });
});

describe("scrollPoint", () => {
  const window = { x: 100, y: 50, width: 1000, height: 800 };

  it("scrolls in the middle of the window, a little below center", () => {
    expect(scrollPoint(window, () => true)).toEqual({ x: 600, y: 490 });
  });

  it("goes around Kiki's chat box (or another window) covering the middle", () => {
    const chatBox = { x: 450, y: 350, width: 400, height: 320 };
    const point = scrollPoint(window, (p) => !inside(p, chatBox));
    expect(point).toEqual({ x: 600, y: 330 });
    expect(inside(point!, window)).toBe(true);
  });

  it("gives up when nothing of the window can be reached", () => {
    expect(scrollPoint(window, () => false)).toBeNull();
  });
});
