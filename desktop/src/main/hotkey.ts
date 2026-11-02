import { globalShortcut } from "electron";
import { isWayland } from "./windows.ts";

let onHotkey: () => void = () => {};

export function setHotkeyHandler(handler: () => void): void {
  onHotkey = handler;
}

/**
 * Registers the global hotkey where Electron can (macOS, X11). On Wayland, apps can't
 * grab keys, so a GNOME custom shortcut runs `kiki --ask` instead (see linuxSetup.ts).
 * Returns an error message, or undefined on success.
 */
export function registerHotkey(accelerator: string): string | undefined {
  globalShortcut.unregisterAll();
  if (isWayland) return undefined;
  try {
    if (globalShortcut.register(accelerator, () => onHotkey())) return undefined;
    return `Couldn't use ${accelerator} as the hotkey; another app may already use it.`;
  } catch {
    return `“${accelerator}” isn't a valid hotkey.`;
  }
}
