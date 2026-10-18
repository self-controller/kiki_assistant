import { join } from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { POPUP_WIDTH } from "../renderer/layout.ts";

export const isWayland = process.platform === "linux" && Boolean(process.env.WAYLAND_DISPLAY);
export const isMac = process.platform === "darwin";

export function preloadPath(): string {
  return join(import.meta.dirname, "../preload/index.cjs");
}

export function loadPage(window: BrowserWindow, page: "popup" | "settings"): void {
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) void window.loadURL(`${devServer}/${page}.html`);
  else void window.loadFile(join(import.meta.dirname, `../renderer/${page}.html`));
}

/** Locks a window down: no navigation, no new windows, links open in the browser. */
export function hardenWindow(window: BrowserWindow): void {
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
}

export function openExternal(url: string): void {
  try {
    const { protocol } = new URL(url);
    if (protocol === "https:" || protocol === "http:") void shell.openExternal(url);
  } catch {
    // Ignore malformed links.
  }
}

function webPreferences(): Electron.WebPreferences {
  return {
    preload: preloadPath(),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    spellcheck: true,
  };
}

/**
 * Kiki's popup: a frameless, see-through window holding the chat box, shown once its page has measured
 * the box. It's sized once for the tallest box and never resizes. Where it opens is up to the caller:
 * the main process on macOS and X11, and Kiki's GNOME Shell extension on Wayland, where apps can't
 * place their own windows.
 */
export function createPopupWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: POPUP_WIDTH,
    height: 200,
    title: "Kiki",
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    ...(isMac ? { type: "panel" } : {}),
    ...(process.platform === "linux" ? { icon: join(app.getAppPath(), "resources", "icon.png") } : {}),
    webPreferences: webPreferences(),
  });
  if (isMac) {
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  hardenWindow(window);
  loadPage(window, "popup");
  return window;
}

export function createWindow(options: {
  page: "popup" | "settings";
  width: number;
  height: number;
  title: string;
}): BrowserWindow {
  const window = new BrowserWindow({
    width: options.width,
    height: options.height,
    minWidth: 340,
    minHeight: 320,
    title: options.title,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === "linux" ? { icon: join(app.getAppPath(), "resources", "icon.png") } : {}),
    webPreferences: webPreferences(),
  });
  hardenWindow(window);
  loadPage(window, options.page);
  return window;
}
