import { app, ipcMain, shell, systemPreferences, type BrowserWindow } from "electron";
import { PROVIDERS } from "@kiki/shared";
import {
  checkBaseUrl,
  CUSTOM_MODEL_CHARS,
  CUSTOM_NAME_CHARS,
  MAX_CUSTOM_MODELS,
  SERVICE_IDS,
  SERVICES,
  serviceName,
  type ServiceId,
} from "../services.ts";
import {
  AGENT_PROVIDERS,
  type ActionResult,
  type ModelListResult,
  type NearbyTextPolicy,
  type NewCustomModel,
  type ScreenshotPolicy,
  type SettingsUpdate,
  type SettingsView,
} from "../shared-types.ts";
import { accountChoices, agentStatuses, checkAgents } from "./engine.ts";
import { errorMessage } from "./errors.ts";
import { connectGoogle, disconnectGoogle, googleAccount, googleAvailable } from "./google/oauth.ts";
import { registerHotkey } from "./hotkey.ts";
import {
  enableAccessibility,
  gnomeShortcutInstalled,
  hasGnomeShortcuts,
  installExtension,
  installGnomeShortcut,
  linuxStatus,
  refreshGnomeShortcut,
  setLinuxLaunchAtLogin,
  waitForExtension,
} from "./linuxSetup.ts";
import { checkProviderKey, KEY_NAMES, listCompatibleModels } from "./providerKeys.ts";
import {
  addCustomModel,
  customModelViews,
  getProviderKey,
  getSettings,
  removeCustomModel,
  saveSettings,
  storageWarning,
} from "./settings.ts";
import { createWindow, isLinux, isMac } from "./windows.ts";

const SCREENSHOT_POLICIES: ScreenshotPolicy[] = ["button", "always", "never"];
const NEARBY_TEXT_POLICIES: NearbyTextPolicy[] = ["always", "never"];

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
  if (isLinux) void refreshGnomeShortcut().catch((error: unknown) => console.warn("[kiki] could not update the GNOME shortcut:", error));
}

async function view(): Promise<SettingsView> {
  const settings = getSettings();
  return {
    ...settings,
    platform: process.platform,
    storageWarning: storageWarning(),
    hotkeyError,
    google: { available: googleAvailable(), ...googleAccount() },
    providerKeys: { anthropic: Boolean(getProviderKey("anthropic")), google: Boolean(getProviderKey("google")), openai: Boolean(getProviderKey("openai")) },
    // The choice in use, even before the person picks: Settings shows which one answers.
    accounts: accountChoices(),
    agents: agentStatuses(),
    customModels: customModelViews(),
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
  for (const [provider, choice] of Object.entries(update.accounts ?? {})) {
    if (!AGENT_PROVIDERS.includes(provider as never) || (choice !== "agent" && choice !== "key")) {
      return { ok: false, message: "Unknown model setting." };
    }
  }
  if (update.screenshot !== undefined && !SCREENSHOT_POLICIES.includes(update.screenshot)) {
    return { ok: false, message: "Unknown screenshot setting." };
  }
  if (update.nearbyText !== undefined && !NEARBY_TEXT_POLICIES.includes(update.nearbyText)) {
    return { ok: false, message: "Unknown nearby text setting." };
  }
  if (update.computerUse !== undefined && Object.values(update.computerUse).some((value) => typeof value !== "boolean")) {
    return { ok: false, message: "Unknown computer control setting." };
  }
  if (update.hotkey !== undefined && !/^[^+]+(\+[^+]+)+$/.test(update.hotkey.trim())) {
    return { ok: false, message: "Use a modifier plus a key, like Ctrl+Alt+K." };
  }
  // A new API key is checked with its provider first; one it rejects stops the save, like a bad address.
  const notes: string[] = [];
  for (const provider of PROVIDERS) {
    const key = update.providerKeys?.[provider]?.trim();
    if (!key) continue;
    const { company, key: keyName } = KEY_NAMES[provider];
    const check = await checkProviderKey(provider, key);
    if (check.result === "rejected") return { ok: false, message: `${company} didn't accept that ${keyName}. Check it and try again.` };
    if (check.result === "unchecked") notes.push(`${check.reason}, so your ${keyName} was saved without a check.`);
  }
  const previous = getSettings();
  saveSettings(update);
  await applySettings();
  const previousHotkey = previous.hotkey;

  // Keep an installed GNOME shortcut in sync with the hotkey setting.
  if (isLinux && update.hotkey && update.hotkey !== previousHotkey && (await gnomeShortcutInstalled())) {
    try {
      await installGnomeShortcut(getSettings().hotkey);
    } catch (error) {
      return { ok: false, message: `Saved, but the GNOME shortcut wasn't updated: ${errorMessage(error)}` };
    }
  }
  if (hotkeyError) return { ok: false, message: hotkeyError };
  return { ok: true, message: ["Saved.", ...notes].join(" ") };
}

/** The models a service offers, for the add form: `key` is a new one, or the one saved for that address. */
async function listModels(service: ServiceId, baseUrl: string, key?: string): Promise<ModelListResult> {
  if (!SERVICE_IDS.includes(service)) return { ok: false, message: "Unknown service." };
  const checked = checkBaseUrl(baseUrl);
  if ("error" in checked) return { ok: false, message: checked.error };
  const name = serviceName(service, checked.url);
  return listCompatibleModels({ name, baseUrl: checked.url, local: SERVICES[service].local }, key?.trim() || undefined);
}

async function addModel(input: NewCustomModel): Promise<ActionResult> {
  if (customModelViews().length >= MAX_CUSTOM_MODELS) {
    return { ok: false, message: `Kiki keeps up to ${MAX_CUSTOM_MODELS} models. Remove one first.` };
  }
  if (!SERVICE_IDS.includes(input?.service)) return { ok: false, message: "Pick a service." };
  const checked = checkBaseUrl(input.baseUrl ?? "");
  if ("error" in checked) return { ok: false, message: checked.error };
  const model = (input.model ?? "").trim();
  if (!model || model.length > CUSTOM_MODEL_CHARS) return { ok: false, message: "Pick or type the model's name." };
  const key = input.key?.trim() || null;
  if (!key && !SERVICES[input.service].local && input.service !== "custom") {
    return { ok: false, message: `${SERVICES[input.service].name} needs your API key.` };
  }
  const name = (input.name ?? "").trim().slice(0, CUSTOM_NAME_CHARS) || model.split("/").at(-1)!.slice(0, CUSTOM_NAME_CHARS);
  addCustomModel({ name, service: input.service, baseUrl: checked.url, model, key });
  return { ok: true, message: `Added ${name}. Pick it under Other in the popup's model menu.` };
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
    return { ok: false, message: errorMessage(error) };
  }
}

export function registerSettingsIpc(): void {
  ipcMain.handle("settings:get", () => view());
  ipcMain.handle("settings:save", (_event, update: SettingsUpdate) => save(update ?? {}));
  ipcMain.handle("settings:checkAgents", () => checkAgents());
  ipcMain.handle("settings:listModels", (_event, service: ServiceId, baseUrl: string, key?: string) => listModels(service, String(baseUrl ?? ""), key));
  ipcMain.handle("settings:addModel", (_event, input: NewCustomModel) => addModel(input ?? ({} as NewCustomModel)));
  ipcMain.handle("settings:removeModel", (_event, id: string): ActionResult => {
    removeCustomModel(String(id));
    return { ok: true, message: "Removed." };
  });
  ipcMain.handle("settings:installShortcut", () => installShortcut());
  ipcMain.handle("settings:installExtension", async (): Promise<ActionResult> => {
    if (!isLinux) return { ok: false, message: "Only needed on GNOME." };
    try {
      await installExtension();
      // A shell that loaded the extension at login (it was only switched off) turns it on right away.
      if (await waitForExtension()) return { ok: true, message: "On: the popup opens at the pointer." };
      return { ok: true, message: "Installed. Log out and back in to finish." };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  });
  ipcMain.handle("settings:enableAccessibility", async (): Promise<ActionResult> => {
    try {
      await enableAccessibility();
      return { ok: true, message: "Turned on. Restart your browser so Kiki can read its pages." };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
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
  ipcMain.handle("settings:connectGoogle", async (): Promise<ActionResult> => {
    try {
      const tokens = await connectGoogle();
      settingsWindow?.focus();
      return { ok: true, message: tokens.email ? `Connected as ${tokens.email}.` : "Connected." };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  });
  ipcMain.handle("settings:disconnectGoogle", async (): Promise<ActionResult> => {
    await disconnectGoogle();
    return { ok: true, message: "Disconnected." };
  });
  ipcMain.on("settings:quit", () => app.quit());
}
