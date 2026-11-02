import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appIdFromCgroup, linuxIdentity, normalizeId } from "../src/main/apps/identity.ts";
import { HANDLERS, resolveApp } from "../src/main/apps/registry.ts";
import type { AppIdentity, AppMatch } from "../src/main/apps/types.ts";
import { lateFromApp, linuxEditTarget } from "../src/main/capture/linux.ts";
import { isMacTerminal } from "../src/main/capture/mac.ts";
import { parseGVariantString, parseShellApp } from "../src/main/gnomeShell.ts";

describe("appIdFromCgroup", () => {
  const unit = (name: string) => `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${name}\n`;

  it("reads the app's unit, as GNOME and systemd name it", () => {
    // Seen on Fedora 44 / GNOME 50: Zen (flatpak), Ptyxis (D-Bus activated), Kiki (its own scope).
    expect(appIdFromCgroup(unit("app-flatpak-app.zen_browser.zen-4136559294.scope"))).toBe("app.zen_browser.zen");
    expect(appIdFromCgroup(unit("dbus-:1.2-org.gnome.Ptyxis@6.service"))).toBe("org.gnome.ptyxis");
    expect(appIdFromCgroup(unit("app-kiki-2283679.scope"))).toBe("kiki");
    // Started from GNOME's app grid, with systemd's escaping.
    expect(appIdFromCgroup(unit("app-gnome-google\\x2dchrome-123.scope"))).toBe("google-chrome");
    expect(appIdFromCgroup(unit("app-gnome-org.gnome.Evolution\\x2dalarm\\x2dnotify@autostart.service"))).toBe(
      "org.gnome.evolution-alarm-notify",
    );
  });

  it("has nothing for a program started in a terminal", () => {
    expect(appIdFromCgroup(unit("vte-spawn-0b6c1a.scope"))).toBeUndefined();
    expect(appIdFromCgroup("")).toBeUndefined();
  });
});

describe("linuxIdentity", () => {
  const shell = { id: "Google-Chrome.desktop", name: "Google Chrome", wmClass: "Google-chrome", sandboxedId: "", title: "x", pid: 7 };

  it("lowercases ids and drops what's missing", () => {
    expect(normalizeId(" Org.Gnome.Ptyxis.desktop ")).toBe("org.gnome.ptyxis");
    expect(linuxIdentity({ appName: "Google Chrome" }, shell, { exe: "chrome" })).toEqual({
      appId: "google-chrome",
      wmClass: "google-chrome",
      atspiName: "google chrome",
      exe: "chrome",
      pid: 7,
    });
  });

  it("ignores GNOME's name for a window no desktop file claims", () => {
    expect(linuxIdentity({}, { ...shell, id: "window:12" }, {}).appId).toBeUndefined();
  });
});

/** One realistic identity per app, as Kiki would see it on Linux (or macOS for the macOS-only ones). */
const SEEN: [AppIdentity, string][] = [
  [{ appId: "google-chrome", wmClass: "google-chrome" }, "chrome"],
  [{ exe: "chrome", atspiName: "google chrome" }, "chrome"],
  [{ appId: "com.google.chrome", sandboxedId: "com.google.chrome" }, "chrome"],
  [{ appId: "chromium-browser", exe: "chromium-browser" }, "chromium"],
  [{ cgroupId: "org.chromium.chromium", atspiName: "chromium" }, "chromium"],
  [{ appId: "brave-browser" }, "brave"],
  [{ appId: "microsoft-edge", exe: "msedge" }, "edge"],
  [{ appId: "vivaldi-stable" }, "vivaldi"],
  [{ appId: "firefox", atspiName: "firefox" }, "firefox"],
  [{ cgroupId: "org.mozilla.firefox", atspiName: "firefox" }, "firefox"],
  [{ cgroupId: "app.zen_browser.zen", atspiName: "zen" }, "zen"],
  [{ appId: "librewolf" }, "librewolf"],
  [{ appId: "org.gnome.epiphany" }, "epiphany"],
  [{ cgroupId: "org.gnome.ptyxis", atspiName: "ptyxis", exe: "ptyxis" }, "ptyxis"],
  [{ appId: "org.gnome.terminal", wmClass: "gnome-terminal-server" }, "gnome-terminal"],
  [{ appId: "org.gnome.console", exe: "kgx" }, "gnome-console"],
  [{ appId: "com.gexperts.tilix" }, "tilix"],
  [{ appId: "org.kde.konsole" }, "konsole"],
  [{ appId: "kitty", wmClass: "kitty" }, "kitty"],
  [{ appId: "org.wezfurlong.wezterm" }, "wezterm"],
  [{ appId: "alacritty", wmClass: "alacritty" }, "alacritty"],
  [{ wmClass: "footclient" }, "foot"],
  [{ appId: "com.mitchellh.ghostty" }, "ghostty"],
  [{ appId: "dev.warp.warp" }, "warp"],
  [{ macName: "terminal" }, "mac-terminal"],
  [{ macName: "iterm2" }, "iterm2"],
  [{ appId: "code", wmClass: "code" }, "vscode"],
  [{ appId: "com.visualstudio.code", sandboxedId: "com.visualstudio.code", wmClass: "code" }, "vscode"],
  [{ appId: "codium" }, "vscodium"],
  [{ appId: "cursor" }, "cursor"],
  [{ appId: "org.gnome.texteditor", atspiName: "gnome-text-editor" }, "gnome-text-editor"],
  [{ appId: "org.gnome.gedit" }, "gedit"],
  [{ appId: "org.kde.kate" }, "kate"],
];

describe("resolveApp", () => {
  it.each(SEEN)("knows %o as %s", (identity, id) => {
    expect(resolveApp(identity)?.handler.id).toBe(id);
  });

  it("has a case above for every app", () => {
    expect(new Set(SEEN.map(([, id]) => id))).toEqual(new Set(HANDLERS.map((handler) => handler.id)));
  });

  it("leaves apps it has nothing for to the generic behavior", () => {
    // Kiki itself, an Electron app, Files, and nothing at all.
    expect(resolveApp({ atspiName: "electron", exe: "electron", cgroupId: "kiki" })).toBeUndefined();
    expect(resolveApp({ cgroupId: "org.gnome.nautilus", atspiName: "org.gnome.nautilus" })).toBeUndefined();
    expect(resolveApp({})).toBeUndefined();
  });

  it("goes by the most specific name, and says which", () => {
    expect(resolveApp({ appId: "code", atspiName: "zen" })).toMatchObject({ handler: { id: "vscode" }, by: "appId" });
    expect(resolveApp({ appId: "window-ish", exe: "ptyxis" })).toMatchObject({ handler: { id: "ptyxis" }, by: "exe" });
  });
});

describe("the handlers", () => {
  it("each have their own id and names, all lowercase", () => {
    const ids = HANDLERS.map((handler) => handler.id);
    expect(new Set(ids).size).toBe(ids.length);
    const lists: (keyof AppMatch)[] = ["ids", "wmClasses", "exes", "atspiNames", "macNames"];
    for (const list of lists) {
      const seen = new Map<string, string>();
      for (const handler of HANDLERS) {
        for (const name of handler.match[list] ?? []) {
          expect(name).toBe(name.toLowerCase());
          expect(seen.get(name), `${list} "${name}" in ${handler.id} and ${seen.get(name)}`).toBeUndefined();
          seen.set(name, handler.id);
        }
      }
    }
  });

  it("are all in the README's list of supported apps", () => {
    const readme = readFileSync(join(import.meta.dirname, "../../README.md"), "utf8");
    const section = readme.slice(readme.indexOf("## Supported apps"), readme.indexOf("\n## ", readme.indexOf("## Supported apps") + 1));
    expect(section.length).toBeGreaterThan(20);
    for (const handler of HANDLERS) expect(section, handler.name).toContain(handler.name);
  });
});

describe("titles", () => {
  const title = (id: string, windowTitle: string, pageTitle?: string) =>
    HANDLERS.find((handler) => handler.id === id)!.title!(windowTitle, pageTitle);

  it("send a browser's page title, without the browser's name", () => {
    expect(title("chrome", "GitHub - Google Chrome")).toBe("GitHub");
    expect(title("chrome", "GitHub - Google Chrome - Work")).toBe("GitHub");
    expect(title("chrome", "Ignored - Google Chrome", "The page's own")).toBe("The page's own");
    expect(title("edge", "News - Microsoft​ Edge")).toBe("News");
    expect(title("firefox", "Docs — Mozilla Firefox Private Browsing")).toBe("Docs");
    expect(title("zen", "Feed | LinkedIn — Zen Browser")).toBe("Feed | LinkedIn");
  });

  it("keep titles that only look like it, or are only the app's name", () => {
    expect(title("chrome", "Why - Google Chrome tips")).toBe("Why - Google Chrome tips");
    expect(title("chrome", "Google Chrome")).toBe("Google Chrome");
  });

  it("keep an editor's file and folder", () => {
    expect(title("vscode", "● main.ts - kiki - Visual Studio Code")).toBe("● main.ts - kiki");
    expect(title("vscode", "main.ts - kiki - Code - OSS")).toBe("main.ts - kiki");
    expect(title("gedit", "notes.txt (~/Desktop) - gedit")).toBe("notes.txt (~/Desktop)");
  });
});

describe("terminals that share no text", () => {
  it("get text at the prompt, with the terminal's paste", () => {
    const opaque = { ok: true, source: "none" as const };
    expect(linuxEditTarget(opaque, "ls output", true, true, "terminal")).toEqual({
      mode: "insert",
      original: "",
      kind: "terminal",
      paste: true,
    });
    expect(linuxEditTarget(opaque, "ls output", false, false, "terminal")).toBeUndefined();
    // An app Kiki doesn't know stays a plain paste at the cursor.
    expect(linuxEditTarget(opaque, "ls output", true)).toMatchObject({ kind: "unknown", mode: "replace" });
  });

  it("macOS terminals are the ones Kiki always knew", () => {
    for (const name of ["Terminal", "iTerm2", "Ghostty", "WezTerm", "Alacritty", "kitty", "Warp"]) {
      expect(isMacTerminal(name), name).toBe(true);
    }
    expect(isMacTerminal("Safari")).toBe(false);
    expect(isMacTerminal("Google Chrome")).toBe(false);
  });
});

describe("lateFromApp", () => {
  const screen = { kind: "terminal" as const, before: "$ make\nerror: missing ;\n$ ", anchor: "", after: "" };

  it("is the app's lines, as the window's late text", () => {
    expect(lateFromApp({ vicinity: screen }, "missing ;")).toEqual({ text: "", vicinity: screen });
    expect(lateFromApp(undefined, "x")).toBeUndefined();
    expect(lateFromApp({}, "x")).toBeUndefined();
  });

  it("drops a primary selection the window doesn't show", () => {
    expect(lateFromApp({ vicinity: screen }, "my API key")).toEqual({ text: "", vicinity: screen, selection: "" });
  });

  it("takes the app's word on what's highlighted", () => {
    expect(lateFromApp({ vicinity: screen, selection: "error" }, "stale")).toMatchObject({ selection: "error" });
    expect(lateFromApp({ vicinity: screen, selection: "" }, "stale")).toMatchObject({ selection: "" });
    expect(lateFromApp({ vicinity: screen, selection: "same" }, "same")).not.toHaveProperty("selection");
  });
});

describe("SourceApp's reply", () => {
  it("unquotes gdbus's text, escapes included", () => {
    expect(parseGVariantString(`(uint32 11, '{"id":"x"}')\n`)).toBe('{"id":"x"}');
    expect(parseGVariantString(`(uint32 11, 'it\\'s a \\\\ \\u00e9 \\n')`)).toBe("it's a \\ é \n");
    expect(parseGVariantString(`(uint32 11, "say 'hi'")`)).toBe("say 'hi'");
    expect(parseGVariantString("(uint32 11,)")).toBeNull();
  });

  it("names the app, as a headless GNOME Shell answered for Text Editor", () => {
    const out = `(uint32 12, '{"id":"org.gnome.TextEditor.desktop","name":"Text Editor","wmClass":"org.gnome.TextEditor","sandboxedId":"","title":"New Document (Draft) - Text Editor","pid":2312772}')\n`;
    const shell = parseShellApp(parseGVariantString(out)!);
    expect(shell).toMatchObject({ id: "org.gnome.TextEditor.desktop", title: "New Document (Draft) - Text Editor", pid: 2312772 });
    expect(resolveApp(linuxIdentity({}, shell, {}))).toMatchObject({ handler: { id: "gnome-text-editor" }, by: "appId" });
  });

  it("reads the app, or nothing without one", () => {
    const json = JSON.stringify({ id: "kitty.desktop", name: "kitty", wmClass: "kitty", sandboxedId: "", title: "~", pid: 42 });
    expect(parseShellApp(json)).toEqual({ id: "kitty.desktop", name: "kitty", wmClass: "kitty", sandboxedId: "", title: "~", pid: 42 });
    expect(parseShellApp("{}")).toBeNull();
    expect(parseShellApp("not json")).toBeNull();
    expect(parseShellApp(JSON.stringify({ id: "x", pid: -1 }))?.pid).toBe(0);
  });
});
