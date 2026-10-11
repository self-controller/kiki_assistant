import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installGnomeShortcut, parseStrv } from "../src/main/linuxSetup.ts";

function hasMediaKeysSchema(): boolean {
  try {
    execFileSync("gsettings", ["list-keys", "org.gnome.settings-daemon.plugins.media-keys"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Runs the real gsettings against a throwaway keyfile backend, never the user's settings.
describe.runIf(process.platform === "linux" && hasMediaKeysSchema())("installGnomeShortcut", () => {
  const saved = { ...process.env };
  let dir = "";
  const get = (...args: string[]) => execFileSync("gsettings", ["get", ...args], { encoding: "utf8" }).trim();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "kiki-gsettings-"));
    process.env.GSETTINGS_BACKEND = "keyfile";
    process.env.XDG_CONFIG_HOME = dir;
    process.env.APPIMAGE = "/opt/Kiki's App/kiki.AppImage";
    execFileSync("gsettings", [
      "set",
      "org.gnome.settings-daemon.plugins.media-keys",
      "custom-keybindings",
      "['/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/']",
    ]);
  });

  afterAll(() => {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds the Kiki binding once and keeps existing custom shortcuts", async () => {
    await installGnomeShortcut("Ctrl+Alt+K");
    await installGnomeShortcut("Ctrl+Alt+J");

    const list = parseStrv(get("org.gnome.settings-daemon.plugins.media-keys", "custom-keybindings"));
    expect(list).toEqual([
      "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/",
      "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/kiki/",
    ]);

    const schema =
      "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/kiki/";
    expect(get(schema, "binding")).toBe("'<Control><Alt>j'");
    expect(get(schema, "name")).toBe("'Ask Kiki'");
    // GNOME splits the command like a shell; the apostrophe in the path must survive that.
    const printed = get(schema, "command"); // a GVariant literal, e.g. "'/opt/...' --ask"
    const command = printed.slice(1, -1).replace(/\\(.)/g, "$1");
    const argv = execFileSync("/usr/bin/python3", ["-c", "import shlex,sys,json; print(json.dumps(shlex.split(sys.argv[1])))", command], {
      encoding: "utf8",
    });
    expect(JSON.parse(argv)).toEqual(["/opt/Kiki's App/kiki.AppImage", "--ask"]);
  });
});
