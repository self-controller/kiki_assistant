import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { app } from "electron";
import type { ExtensionStatus, LinuxStatus } from "../shared-types.ts";
import { python, runHelper } from "./capture/linux.ts";
import { callExtension, gvariantString, parseGVariantString } from "./gnomeShell.ts";
import { isWayland } from "./windows.ts";

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

/** A GVariant string array literal; gsettings parses values as GVariant text. */
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

/** Where a running Kiki listens for the hotkey (see `askCommand`); undefined without a runtime dir. */
export function askSocket(): string | undefined {
  const dir = process.env.XDG_RUNTIME_DIR;
  return dir ? join(dir, "kiki.sock") : undefined;
}

/**
 * Says "ask" on the socket (argv[1]), or else starts Kiki with the rest of argv. Python without its site
 * packages (-I -S) starts in about 20 ms; a second Electron, only to hand `--ask` over, takes a few hundred.
 */
const ASK_CLIENT =
  'import os,socket,sys;s=socket.socket(socket.AF_UNIX);e=s.connect_ex(sys.argv[1]);e or s.sendall(b"ask");e and os.execv(sys.argv[2],sys.argv[2:])';

/** What the hotkey runs: it tells the running Kiki to open the popup, or starts Kiki to. */
export function askCommand(): string[] {
  const launch = [...launchCommand(), "--ask"];
  const socket = askSocket();
  return socket ? [python(), "-I", "-S", "-c", ASK_CLIENT, socket, ...launch] : launch;
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
 * Has Kiki's GNOME extension focus the open popup (version 10). False without it: GNOME doesn't let an app
 * focus its own window once another one has the keyboard.
 */
export async function activatePopup(): Promise<boolean> {
  try {
    // "(uint32 10, true)"
    return (await callExtension(500, "ActivatePopup", String(process.pid))).includes("true");
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
  if (!existsSync(installedExtension())) return "missing";
  try {
    return (await extensionEnabled()) ? "installed" : "off";
  } catch {
    return "missing";
  }
}

/** Whether GNOME's settings have Kiki's extension on: enabled, not disabled, and user extensions allowed. */
async function extensionEnabled(): Promise<boolean> {
  const [enabled, disabled, blocked] = await Promise.all([
    gsettings("get", SHELL, "enabled-extensions"),
    gsettings("get", SHELL, "disabled-extensions"),
    gsettings("get", SHELL, "disable-user-extensions"),
  ]);
  return parseStrv(enabled).includes(EXTENSION_UUID) && !parseStrv(disabled).includes(EXTENSION_UUID) && blocked !== "true";
}

/**
 * Whether Kiki's GNOME extension is installed but switched off, e.g. in the Extensions app, or by something
 * else rewriting GNOME's list of enabled extensions. False without GNOME's settings.
 */
export async function extensionOff(): Promise<boolean> {
  if (!existsSync(installedExtension())) return false;
  try {
    return !(await extensionEnabled());
  } catch {
    return false;
  }
}

/**
 * Waits for the running shell to serve the bundled extension, as it does right away when it loaded the
 * extension at login and it was switched on since. False when that takes a new login.
 */
export async function waitForExtension(timeoutMs = 1_500): Promise<boolean> {
  const bundled = await extensionVersion(bundledExtension());
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // "(uint32 3,)"
      const running = Number((await callExtension(500, "Version")).match(/(?<!\w)\d+/)?.[0] ?? 0);
      if (running >= bundled) return true;
    } catch {
      // Not served yet.
    }
    if (Date.now() >= deadline) return false;
    await sleep(150);
  }
}

/** Copies Kiki's GNOME Shell extension into place and enables it. GNOME loads it at the next login. */
export async function installExtension(): Promise<void> {
  const target = installedExtension();
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await cp(bundledExtension(), target, { recursive: true });
  await enableExtension();
}

/**
 * Switches Kiki's installed GNOME extension on, keeping the other extensions. A shell that loaded it at
 * login turns it on right away; otherwise it loads at the next login.
 */
export async function enableExtension(): Promise<void> {
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
  await gsettings("set", KIKI_KEYBINDING_SCHEMA, "command", gvariantString(shellQuote(askCommand())));
  await gsettings("set", KIKI_KEYBINDING_SCHEMA, "binding", gvariantString(binding));
  const list = parseStrv(await gsettings("get", MEDIA_KEYS, "custom-keybindings"));
  if (!list.includes(KIKI_KEYBINDING)) {
    await gsettings("set", MEDIA_KEYS, "custom-keybindings", formatStrv([...list, KIKI_KEYBINDING]));
  }
}

/** Points an installed Kiki shortcut at `askCommand()`, e.g. one set up before Kiki listened on its socket. */
export async function refreshGnomeShortcut(): Promise<void> {
  const list = parseStrv(await gsettings("get", MEDIA_KEYS, "custom-keybindings"));
  if (!list.includes(KIKI_KEYBINDING)) return;
  const command = shellQuote(askCommand());
  if (parseGVariantString(await gsettings("get", KIKI_KEYBINDING_SCHEMA, "command")) !== command) {
    await gsettings("set", KIKI_KEYBINDING_SCHEMA, "command", gvariantString(command));
  }
}

/** Whether Kiki's GNOME shortcut is installed. */
export async function gnomeShortcutInstalled(): Promise<boolean> {
  return Boolean(await gnomeShortcutBinding());
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
  const tool = isWayland ? "wl-paste" : "xclip";
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
    wayland: isWayland,
    shortcutInstalled: Boolean(shortcutBinding),
    shortcutBinding,
    shortcutCommand: shellQuote(askCommand()),
    extension,
    accessibilityEnabled: accessibility,
    helperError: helper,
    clipboardTool,
  };
}
