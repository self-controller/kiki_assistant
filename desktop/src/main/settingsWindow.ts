import { app, ipcMain, shell, systemPreferences, type BrowserWindow } from "electron";
import type { ActionResult, ScreenshotPolicy, SettingsUpdate, SettingsView } from "../shared-types.ts";
import { fetchMe } from "./api.ts";
import { registerHotkey } from "./hotkey.ts";
import {
  enableAccessibility,
  hasGnomeShortcuts,
  installExtension,
  installGnomeShortcut,
  linuxStatus,
  setLinuxLaunchAtLogin,
} from "./linuxSetup.ts";
import { getAccessCode, getSettings, saveSettings, storageWarning, validateServerUrl } from "./settings.ts";
import { createWindow } from "./windows.ts";

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";
const SCREENSHOT_POLICIES: ScreenshotPolicy[] = ["auto", "always", "never"];

let settingsWindow: BrowserWindow | null = null;
let hotkeyError: string | undefined;

export function openSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = createWindow({ page: "settings", width: 520, height: 720, title: "Kiki Settings" });
  settingsWindow.once("ready-to-show", () => settingsWindow?.show());
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

/** Registers the hotkey and login item from the saved settings. */
export async function applySettings(): Promise<void> {
  const settings = getSettings();
  hotkeyError = registerHotkey(settings.hotkey);
  try {
    if (isMac) app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, args: ["--hidden"] });
    // From a source checkout too, like the GNOME shortcut: both run the last build.
    if (isLinux) await setLinuxLaunchAtLogin(settings.launchAtLogin);
  } catch (error) {
    console.warn("[kiki] could not update launch at login:", error);
  }
}

async function view(): Promise<SettingsView> {
  const settings = getSettings();
  return {
    ...settings,
    hasAccessCode: Boolean(getAccessCode()),
    platform: process.platform,
    storageWarning: storageWarning(),
    hotkeyError,
    linux: isLinux ? await linuxStatus() : undefined,
    mac: isMac
      ? {
          accessibility: systemPreferences.isTrustedAccessibilityClient(false),
          screen: systemPreferences.getMediaAccessStatus("screen"),
        }
      : undefined,
  };
}

async function save(update: SettingsUpdate): Promise<ActionResult> {
  if (update.serverUrl !== undefined) {
    const problem = validateServerUrl(update.serverUrl);
    if (problem) return { ok: false, message: problem };
  }
  if (update.screenshot !== undefined && !SCREENSHOT_POLICIES.includes(update.screenshot)) {
    return { ok: false, message: "Unknown screenshot setting." };
  }
  if (update.hotkey !== undefined && !/^[^+]+(\+[^+]+)+$/.test(update.hotkey.trim())) {
    return { ok: false, message: "Use a modifier plus a key, like Ctrl+Alt+K." };
  }
  const previousHotkey = getSettings().hotkey;
  saveSettings(update);
  await applySettings();

  // Keep an installed GNOME shortcut in sync with the hotkey setting.
  if (isLinux && update.hotkey && update.hotkey !== previousHotkey) {
    const status = await linuxStatus();
    if (status.shortcutInstalled) {
      try {
        await installGnomeShortcut(getSettings().hotkey);
      } catch (error) {
        return { ok: false, message: `Saved, but the GNOME shortcut wasn't updated: ${String(error)}` };
      }
    }
  }
  return hotkeyError ? { ok: false, message: hotkeyError } : { ok: true, message: "Saved." };
}

async function installShortcut(): Promise<ActionResult> {
  if (!(await hasGnomeShortcuts())) {
    return {
      ok: false,
      message: "This desktop doesn't use GNOME shortcuts. Bind your hotkey to the command shown below in your desktop's keyboard settings.",
    };
  }
  try {
    await installGnomeShortcut(getSettings().hotkey);
    return { ok: true, message: `Shortcut installed: ${getSettings().hotkey}` };
  } catch (error) {
    return { ok: false, message: String(error instanceof Error ? error.message : error) };
  }
}

export function registerSettingsIpc(): void {
  ipcMain.handle("settings:get", () => view());
  ipcMain.handle("settings:save", (_event, update: SettingsUpdate) => save(update ?? {}));
  ipcMain.handle("settings:test", () => fetchMe());
  ipcMain.handle("settings:installShortcut", () => installShortcut());
  ipcMain.handle("settings:installExtension", async (): Promise<ActionResult> => {
    if (!isLinux) return { ok: false, message: "Only needed on GNOME." };
    try {
      await installExtension();
      return { ok: true, message: "Installed. Log out and back in to finish." };
    } catch (error) {
      return { ok: false, message: String(error instanceof Error ? error.message : error) };
    }
  });
  ipcMain.handle("settings:enableAccessibility", async (): Promise<ActionResult> => {
    try {
      await enableAccessibility();
      return { ok: true, message: "Turned on. Restart your browser so Kiki can read its pages." };
    } catch (error) {
      return { ok: false, message: String(error) };
    }
  });
  ipcMain.handle("settings:requestMacPermissions", async (): Promise<ActionResult> => {
    if (!isMac) return { ok: false, message: "Only needed on macOS." };
    // Shows the system prompt (once) and adds Kiki to the Accessibility list.
    const trusted = systemPreferences.isTrustedAccessibilityClient(true);
    if (systemPreferences.getMediaAccessStatus("screen") !== "granted") {
      await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    }
    return {
      ok: true,
      message: trusted
        ? "Accessibility is on. Allow Screen Recording if it's still off, then reopen Settings."
        : "Allow Kiki in System Settings → Privacy & Security → Accessibility, then reopen Settings.",
    };
  });
  ipcMain.on("settings:quit", () => app.quit());
}
