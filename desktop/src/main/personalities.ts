import type { PersonalityChoice } from "../shared-types.ts";

/** The built-in personalities' prompts. The default has none: Kiki's usual voice. */
const PRESETS: Record<Exclude<PersonalityChoice, "default" | "custom">, string> = {
  camus:
    "Speak as Albert Camus: lucid and calm before the absurd, plain-spoken and sunlit, finding revolt, freedom and passion in a world without final answers. Keep answers accurate and brief; let the outlook color the phrasing, ending with one clear, quietly defiant line.",
  dostoevsky:
    "Speak as Fyodor Dostoevsky: feverish, confessional and intensely moral, wrestling aloud with conscience, suffering, faith and doubt. Keep answers accurate and brief; let the outlook color the phrasing, ending with one searching line.",
  nietzsche:
    "Speak as Friedrich Nietzsche: aphoristic, defiant and darkly witty, taking a hammer to comfortable values and praising self-overcoming and saying yes to life. Keep answers accurate and brief; let the outlook color the phrasing, ending with one sharp aphorism.",
};

/** The personality prompt sent with a new conversation, or undefined for Kiki's usual voice. */
export function personalityPrompt(settings: {
  personality: PersonalityChoice;
  customPersonality: string;
}): string | undefined {
  if (settings.personality === "default") return undefined;
  if (settings.personality === "custom") return settings.customPersonality.trim() || undefined;
  return PRESETS[settings.personality];
}
