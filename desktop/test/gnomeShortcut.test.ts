import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseGVariantString } from "../src/main/gnomeShell.ts";
import { askCommand, installGnomeShortcut, parseStrv, refreshGnomeShortcut } from "../src/main/linuxSetup.ts";

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
    process.env.XDG_RUNTIME_DIR = dir;
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
    const command = parseGVariantString(get(schema, "command"))!;
    const argv = execFileSync("/usr/bin/python3", ["-c", "import shlex,sys,json; print(json.dumps(shlex.split(sys.argv[1])))", command], {
      encoding: "utf8",
    });
    expect(JSON.parse(argv)).toEqual(askCommand());
    expect(askCommand().slice(-3)).toEqual([join(dir, "kiki.sock"), "/opt/Kiki's App/kiki.AppImage", "--ask"]);
  });

  it("points a shortcut from before the ask socket at it", async () => {
    const schema =
      "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/kiki/";
    execFileSync("gsettings", ["set", schema, "command", `"'/opt/Kiki''s App/kiki.AppImage' --ask"`]);
    await refreshGnomeShortcut();
    expect(parseGVariantString(get(schema, "command"))).toContain("kiki.sock");
  });
});

describe.runIf(process.platform === "linux")("askCommand", () => {
  const saved = { ...process.env };
  let dir = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "kiki-ask-"));
    process.env.XDG_RUNTIME_DIR = dir;
    // Stands in for Kiki, which the command starts when none is listening.
    process.env.APPIMAGE = "/bin/echo";
  });

  afterAll(() => {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it("says ask to the running Kiki", async () => {
    const [program, ...args] = askCommand();
    const heard = new Promise<string>((resolve) => {
      const server = createServer((socket) => {
        socket.setEncoding("utf8");
        socket.once("data", (data: string) => {
          resolve(data);
          server.close();
        });
      });
      server.listen(join(dir, "kiki.sock"));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(execFileSync(program!, args, { encoding: "utf8" })).toBe("");
    expect(await heard).toBe("ask");
  });

  it("starts Kiki when none is listening", () => {
    const [program, ...args] = askCommand();
    expect(execFileSync(program!, args, { encoding: "utf8" })).toBe("--ask\n");
  });
});
