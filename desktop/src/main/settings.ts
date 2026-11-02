import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS, type Provider } from "@kiki/shared";
import { app, safeStorage } from "electron";
import type { ServiceId } from "../services.ts";
import type {
  AccountChoice,
  AgentProvider,
  ComputerUseSettings,
  CustomModelView,
  NearbyTextPolicy,
  PersonalityChoice,
  ScreenshotPolicy,
  SettingsUpdate,
} from "../shared-types.ts";

export interface Settings {
  hotkey: string;
  nearbyText: NearbyTextPolicy;
  screenshot: ScreenshotPolicy;
  /** Kiki's browser, other windows, clicks at coordinates. */
  computerUse: ComputerUseSettings;
  launchAtLogin: boolean;
  personality: PersonalityChoice;
  /** The person's own prompt, used when `personality` is "custom". */
  customPersonality: string;
  /**
   * How Claude's and GPT's questions run, as the person chose in Settings. Unset: on their Claude Code or
   * Codex when Kiki finds it, otherwise on their key.
   */
  accounts: Partial<Record<AgentProvider, AccountChoice>>;
}

/** A secret kept with the OS keyring when there is one. */
interface StoredSecret {
  encrypted: boolean;
  value: string;
}

/** A model the person added, with its key. */
interface StoredCustomModel {
  id: string;
  name: string;
  service: ServiceId;
  baseUrl: string;
  model: string;
  key?: StoredSecret;
}

interface StoredSettings extends Settings {
  /** The connected Google account's tokens (JSON); they never leave this computer except to Google. */
  google?: StoredSecret;
  /** The person's own API keys, sent only to their provider, with questions for its models. */
  providerKeys?: Partial<Record<Provider, StoredSecret>>;
  customModels?: StoredCustomModel[];
}

/** What Kiki needs to ask a model the person added. */
export interface CustomModel {
  id: string;
  name: string;
  service: ServiceId;
  baseUrl: string;
  model: string;
  key: string | null;
}

/** A connected Google account. */
export interface GoogleTokens {
  email?: string;
  refreshToken: string;
  accessToken?: string;
  /** When `accessToken` expires, in ms since the epoch. */
  expiresAt?: number;
  /** The scopes Google granted, space-separated. */
  scope?: string;
}

const DEFAULTS: Settings = {
  hotkey: "Ctrl+Alt+K",
  nearbyText: "always",
  // macOS can't read window text without a screenshot, so attach one by default there.
  screenshot: process.platform === "darwin" ? "always" : "button",
  computerUse: { browser: true, windows: true, coordinates: true, autoApprove: false },
  launchAtLogin: true,
  personality: "default",
  customPersonality: "",
  accounts: {},
};

/** Settings from before Kiki ran questions itself, when it asked a Kiki server with an access code. */
const RETIRED = ["serverUrl", "accessCode"];

let cached: StoredSettings | null = null;

function settingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

function load(): StoredSettings {
  if (cached) return cached;
  try {
    const stored = JSON.parse(readFileSync(settingsPath(), "utf8")) as Partial<StoredSettings>;
    // Before the camera button, "auto" took a screenshot whenever the window had little text.
    if ((stored.screenshot as string | undefined) === "auto") stored.screenshot = "button";
    // Before the separate voices, "existentialist" blended Camus, Dostoevsky and Nietzsche.
    if ((stored.personality as string | undefined) === "existentialist") stored.personality = "default";
    for (const name of RETIRED) delete (stored as Record<string, unknown>)[name];
    cached = { ...DEFAULTS, ...stored, computerUse: { ...DEFAULTS.computerUse, ...stored.computerUse } };
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached;
}

function persist(settings: StoredSettings): void {
  cached = settings;
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

export function getSettings(): Settings {
  const { google: _google, providerKeys: _providerKeys, customModels: _customModels, ...settings } = load();
  return settings;
}

function encryptSecret(value: string): StoredSecret {
  return safeStorage.isEncryptionAvailable()
    ? { encrypted: true, value: safeStorage.encryptString(value).toString("base64") }
    : { encrypted: false, value };
}

function decryptSecret(stored: StoredSecret | undefined): string | null {
  if (!stored) return null;
  if (!stored.encrypted) return stored.value;
  try {
    return safeStorage.decryptString(Buffer.from(stored.value, "base64"));
  } catch {
    return null;
  }
}

/** The connected account's tokens, decoded once (every question and action asks); `setGoogleTokens` replaces them. */
let google: GoogleTokens | null | undefined;

export function getGoogleTokens(): GoogleTokens | null {
  if (google !== undefined) return google;
  google = null;
  const raw = decryptSecret(load().google);
  if (!raw) return null;
  try {
    const tokens = JSON.parse(raw) as GoogleTokens;
    if (typeof tokens.refreshToken === "string") google = tokens;
  } catch {
    // Not what Kiki wrote: no account.
  }
  return google;
}

/** Saves the Google account's tokens, or forgets the account with null. */
export function setGoogleTokens(tokens: GoogleTokens | null): void {
  const next: StoredSettings = { ...load() };
  if (tokens) next.google = encryptSecret(JSON.stringify(tokens));
  else delete next.google;
  persist(next);
  google = tokens;
}

export function hasSettingsFile(): boolean {
  return existsSync(settingsPath());
}

/** The person's own API key for `provider`, if they saved one. */
export function getProviderKey(provider: Provider): string | null {
  return decryptSecret(load().providerKeys?.[provider]);
}

/** The models the person added, without their keys. */
export function customModelViews(): CustomModelView[] {
  return (load().customModels ?? []).map(({ key, ...model }) => ({ ...model, hasKey: Boolean(key) }));
}

/** A model the person added, with its key, to ask it. */
export function getCustomModel(id: string): CustomModel | null {
  const stored = load().customModels?.find((model) => model.id === id);
  if (!stored) return null;
  const { key, ...model } = stored;
  return { ...model, key: decryptSecret(key) };
}

/** Adds a model (already checked by the caller); returns its id. */
export function addCustomModel(model: Omit<CustomModel, "id">): string {
  const id = `m${randomBytes(4).toString("hex")}`;
  const { key, ...rest } = model;
  const stored: StoredCustomModel = { id, ...rest, ...(key ? { key: encryptSecret(key) } : {}) };
  persist({ ...load(), customModels: [...(load().customModels ?? []), stored] });
  return id;
}

export function removeCustomModel(id: string): void {
  persist({ ...load(), customModels: (load().customModels ?? []).filter((model) => model.id !== id) });
}

export function saveSettings(update: SettingsUpdate): void {
  const next: StoredSettings = { ...load() };
  if (update.hotkey !== undefined) next.hotkey = update.hotkey.trim();
  if (update.nearbyText !== undefined) next.nearbyText = update.nearbyText;
  if (update.screenshot !== undefined) next.screenshot = update.screenshot;
  if (update.computerUse) {
    next.computerUse = { ...next.computerUse };
    for (const key of ["browser", "windows", "coordinates", "autoApprove"] as const) {
      if (typeof update.computerUse[key] === "boolean") next.computerUse[key] = update.computerUse[key];
    }
  }
  if (update.launchAtLogin !== undefined) next.launchAtLogin = update.launchAtLogin;
  if (update.personality !== undefined) next.personality = update.personality;
  if (update.customPersonality !== undefined) {
    next.customPersonality = update.customPersonality.trim().slice(0, LIMITS.personalityChars);
  }
  if (update.accounts) next.accounts = { ...next.accounts, ...update.accounts };
  if (update.providerKeys) {
    const keys = { ...next.providerKeys };
    for (const [provider, key] of Object.entries(update.providerKeys) as Array<[Provider, string | null | undefined]>) {
      // An empty field leaves the saved key as it is; null removes it.
      if (key === null) delete keys[provider];
      else if (key?.trim()) keys[provider] = encryptSecret(key.trim());
    }
    next.providerKeys = keys;
  }
  persist(next);
}

/** A warning when the OS has no keyring to protect the API keys. */
export function storageWarning(): string | undefined {
  if (!safeStorage.isEncryptionAvailable()) {
    return "No system keyring is available, so your API keys are stored unencrypted.";
  }
  if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") {
    return "No system keyring was found, so your API keys are only lightly obscured on disk.";
  }
  return undefined;
}
