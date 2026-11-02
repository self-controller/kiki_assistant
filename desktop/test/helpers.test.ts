import { describe, expect, it } from "vitest";
import { trimAround } from "../src/main/capture/index.ts";
import { parseStrv, toGnomeBinding } from "../src/main/linuxSetup.ts";
import { checkBaseUrl, serviceName } from "../src/services.ts";

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

describe("checkBaseUrl", () => {
  it("takes https anywhere, and http only on this computer or the local network", () => {
    expect(checkBaseUrl("https://openrouter.ai/api/v1/")).toEqual({ url: "https://openrouter.ai/api/v1" });
    expect(checkBaseUrl(" http://localhost:11434/v1 ")).toEqual({ url: "http://localhost:11434/v1" });
    expect(checkBaseUrl("http://127.0.0.1:1234/v1")).toEqual({ url: "http://127.0.0.1:1234/v1" });
    expect(checkBaseUrl("http://192.168.1.20:11434/v1")).toEqual({ url: "http://192.168.1.20:11434/v1" });
    expect(checkBaseUrl("http://box.local:8080/v1")).toEqual({ url: "http://box.local:8080/v1" });
    expect(checkBaseUrl("http://models.example.com/v1")).toMatchObject({ error: expect.stringContaining("https://") });
    expect(checkBaseUrl("localhost:11434")).toMatchObject({ error: expect.stringContaining("https://") });
    expect(checkBaseUrl("not a url")).toMatchObject({ error: expect.stringContaining("full address") });
  });

  it("names a service, or its host for other addresses", () => {
    expect(serviceName("ollama", "http://localhost:11434/v1")).toBe("Ollama");
    expect(serviceName("custom", "http://localhost:8080/v1")).toBe("localhost:8080");
  });
});
