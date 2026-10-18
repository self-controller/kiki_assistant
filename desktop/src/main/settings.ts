import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS } from "@kiki/shared";
import { app, safeStorage } from "electron";
import type { PersonalityChoice, ScreenshotPolicy, SettingsUpdate } from "../shared-types.ts";

export interface Settings {
  serverUrl: string;
  hotkey: string;
  screenshot: ScreenshotPolicy;
  launchAtLogin: boolean;
  personality: PersonalityChoice;
  /** The person's own prompt, used when `personality` is "custom". */
  customPersonality: string;
}

/** A secret kept with the OS keyring when there is one. */
interface StoredSecret {
  encrypted: boolean;
  value: string;
}

interface StoredSettings extends Settings {
  accessCode?: StoredSecret;
  /** The connected Google account's tokens (JSON), never sent to the Kiki server. */
  google?: StoredSecret;
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

// Set MAIN_VITE_KIKI_SERVER_URL when building to ship your server's address as the default.
const DEFAULT_SERVER_URL = import.meta.env.MAIN_VITE_KIKI_SERVER_URL || "http://127.0.0.1:8787";

const DEFAULTS: Settings = {
  serverUrl: DEFAULT_SERVER_URL,
  hotkey: "Ctrl+Alt+K",
  // macOS can't read window text without a screenshot, so attach one by default there.
  screenshot: process.platform === "darwin" ? "always" : "button",
  launchAtLogin: true,
  personality: "default",
  customPersonality: "",
};

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
    cached = { ...DEFAULTS, ...stored };
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
  const { accessCode: _accessCode, google: _google, ...settings } = load();
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

export function getGoogleTokens(): GoogleTokens | null {
  const raw = decryptSecret(load().google);
  if (!raw) return null;
  try {
    const tokens = JSON.parse(raw) as GoogleTokens;
    return typeof tokens.refreshToken === "string" ? tokens : null;
  } catch {
    return null;
  }
}

/** Saves the Google account's tokens, or forgets the account with null. */
export function setGoogleTokens(tokens: GoogleTokens | null): void {
  const next: StoredSettings = { ...load() };
  if (tokens) next.google = encryptSecret(JSON.stringify(tokens));
  else delete next.google;
  persist(next);
}

export function hasSettingsFile(): boolean {
  try {
    readFileSync(settingsPath());
    return true;
  } catch {
    return false;
  }
}

export function getAccessCode(): string | null {
  return decryptSecret(load().accessCode);
}

/** Server URLs must use HTTPS, except for a server on this machine. */
export function validateServerUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "Enter a full address, like https://kiki.example.com";
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    return "The server address must start with https:// (http:// is only allowed for localhost).";
  }
  return null;
}

export function saveSettings(update: SettingsUpdate): void {
  const next: StoredSettings = { ...load() };
  if (update.serverUrl !== undefined) next.serverUrl = update.serverUrl.trim().replace(/\/+$/, "");
  if (update.hotkey !== undefined) next.hotkey = update.hotkey.trim();
  if (update.screenshot !== undefined) next.screenshot = update.screenshot;
  if (update.launchAtLogin !== undefined) next.launchAtLogin = update.launchAtLogin;
  if (update.personality !== undefined) next.personality = update.personality;
  if (update.customPersonality !== undefined) {
    next.customPersonality = update.customPersonality.trim().slice(0, LIMITS.personalityChars);
  }
  if (update.accessCode !== undefined) {
    const code = update.accessCode.trim();
    if (!code) delete next.accessCode;
    else next.accessCode = encryptSecret(code);
  }
  persist(next);
}

/** A warning when the OS has no keyring to protect the access code. */
export function storageWarning(): string | undefined {
  if (!safeStorage.isEncryptionAvailable()) {
    return "No system keyring is available, so your access code is stored unencrypted.";
  }
  if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") {
    return "No system keyring was found, so your access code is only lightly obscured on disk.";
  }
  return undefined;
}
