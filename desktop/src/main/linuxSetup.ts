import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import type { ExtensionStatus, LinuxStatus } from "../shared-types.ts";
import { runHelper } from "./capture/linux.ts";
import { callExtension } from "./gnomeShell.ts";

const run = promisify(execFile);

const MEDIA_KEYS = "org.gnome.settings-daemon.plugins.media-keys";
const KIKI_KEYBINDING = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/kiki/";
const KIKI_KEYBINDING_SCHEMA = `${MEDIA_KEYS}.custom-keybinding:${KIKI_KEYBINDING}`;
const INTERFACE = "org.gnome.desktop.interface";
const SHELL = "org.gnome.shell";
const EXTENSION_UUID = "kiki-popup@kiki.app";

async function gsettings(...args: string[]): Promise<string> {
  const { stdout } = await run("gsettings", args, { timeout: 3_000 });
  return stdout.trim();
}

/** Parses a GVariant string array like "['/a/', '/b/']" or "@as []". */
export function parseStrv(value: string): string[] {
  return [...value.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
}

/** A GVariant string literal. gsettings parses values as GVariant text, so raw quotes would break it. */
function gvariantString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatStrv(items: string[]): string {
  return `[${items.map(gvariantString).join(", ")}]`;
}

/** Electron accelerator ("Ctrl+Alt+K") to a GNOME binding ("<Control><Alt>k"). */
export function toGnomeBinding(accelerator: string): string {
  const modifiers: Record<string, string> = {
    ctrl: "<Control>",
    control: "<Control>",
    commandorcontrol: "<Control>",
    cmdorctrl: "<Control>",
    alt: "<Alt>",
    option: "<Alt>",
    altgr: "<Alt>",
    shift: "<Shift>",
    super: "<Super>",
    meta: "<Super>",
    cmd: "<Super>",
    command: "<Super>",
  };
  const parts = accelerator.split("+").map((part) => part.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key || parts.length === 0) throw new Error("Use a modifier plus a key, like Ctrl+Alt+K.");
  const prefix = parts
    .map((part) => {
      const modifier = modifiers[part.toLowerCase()];
      if (!modifier) throw new Error(`Unknown modifier "${part}".`);
      return modifier;
    })
    .join("");
  const named: Record<string, string> = { space: "space", enter: "Return", return: "Return", tab: "Tab" };
  const gnomeKey = named[key.toLowerCase()] ?? (key.length === 1 ? key.toLowerCase() : key);
  return prefix + gnomeKey;
}

/** The command that starts (or signals) this copy of Kiki. */
export function launchCommand(): string[] {
  if (process.env.APPIMAGE) return [process.env.APPIMAGE];
  if (app.isPackaged) return [process.execPath];
  return [process.execPath, app.getAppPath()];
}

function shellQuote(args: string[]): string {
  return args.map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(" ");
}

function bundledExtension(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "gnome-extension", EXTENSION_UUID)
    : join(app.getAppPath(), "resources", "gnome-extension", EXTENSION_UUID);
}

function installedExtension(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "gnome-shell", "extensions", EXTENSION_UUID);
}

/** Where Kiki's GNOME extension will open the popup: the window's size and the chat box's bottom in it. */
export interface PopupPlacement {
  width: number;
  height: number;
  anchorY: number;
  /** Whether the extension moves the popup itself (`movePopup`, version 4). */
  shellMove: boolean;
  /** Whether the extension lets clicks outside the chat box through (`setHitRect`, version 5). */
  clickThrough: boolean;
}

/**
 * Asks Kiki's GNOME extension to open the next popup window at the pointer. Null when the extension
 * isn't running, or is the first version (loaded until the next login), which only `expectPopup` serves.
 */
export async function placePopup(cardHeight: number): Promise<PopupPlacement | null> {
  try {
    // "(uint32 2, 472, 616, 412)"
    const out = await callExtension(500, "PlacePopup", String(process.pid), String(Math.round(cardHeight)));
    const [version = 0, width, height, anchorY] = (out.match(/(?<!\w)-?\d+/g) ?? []).map(Number);
    if (!width || !height || anchorY === undefined) return null;
    return { width, height, anchorY, shellMove: version >= 4, clickThrough: version >= 5 };
  } catch {
    return null;
  }
}

/**
 * Has Kiki's GNOME extension move the popup with the pointer, while the button is down. Unlike a move
 * the window starts itself, it can take the window's transparent top above the top bar.
 */
export async function movePopup(): Promise<boolean> {
  try {
    // "(uint32 4, true)"
    return (await callExtension(500, "MovePopup", String(process.pid))).includes("true");
  } catch {
    return false;
  }
}

/**
 * Tells Kiki's GNOME extension where the chat box is in the popup window. The extension then lets the
 * window take clicks only there; clicks on the transparent space around the box go to the window below.
 */
export async function setHitRect(rect: { x: number; y: number; width: number; height: number }): Promise<boolean> {
  try {
    // "(uint32 5, true)"
    const out = await callExtension(
      500,
      "SetHitRect",
      String(process.pid),
      ...[rect.x, rect.y, rect.width, rect.height].map((value) => String(Math.round(value))),
    );
    return out.includes("true");
  } catch {
    return false;
  }
}

/** The first version of the extension: it opens the next popup window near the pointer. */
export async function expectPopup(width: number, height: number): Promise<boolean> {
  try {
    await callExtension(500, "ExpectPopup", String(process.pid), String(width), String(height));
    return true;
  } catch {
    return false;
  }
}

/** The `version` in an extension folder's metadata.json, or 0. */
async function extensionVersion(dir: string): Promise<number> {
  try {
    const { version } = JSON.parse(await readFile(join(dir, "metadata.json"), "utf8")) as { version?: number };
    return version ?? 0;
  } catch {
    return 0;
  }
}

async function extensionStatus(): Promise<ExtensionStatus> {
  let running: number | undefined;
  try {
    // "(uint32 3,)"
    running = Number((await callExtension(2_000, "Version")).match(/(?<!\w)\d+/)?.[0] ?? 0);
  } catch {
    // Not running: installed and enabled means GNOME loads it at the next login.
  }
  if (running !== undefined) {
    const bundled = await extensionVersion(bundledExtension());
    if (running >= bundled) return "active";
    // An update copied into place loads at the next login, like a first install.
    return (await extensionVersion(installedExtension())) >= bundled ? "installed" : "outdated";
  }
  try {
    const enabled = parseStrv(await gsettings("get", SHELL, "enabled-extensions")).includes(EXTENSION_UUID);
    const blocked = (await gsettings("get", SHELL, "disable-user-extensions")) === "true";
    return existsSync(installedExtension()) && enabled && !blocked ? "installed" : "missing";
  } catch {
    return "missing";
  }
}

/** Copies Kiki's GNOME Shell extension into place and enables it. GNOME loads it at the next login. */
export async function installExtension(): Promise<void> {
  const target = installedExtension();
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await cp(bundledExtension(), target, { recursive: true });
  // `gnome-extensions enable` refuses an extension the running shell hasn't loaded, so use gsettings.
  const enabled = parseStrv(await gsettings("get", SHELL, "enabled-extensions"));
  if (!enabled.includes(EXTENSION_UUID)) {
    await gsettings("set", SHELL, "enabled-extensions", formatStrv([...enabled, EXTENSION_UUID]));
  }
  const disabled = parseStrv(await gsettings("get", SHELL, "disabled-extensions"));
  if (disabled.includes(EXTENSION_UUID)) {
    await gsettings("set", SHELL, "disabled-extensions", formatStrv(disabled.filter((uuid) => uuid !== EXTENSION_UUID)));
  }
  await gsettings("set", SHELL, "disable-user-extensions", "false");
}

export async function hasGnomeShortcuts(): Promise<boolean> {
  try {
    await gsettings("writable", MEDIA_KEYS, "custom-keybindings");
    return true;
  } catch {
    return false;
  }
}

export async function installGnomeShortcut(accelerator: string): Promise<void> {
  const binding = toGnomeBinding(accelerator);
  await gsettings("set", KIKI_KEYBINDING_SCHEMA, "name", gvariantString("Ask Kiki"));
  await gsettings("set", KIKI_KEYBINDING_SCHEMA, "command", gvariantString(`${shellQuote(launchCommand())} --ask`));
  await gsettings("set", KIKI_KEYBINDING_SCHEMA, "binding", gvariantString(binding));
  const list = parseStrv(await gsettings("get", MEDIA_KEYS, "custom-keybindings"));
  if (!list.includes(KIKI_KEYBINDING)) {
    await gsettings("set", MEDIA_KEYS, "custom-keybindings", formatStrv([...list, KIKI_KEYBINDING]));
  }
}

async function gnomeShortcutBinding(): Promise<string | undefined> {
  try {
    const list = parseStrv(await gsettings("get", MEDIA_KEYS, "custom-keybindings"));
    if (!list.includes(KIKI_KEYBINDING)) return undefined;
    return parseStrv(await gsettings("get", KIKI_KEYBINDING_SCHEMA, "binding"))[0] || undefined;
  } catch {
    return undefined;
  }
}

export async function accessibilityEnabled(): Promise<boolean> {
  try {
    return (await gsettings("get", INTERFACE, "toolkit-accessibility")) === "true";
  } catch {
    return false;
  }
}

/** Makes browsers and Electron apps expose their text over AT-SPI (they need a restart). */
export async function enableAccessibility(): Promise<void> {
  await gsettings("set", INTERFACE, "toolkit-accessibility", "true");
}

function autostartFile(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "autostart", "kiki.desktop");
}

export async function setLinuxLaunchAtLogin(enabled: boolean): Promise<void> {
  const file = autostartFile();
  if (!enabled) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(
    file,
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Kiki",
      "Comment=Highlight text anywhere and ask Kiki about it",
      `Exec=${shellQuote(launchCommand())} --hidden`,
      "X-GNOME-Autostart-enabled=true",
      "",
    ].join("\n"),
  );
}

async function hasClipboardTool(): Promise<boolean> {
  const tool = process.env.WAYLAND_DISPLAY ? "wl-paste" : "xclip";
  try {
    await run("which", [tool], { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

export async function linuxStatus(): Promise<LinuxStatus> {
  const [gnome, shortcutBinding, extension, accessibility, clipboardTool, helper] = await Promise.all([
    hasGnomeShortcuts(),
    gnomeShortcutBinding(),
    extensionStatus(),
    accessibilityEnabled(),
    hasClipboardTool(),
    runHelper<{ ok: boolean; error?: string }>(["--check"], 5_000)
      .then(() => undefined)
      .catch((error: unknown) => String(error)),
  ]);
  return {
    gnome,
    wayland: Boolean(process.env.WAYLAND_DISPLAY),
    shortcutInstalled: Boolean(shortcutBinding),
    shortcutBinding,
    shortcutCommand: `${shellQuote(launchCommand())} --ask`,
    extension,
    accessibilityEnabled: accessibility,
    helperError: helper,
    clipboardTool,
  };
}
