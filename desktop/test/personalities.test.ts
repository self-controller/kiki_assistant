import { describe, expect, it } from "vitest";
import { personalityPrompt } from "../src/main/personalities.ts";

describe("personalityPrompt", () => {
  it("sends nothing for Kiki's usual voice or an empty prompt of your own", () => {
    expect(personalityPrompt({ personality: "default", customPersonality: "Ignored." })).toBeUndefined();
    expect(personalityPrompt({ personality: "custom", customPersonality: "  \n " })).toBeUndefined();
  });

  it("sends the built-in prompt, or your own trimmed", () => {
    expect(personalityPrompt({ personality: "camus", customPersonality: "" })).toContain("Albert Camus");
    expect(personalityPrompt({ personality: "dostoevsky", customPersonality: "" })).toContain("Fyodor Dostoevsky");
    expect(personalityPrompt({ personality: "nietzsche", customPersonality: "" })).toContain("Friedrich Nietzsche");
    expect(personalityPrompt({ personality: "custom", customPersonality: " Be terse. \n" })).toBe("Be terse.");
  });
});
