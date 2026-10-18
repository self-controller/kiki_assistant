import { describe, expect, it } from "vitest";
import { searchUrl } from "../src/main/search.ts";

describe("searchUrl", () => {
  it("builds each place's search", () => {
    const query = "cute puppies";
    expect(searchUrl({ where: "web", query })).toBe("https://www.google.com/search?q=cute%20puppies");
    expect(searchUrl({ where: "images", query })).toBe("https://www.google.com/search?udm=2&q=cute%20puppies");
    expect(searchUrl({ where: "videos", query })).toBe("https://www.youtube.com/results?search_query=cute%20puppies");
    expect(searchUrl({ where: "maps", query })).toBe("https://www.google.com/maps/search/?api=1&query=cute%20puppies");
    expect(searchUrl({ where: "news", query })).toBe("https://news.google.com/search?q=cute%20puppies");
  });

  it("limits a web or image search to one site", () => {
    expect(searchUrl({ where: "web", query: "intentionality", site: "substack.com" })).toBe(
      "https://www.google.com/search?q=site%3Asubstack.com%20intentionality",
    );
    expect(searchUrl({ where: "images", query: "dogs", site: "reddit.com" })).toBe(
      "https://www.google.com/search?udm=2&q=site%3Areddit.com%20dogs",
    );
  });

  it("keeps the query inside the query string", () => {
    const url = new URL(searchUrl({ where: "web", query: "  a&b=c #d ünïcode/?  " })!);
    expect(url.origin).toBe("https://www.google.com");
    expect(url.hash).toBe("");
    expect([...url.searchParams]).toEqual([["q", "a&b=c #d ünïcode/?"]]);
  });

  it("opens nothing that isn't one of its searches", () => {
    expect(searchUrl({ where: "anywhere", query: "x" })).toBeNull();
    expect(searchUrl({ where: "web", query: "   " })).toBeNull();
    expect(searchUrl({ where: "web", query: "x".repeat(501) })).toBeNull();
    expect(searchUrl({ where: "web", query: 42 })).toBeNull();
    expect(searchUrl({ where: "web", query: "x", site: "https://evil.example/collect" })).toBeNull();
    expect(searchUrl({ where: "web", query: "x", site: "Substack.com" })).toBeNull();
    expect(searchUrl({ where: "videos", query: "x", site: "substack.com" })).toBeNull();
  });
});
