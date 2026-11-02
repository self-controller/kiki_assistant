import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { gvariantString, keyPresses, MAX_REPEATED_KEYS, parseShellWindows, type KeyStep } from "../src/main/gnomeShell.ts";

const TRICKY = [
  "plain",
  "it's \"quoted\"",
  "back\\slash \\n not a newline",
  "two\nlines\r\n\ttabbed",
  "emoji 🎉 and accents: café, naïve",
  "",
  "https://docs.google.com/document/d/abc/edit?usp=sharing",
];

/** GLib's own GVariant parser, through the system Python's GObject bindings, as gdbus parses its arguments. */
function hasGlibParser(): boolean {
  try {
    execFileSync("/usr/bin/python3", ["-I", "-c", "from gi.repository import GLib"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("keyPresses", () => {
  it("counts a repeated Backspace by its count, and every other step as one", () => {
    const steps: KeyStep[] = ["ctrl+h", "backspace*120", "escape"];
    expect(keyPresses(steps)).toBe(122);
    expect(keyPresses(["ctrl+z"])).toBe(1);
    expect(MAX_REPEATED_KEYS).toBe(2000);
  });
});

describe("gvariantString", () => {
  it("quotes text and escapes what GVariant's text format would read differently", () => {
    expect(gvariantString("plain")).toBe("'plain'");
    expect(gvariantString("it's")).toBe("'it\\'s'");
    expect(gvariantString("a\\b")).toBe("'a\\\\b'");
    expect(gvariantString("a\nb\tc")).toBe("'a\\u000ab\\u0009c'");
    expect(gvariantString("café 🎉")).toBe("'café 🎉'");
  });

  it.runIf(hasGlibParser())("reads back exactly with GLib's parser", () => {
    const script =
      "import json, sys\nfrom gi.repository import GLib\n" +
      "print(json.dumps([GLib.Variant.parse(GLib.VariantType.new('s'), arg, None, None).unpack() for arg in sys.argv[1:]]))";
    const out = execFileSync("/usr/bin/python3", ["-I", "-c", script, ...TRICKY.map(gvariantString)], { encoding: "utf8" });
    expect(JSON.parse(out)).toEqual(TRICKY);
  });
});

describe("parseShellWindows", () => {
  it("reads the extension's window list, skipping what isn't a window", () => {
    const json = JSON.stringify([
      { id: 12345, pid: 42, app: "org.gnome.Nautilus.desktop", name: "Files", wmClass: "org.gnome.Nautilus", sandboxedId: "", title: "Downloads", focused: false, minimized: false, onWorkspace: true, kiki: false, source: false, x: 10, y: 20, width: 800, height: 600 },
      { id: "77", pid: 7, app: "", name: "", wmClass: "zen", sandboxedId: "app.zen_browser.zen", title: "Example", focused: true, minimized: false, onWorkspace: true, kiki: false, source: true, x: 0, y: 0, width: 1920, height: 1080 },
      { pid: 1 },
      "nope",
    ]);
    const windows = parseShellWindows(json);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ id: "12345", pid: 42, name: "Files", title: "Downloads", source: false, width: 800 });
    expect(windows[1]).toMatchObject({ id: "77", sandboxedId: "app.zen_browser.zen", focused: true, source: true });
    expect(parseShellWindows("not json")).toEqual([]);
    expect(parseShellWindows("{}")).toEqual([]);
  });
});
