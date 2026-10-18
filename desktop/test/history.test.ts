import { LIMITS } from "@kiki/shared";
import { describe, expect, it } from "vitest";
import { earlierTurns, newEntry, upsertEntry } from "../src/main/history.ts";
import { formatWhen } from "../src/renderer/feed.ts";

describe("formatWhen", () => {
  const now = new Date(2026, 9, 12, 15, 30).getTime();

  it("counts minutes and hours today", () => {
    expect(formatWhen(now - 20_000, now)).toBe("Just now");
    expect(formatWhen(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatWhen(now - 2 * 60 * 60_000, now)).toBe("2h ago");
    expect(formatWhen(new Date(2026, 9, 12, 0, 10).getTime(), now)).toBe("15h ago");
  });

  it("names yesterday, then dates", () => {
    expect(formatWhen(new Date(2026, 9, 11, 23, 50).getTime(), now)).toBe("Yesterday");
    expect(formatWhen(new Date(2026, 9, 11, 0, 5).getTime(), now)).toBe("Yesterday");
    expect(formatWhen(new Date(2026, 9, 9, 12, 0).getTime(), now)).toBe("Oct 9");
    expect(formatWhen(new Date(2025, 11, 31, 12, 0).getTime(), now)).toBe("Dec 31, 2025");
  });
});

describe("history entries", () => {
  const context = { selection: "Kiki" };

  it("carries action cards and their outcomes into restarted conversations", () => {
    const [turn] = earlierTurns([
      {
        question: "Add it",
        answer: "Here's the event.",
        actions: [
          {
            action: { id: "a", kind: "task", title: "Pay rent", due: "2026-11-01" },
            status: { outcome: "added", message: "Added to Google Tasks." },
          },
        ],
      },
    ]);
    expect(turn!.answer).toBe('Here\'s the event.\n\n[Cards proposed: task "Pay rent", due Sun 2026-11-01. (added)]');
  });

  it("puts the latest session first, once, and keeps the newest few", () => {
    const [a, b, c] = [newEntry(context), newEntry(context), newEntry(context)];
    expect(upsertEntry([a!, b!], c!).map((entry) => entry.id)).toEqual([c!.id, a!.id, b!.id]);
    expect(upsertEntry([a!, b!, c!], b!).map((entry) => entry.id)).toEqual([b!.id, a!.id, c!.id]);
    expect(upsertEntry([a!, b!], c!, 2).map((entry) => entry.id)).toEqual([c!.id, a!.id]);
  });

  it("carries over the latest turns, with long answers cut short", () => {
    const turns = Array.from({ length: LIMITS.earlierTurns + 2 }, (_, index) => ({
      question: `Q${index}`,
      answer: index === LIMITS.earlierTurns + 1 ? "a".repeat(LIMITS.earlierAnswerChars + 50) : `A${index}`,
    }));
    const earlier = earlierTurns(turns);
    expect(earlier).toHaveLength(LIMITS.earlierTurns);
    expect(earlier[0]).toEqual({ question: "Q2", answer: "A2" });
    expect(earlier.at(-1)!.answer).toHaveLength(LIMITS.earlierAnswerChars);
  });

  it("skips turns without an answer", () => {
    expect(earlierTurns([{ question: "Q", answer: " " }, { question: "Q2", answer: "A2" }])).toEqual([
      { question: "Q2", answer: "A2" },
    ]);
  });
});
