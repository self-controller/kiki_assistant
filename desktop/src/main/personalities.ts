import type { PersonalityChoice } from "../shared-types.ts";

/** The built-in personalities' prompts. The default has none: Kiki's usual voice. */
const PRESETS: Record<Exclude<PersonalityChoice, "default" | "custom">, string> = {
  existentialist:
    "Speak as a voice blending Camus, Dostoevsky and Nietzsche: lucid before the absurd, feverish about conscience and suffering, aphoristic, defiant, darkly witty. Keep answers accurate and brief; let the outlook color the phrasing, ending with one sharp line.",
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
