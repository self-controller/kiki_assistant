import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import type { ScreenshotPolicy, SettingsUpdate } from "../shared-types.ts";

export interface Settings {
  serverUrl: string;
  hotkey: string;
  screenshot: ScreenshotPolicy;
  launchAtLogin: boolean;
}

interface StoredSettings extends Settings {
  accessCode?: { encrypted: boolean; value: string };
}

// Set MAIN_VITE_KIKI_SERVER_URL when building to ship your server's address as the default.
const DEFAULT_SERVER_URL = import.meta.env.MAIN_VITE_KIKI_SERVER_URL || "http://127.0.0.1:8787";

const DEFAULTS: Settings = {
  serverUrl: DEFAULT_SERVER_URL,
  hotkey: "Ctrl+Alt+K",
  // macOS can't read window text without a screenshot, so attach one by default there.
  screenshot: process.platform === "darwin" ? "always" : "auto",
  launchAtLogin: true,
};

let cached: StoredSettings | null = null;

function settingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

function load(): StoredSettings {
  if (cached) return cached;
  try {
    cached = { ...DEFAULTS, ...(JSON.parse(readFileSync(settingsPath(), "utf8")) as Partial<StoredSettings>) };
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
  const { accessCode: _accessCode, ...settings } = load();
  return settings;
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
  const stored = load().accessCode;
  if (!stored) return null;
  if (!stored.encrypted) return stored.value;
  try {
    return safeStorage.decryptString(Buffer.from(stored.value, "base64"));
  } catch {
    return null;
  }
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
  if (update.accessCode !== undefined) {
    const code = update.accessCode.trim();
    if (!code) {
      delete next.accessCode;
    } else if (safeStorage.isEncryptionAvailable()) {
      next.accessCode = { encrypted: true, value: safeStorage.encryptString(code).toString("base64") };
    } else {
      next.accessCode = { encrypted: false, value: code };
    }
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
