import { join } from "node:path";
import { app, Menu, nativeImage, session, Tray } from "electron";
import { setHotkeyHandler } from "./hotkey.ts";
import { openPopup, registerPopupIpc } from "./popup.ts";
import { hasSettingsFile } from "./settings.ts";
import { applySettings, openSettings, registerSettingsIpc } from "./settingsWindow.ts";

const isMac = process.platform === "darwin";
const askNow = process.argv.includes("--ask");
const startHidden = process.argv.includes("--hidden");

// Module-level so the tray icon isn't garbage collected.
let tray: Tray | null = null;

function ask(): void {
  void openPopup(openSettings);
}

/** Electron grants every permission by default; Kiki's pages need none. */
function restrictPermissions(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(app.getAppPath(), "resources", "trayTemplate.png"));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Kiki");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Ask Kiki", click: ask },
      { label: "Settings…", click: openSettings },
      { type: "separator" },
      { label: "Quit Kiki", role: "quit" },
    ]),
  );
}

// One Kiki process: later launches (e.g. the GNOME shortcut running `kiki --ask`)
// hand their arguments to the running instance and exit.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (argv.includes("--ask")) ask();
    else openSettings();
  });

  app.whenReady().then(async () => {
    if (isMac) {
      app.dock?.hide();
      // macOS needs an Edit menu for copy/paste shortcuts to work in text fields.
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }]));
      createTray();
    } else {
      Menu.setApplicationMenu(null);
    }

    restrictPermissions();
    registerPopupIpc(openSettings);
    registerSettingsIpc();
    setHotkeyHandler(ask);
    await applySettings();

    if (askNow) ask();
    else if (!hasSettingsFile() || !startHidden) openSettings();
  });

  // Keep running in the background after the last window closes; the hotkey reopens Kiki.
  app.on("window-all-closed", () => {});
  app.on("activate", () => openSettings());
}
