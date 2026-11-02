import { unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { app, Menu, nativeImage, session, Tray } from "electron";
import { checkAgents, closeEngine } from "./engine.ts";
import { flushHistory, pruneHistory } from "./history.ts";
import { setHotkeyHandler } from "./hotkey.ts";
import { runBrowserHarness } from "./harness.ts";
import { askSocket } from "./linuxSetup.ts";
import { openPopup, preparePopup, registerPopupIpc, stopEverything } from "./popup.ts";
import { hasSettingsFile } from "./settings.ts";
import { applySettings, openSettings, registerSettingsIpc } from "./settingsWindow.ts";
import { isLinux, isMac } from "./windows.ts";

const askNow = process.argv.includes("--ask");
const startHidden = process.argv.includes("--hidden");
/** `kiki --browser-harness page.html`: checks Kiki's browser against a local page and exits (see harness.ts). */
const harnessPage = process.argv[process.argv.indexOf("--browser-harness") + 1];
const harness = process.argv.includes("--browser-harness") && harnessPage ? harnessPage : null;

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

/**
 * Listens where the GNOME shortcut's command says "ask" (see `askCommand`): much quicker than starting a
 * second Electron only to hand `--ask` over. Kiki's GNOME extension says "stop" here when the person presses
 * Esc or Stop on the "Kiki is using your computer" banner.
 */
function listenForAsk(): void {
  const path = askSocket();
  if (!path) return;
  // Left behind by a Kiki that didn't quit cleanly; this process holds the single-instance lock now.
  try {
    unlinkSync(path);
  } catch {
    // Nothing there.
  }
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (data: string) => {
      const message = data.trim();
      if (message === "ask") ask();
      else if (message === "stop") stopEverything();
      socket.end();
    });
    socket.on("error", () => {});
  });
  server.on("error", (error) => console.warn("[kiki] ask socket:", error));
  server.listen(path);
  app.on("will-quit", () => server.close());
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

// One Kiki process: later launches (e.g. `kiki --ask`, which the GNOME shortcut runs when
// nothing listens on the ask socket) hand their arguments to the running instance and exit.
if (harness) {
  // A check of Kiki's browser, in its own profile, beside a running Kiki.
  app.setPath("userData", join(app.getPath("temp"), `kiki-browser-harness-${process.pid}`));
  // Like Kiki itself, it goes on when the last page closes (the end of an answer): the next one opens a new one.
  app.on("window-all-closed", () => {});
  app.whenReady().then(async () => app.exit(await runBrowserHarness(harness)));
} else if (!app.requestSingleInstanceLock()) {
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
    if (isLinux) listenForAsk();
    // The next popup's window and helpers first: the hotkey can come before the rest is done.
    preparePopup();
    await applySettings();
    // Unsaved chats go a week after they were last used, even while Kiki keeps running.
    pruneHistory();
    setInterval(() => pruneHistory(), 60 * 60 * 1000);
    // Looks for the person's Claude Code and Codex (four processes) once the launch has settled; until then the
    // model menu goes by where they're installed.
    setTimeout(() => {
      void checkAgents().catch((error: unknown) => console.warn("[kiki] couldn't check Claude Code and Codex:", error));
    }, 3_000);
    app.on("will-quit", () => {
      closeEngine();
      flushHistory();
    });

    if (askNow) ask();
    else if (!hasSettingsFile() || !startHidden) openSettings();
  });

  // Keep running in the background after the last window closes; the hotkey reopens Kiki.
  app.on("window-all-closed", () => {});
  app.on("activate", () => openSettings());
}
