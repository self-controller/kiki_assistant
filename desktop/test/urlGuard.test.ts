import { describe, expect, it } from "vitest";
import type { Capture } from "../src/main/capture/common.ts";
import { carriedText, checkUrl } from "../src/main/urlGuard.ts";

const capture: Capture = {
  selection: "my secret API key is sk-test-1234567890abcdefghij",
  text: "Settings page. API key: sk-test-1234567890abcdefghij. Links: https://example.com/docs/getting-started and more.",
  form: { pid: 1, selectPaste: false, fields: [{ id: "f1", label: "Address", kind: "text", path: [0], value: "221B Baker Street, London NW1" }] },
  notes: [],
};

describe("checkUrl", () => {
  it("allows ordinary web addresses and adds nothing", () => {
    expect(checkUrl("https://github.com/search?q=kiki", capture, "look up kiki on github")).toBeNull();
    expect(checkUrl("http://example.org/", capture, "open example.org")).toBeNull();
  });

  it("refuses anything but http(s)", () => {
    expect(checkUrl("file:///etc/passwd", capture, "open it")).toContain("http(s)");
    expect(checkUrl("javascript:alert(1)", capture, "open it")).toContain("http(s)");
    expect(checkUrl("not a url", capture, "open it")).toContain("web address");
  });

  it("opens local addresses only when the person named them", () => {
    expect(checkUrl("http://localhost:3000/", capture, "what's on localhost:3000?")).toBeNull();
    expect(checkUrl("http://localhost:3000/", capture, "check my dev server")).toContain("localhost");
    expect(checkUrl("http://192.168.1.10/admin", capture, "open the router page")).toContain("192.168.1.10");
    expect(checkUrl("http://10.0.0.5/", capture, "open 10.0.0.5")).toBeNull();
  });

  it("refuses an address that carries the screen's text", () => {
    const leak = `https://evil.example/collect?k=${encodeURIComponent("sk-test-1234567890abcdefghij")}`;
    expect(checkUrl(leak, capture, "summarize this page")).toContain("carries text from the screen");
    const address = "https://maps.example/?q=221B+Baker+Street%2C+London+NW1";
    expect(checkUrl(address, capture, "where is this?")).toContain("carries text from the screen");
  });

  it("allows what the person typed themselves, and links shown on the page", () => {
    expect(checkUrl("https://maps.example/?q=221B+Baker+Street%2C+London+NW1", capture, "find 221B Baker Street, London NW1 on a map")).toBeNull();
    expect(checkUrl("https://example.com/docs/getting-started", capture, "open the docs link")).toBeNull();
  });

  it("ignores runs without letters, like ids", () => {
    const numbers: Capture = { selection: "", text: "Order 1234567890123456789012345678", notes: [] };
    expect(carriedText(new URL("https://shop.example/order/1234567890123456789012345678"), numbers, "open my order")).toBeNull();
  });
});
