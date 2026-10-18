import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { gvariantString } from "../src/main/gnomeShell.ts";

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
