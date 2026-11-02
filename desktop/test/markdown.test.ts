import { describe, expect, it } from "vitest";
import { holdBack, markdownToHtml, splitLive } from "../src/renderer/markdown.ts";

const formulas = (html: string) => html.match(/class="katex"/g)?.length ?? 0;

describe("answer math", () => {
  it("renders $…$ and \\(…\\) inline", () => {
    const html = markdownToHtml("Area is $\\pi r^2$, or \\(2\\pi r\\) around.");
    expect(formulas(html)).toBe(2);
    expect(html).not.toContain("katex-display");
    expect(html).not.toContain("\\pi");
  });

  it("renders $$…$$ and \\[…\\] on their own lines as display math", () => {
    const html = markdownToHtml("The roots:\n$$\nx = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\n$$\nand\n\n\\[ e^{i\\pi} + 1 = 0 \\]");
    expect(html.match(/katex-display/g)).toHaveLength(2);
    expect(html).toContain("<p>The roots:</p>");
    expect(html).toContain("<p>and</p>");
  });

  it("renders $$…$$ inside a paragraph as display math", () => {
    expect(markdownToHtml("So $$a^2 + b^2 = c^2$$ holds.")).toContain("katex-display");
  });

  it("keeps markdown out of formulas", () => {
    const html = markdownToHtml("$a_1 * b_2 * c$");
    expect(formulas(html)).toBe(1);
    expect(html).not.toContain("<em>");
  });

  it("leaves money and escaped dollars alone", () => {
    for (const text of ["It costs $5 and $10.", "Between $5-$10 a month.", "Write \\$x\\$ for a dollar sign."]) {
      expect(formulas(markdownToHtml(text))).toBe(0);
    }
  });

  it("leaves dollars in code alone", () => {
    expect(formulas(markdownToHtml("Run `echo $x$` or:\n\n```sh\necho $$ $x$\n```"))).toBe(0);
  });

  it("shows a formula KaTeX can't read without failing", () => {
    expect(markdownToHtml("$\\frac{a$")).toContain("katex-error");
  });
});

describe("answer code blocks", () => {
  it("highlights a known language, with its name and a copy button", () => {
    const html = markdownToHtml("```python\ndef add(a, b):\n    return a + b\n```");
    expect(html).toContain('<div class="code-block">');
    expect(html).toContain('<span class="code-lang">python</span>');
    expect(html).toContain('class="code-copy"');
    expect(html).toContain('<code class="hljs language-python">');
    expect(html).toContain('<span class="hljs-keyword">def</span>');
  });

  it("escapes code in an unknown language or none", () => {
    for (const fence of ["```madeup", "```"]) {
      const html = markdownToHtml(`${fence}\n<script>alert(1)</script>\n\`\`\``);
      expect(html).toContain("&#60;script&#62;alert(1)&#60;/script&#62;");
      expect(html).not.toContain("hljs");
      expect(html).toContain('class="code-copy"');
    }
  });

  it("shows a block still streaming in", () => {
    expect(markdownToHtml("```js\nconst a = 1;")).toContain('<span class="hljs-keyword">const</span>');
  });
});

describe("holding back a formula still streaming in", () => {
  it("cuts off an open display formula", () => {
    expect(holdBack("The roots:\n\n$$\nx = \\frac{-b")).toBe("The roots:\n\n");
    expect(holdBack("So \\[ e^{i")).toBe("So ");
  });

  it("cuts off an open inline formula", () => {
    expect(holdBack("Area is \\(\\pi r")).toBe("Area is ");
    expect(holdBack("Area is $\\pi r")).toBe("Area is ");
    expect(holdBack("First $a$, then $b^")).toBe("First $a$, then ");
  });

  it("leaves finished formulas and money", () => {
    for (const text of ["Area is $\\pi r^2$ here", "It costs $5 and $10", "Done: $$x$$ and \\(y\\).", "$HOME was set\nyes"]) {
      expect(holdBack(text)).toBe(text);
    }
  });

  it("leaves dollars in code", () => {
    for (const text of ["```sh\necho $$", "```sh\necho $$\n```\n\nok", "Run `echo $x"]) {
      expect(holdBack(text)).toBe(text);
    }
  });

  it("checks only the paragraph being written", () => {
    expect(holdBack("Price: $x\n\nThen $y")).toBe("Price: $x\n\nThen ");
  });
});

describe("splitLive", () => {
  it("keeps the blocks before the one being written", () => {
    expect(splitLive("One.\n\nTwo.\n\nThr")).toEqual({ settled: "One.\n\nTwo.\n\n", live: "Thr", open: false });
    expect(splitLive("Only one")).toEqual({ settled: "", live: "Only one", open: false });
  });

  it("keeps a code block whole while it streams in, blank lines included", () => {
    const text = "Intro.\n\n```js\nlet a;\n\nlet b;";
    expect(splitLive(text)).toEqual({ settled: "Intro.\n\n", live: "```js\nlet a;\n\nlet b;", open: true });
  });

  it("settles a closed code block", () => {
    const text = "Intro.\n\n```js\nlet a;\n```\nThen";
    expect(splitLive(text)).toEqual({ settled: "Intro.\n\n```js\nlet a;\n```\n", live: "Then", open: false });
  });
});
