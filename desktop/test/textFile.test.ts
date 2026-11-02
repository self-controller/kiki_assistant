import { LIMITS } from "@kiki/shared";
import { describe, expect, it } from "vitest";
import { readTextFile } from "../src/renderer/textFile.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("attached text files", () => {
  it("reads UTF-8 text whole", () => {
    expect(readTextFile(bytes("# Notes\n\nCafé ☕ and 漢字"))).toEqual({ text: "# Notes\n\nCafé ☕ and 漢字", truncated: false });
  });

  it("drops a byte order mark", () => {
    expect(readTextFile(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("hi")]))?.text).toBe("hi");
  });

  it("turns down files that aren't text", () => {
    expect(readTextFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBeNull();
    expect(readTextFile(new Uint8Array([0x68, 0x69, 0xff, 0xfe, 0x41]))).toBeNull();
  });

  it("cuts a long file, never in the middle of a character", () => {
    const long = readTextFile(bytes("a".repeat(LIMITS.fileChars + 10)));
    expect(long).toEqual({ text: "a".repeat(LIMITS.fileChars), truncated: true });
    const emoji = readTextFile(bytes(`${"a".repeat(LIMITS.fileChars - 1)}😀 and more`));
    expect(emoji?.text).toBe("a".repeat(LIMITS.fileChars - 1));
  });
});
