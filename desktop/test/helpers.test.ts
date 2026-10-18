import { describe, expect, it } from "vitest";
import { trimAround } from "../src/main/capture/index.ts";
import { parseStrv, toGnomeBinding } from "../src/main/linuxSetup.ts";
import { validateServerUrl } from "../src/main/settings.ts";

describe("toGnomeBinding", () => {
  it("converts Electron accelerators to GNOME bindings", () => {
    expect(toGnomeBinding("Ctrl+Alt+K")).toBe("<Control><Alt>k");
    expect(toGnomeBinding("Super+Shift+Space")).toBe("<Super><Shift>space");
    expect(toGnomeBinding("CommandOrControl+F2")).toBe("<Control>F2");
  });

  it("rejects bare keys and unknown modifiers", () => {
    expect(() => toGnomeBinding("K")).toThrow();
    expect(() => toGnomeBinding("Hyper+K")).toThrow(/Unknown modifier/);
  });
});

describe("parseStrv", () => {
  it("parses GVariant string arrays", () => {
    expect(parseStrv("@as []")).toEqual([]);
    expect(parseStrv("['/a/custom0/', '/b/kiki/']")).toEqual(["/a/custom0/", "/b/kiki/"]);
  });
});

describe("trimAround", () => {
  const text = "a".repeat(1000) + "NEEDLE" + "b".repeat(1000);

  it("keeps short text unchanged", () => {
    expect(trimAround("short", "x", 100)).toBe("short");
  });

  it("centers the window on the selection", () => {
    const out = trimAround(text, "NEEDLE", 106);
    expect(out).toContain("NEEDLE");
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(108);
  });

  it("falls back to the start when the selection isn't found", () => {
    expect(trimAround(text, "missing", 10)).toBe("aaaaaaaaaa…");
  });

  it("centers on what was on screen when nothing is selected", () => {
    const page = "a".repeat(1000) + "SHOWN" + "b".repeat(1000);
    expect(trimAround(page, "", 11, 1002)).toBe("…aaaSHOWNbbb…");
    expect(trimAround(page, "missing", 11, 1002)).toBe("…aaaSHOWNbbb…");
  });

  it("prefers the selection over what was on screen", () => {
    expect(trimAround(text, "NEEDLE", 106, 0)).toBe(trimAround(text, "NEEDLE", 106));
  });

  it("keeps the window inside the text when the focus is near an end", () => {
    expect(trimAround(text, "", 10, 2)).toBe("aaaaaaaaaa…");
    expect(trimAround(text, "", 10, text.length - 1)).toBe("…bbbbbbbbbb");
  });
});

describe("validateServerUrl", () => {
  it("requires https except for this machine", () => {
    expect(validateServerUrl("https://kiki.example.com")).toBeNull();
    expect(validateServerUrl("http://127.0.0.1:8787")).toBeNull();
    expect(validateServerUrl("http://localhost:8787")).toBeNull();
    expect(validateServerUrl("http://kiki.example.com")).toMatch(/https/);
    expect(validateServerUrl("kiki.example.com")).toMatch(/full address/);
  });
});
