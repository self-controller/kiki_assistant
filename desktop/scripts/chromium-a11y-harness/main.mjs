// A throwaway Electron window that stands in for Chrome: same Blink and the same AT-SPI bridge. Reads it with Kiki's
// helper (check.py) before and after highlighting a paragraph, then tries an AT-SPI write. Run from desktop/:
//   npx electron scripts/chromium-a11y-harness/main.mjs [--dump]
import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { app, BrowserWindow } from "electron";

const run = promisify(execFile);
const here = import.meta.dirname;
const page = join(here, "page.html");

// Chrome turns its page tree on when an assistive tool is running; Electron needs telling.
app.commandLine.appendSwitch("force-renderer-accessibility");

async function check(step) {
  const { stdout } = await run("/usr/bin/python3", [join(here, "check.py"), step, String(process.pid)], { timeout: 30_000 });
  return JSON.parse(stdout);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 900, height: 700, show: false });
  await window.loadFile(page);
  window.showInactive();
  const results = { expectedUrl: pathToFileURL(page).href };
  try {
    if (process.argv.includes("--dump")) results.tree = (await check("dump")).tree;
    results.before = await check("read");
    await window.webContents.executeJavaScript(
      `getSelection().selectAllChildren(document.getElementById("first")); getSelection().toString()`,
    );
    results.highlighted = await check("read");
    await window.webContents.executeJavaScript(`getSelection().removeAllRanges()`);
    results.write = await check("write");
    results.write.page = await window.webContents.executeJavaScript(
      `(({ value, selectionStart, selectionEnd }) => ({ value, selectionStart, selectionEnd }))(document.getElementById("notes"))`,
    );
  } catch (error) {
    results.error = String(error);
  }
  console.log(JSON.stringify(results, null, 2));
  app.exit(results.error ? 1 : 0);
});
