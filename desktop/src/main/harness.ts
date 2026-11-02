// A check of Kiki's browser against local pages, run with `kiki --browser-harness scripts/browser-harness/page.html`
// (from a build: `npx electron desktop/out/main/index.js --browser-harness desktop/scripts/browser-harness/page.html`).
// The page's folder is served over a local HTTP server (so delays and hanging requests are real), and the checks
// go two ways: the tab's own methods (reads, fields, typing, clicks, scrolls, screenshots, dialogs, popups,
// permissions), and the target tools as the model calls them (open_url, click, act, scroll, browser), which
// wait for the page and read it: navigation and loading notes, diffs, dialogs, covered and redrawn controls,
// slow results, an endless feed. Prints JSON.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, extname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ToolResult } from "@kiki/shared";
import { kikiBrowser } from "./browser.ts";
import type { Capture } from "./capture/common.ts";
import { newScreenState } from "./screen.ts";
import { newTargets, runTargetTool, type TargetContext } from "./targets.ts";

interface Check {
  name: string;
  ok: boolean;
  detail?: unknown;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".json": "application/json",
};

/**
 * Serves the files in `dir` at http://127.0.0.1:<port>/<name>, each delayed by its `?delay=` milliseconds;
 * `/slow.json` answers `{ value: "slow answer" }` after its delay; `/hang.png` and `/hang.json` never answer.
 */
async function serve(dir: string): Promise<{ origin: string; close: () => void }> {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/hang.png" || url.pathname === "/hang.json") return;
    const delay = Number(url.searchParams.get("delay") ?? 0);
    if (delay > 0) await sleep(delay);
    if (url.pathname === "/slow.json") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ value: "slow answer" }));
      return;
    }
    const file = join(dir, basename(url.pathname) || "page.html");
    try {
      const body = await readFile(file);
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** The id of the control (⟦b3 Name⟧) or field (⟦f2 Label⟧) that says `name` in `text`. */
function idOf(text: string | undefined, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`⟦([bf]\\d+) ${escaped}⟧`).exec(text ?? "")?.[1];
}

export async function runBrowserHarness(page: string): Promise<number> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: unknown) => {
    checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
    console.error(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` ${JSON.stringify(detail).slice(0, 400)}`}`);
  };
  const browser = kikiBrowser();
  const server = await serve(dirname(page));
  const url = `${server.origin}/${basename(page)}`;
  try {
    // --- The tab's own methods. ---
    const { tab, ready } = await browser.open(url);
    check("opens the page and waits for it to be quiet, briefly", ready.navigated === "page" && ready.quiet && !ready.loading && ready.waitedMs < 1_500, ready);
    let read = await tab.read({ screenshot: true, quiet: true });
    check("reads the heading and paragraph", /Kiki browser harness/.test(read.text) && /first paragraph/.test(read.text), read.text.slice(0, 300));
    const link = idOf(read.text, "Second page");
    const button = idOf(read.text, "Say hello");
    const query = idOf(read.text, "Search");
    const agree = idOf(read.text, "I agree");
    const secret = read.fields.find((field) => field.label.includes("(password)"));
    check("lists the link, button and fields with ids", Boolean(link && button && query && agree), { link, button, query, agree, fields: read.fields });
    check("marks the password field and hides its value", Boolean(secret) && secret?.value === "", secret);
    check("takes a screenshot with its size", Boolean(read.shot) && (read.shot?.size.width ?? 0) > 100, read.shot?.size);
    check(
      "notes the cookie notice with its buttons",
      read.notes.some((note) => /cookie notice is open .*We use cookies.*⟦b\d+ Accept all⟧ ⟦b\d+ Reject all⟧/.test(note)),
      read.notes,
    );

    if (query) {
      check("types into the search field", (await tab.setField(query, "puppies")) === null);
      await tab.key("enter");
      const after = await tab.waitReady();
      read = await tab.read({ quiet: after.quiet });
      check("Enter submits the form", /Searched for: puppies/.test(read.text), read.text.slice(0, 200));
    }
    if (agree) {
      check("checks a check box", (await tab.setField(agree, true)) === null);
      read = await tab.read();
      check("the check box reads as checked", read.fields.some((field) => field.id === agree && field.checked === true), read.fields);
    }
    check("refuses a password field without approval", (await tab.setField(secret?.id ?? "f0", "hunter2"))?.includes("password") === true);
    check("fills a password field on an approved card", secret ? (await tab.setField(secret.id, "hunter2", { approved: true })) === null : false);

    if (button) {
      check("clicks a button by id", (await tab.click(button)) === null);
      await tab.settle();
      read = await tab.read();
      check("the alert was dismissed and noted", read.notes.some((note) => note.includes("alert")) && /Hello pressed/.test(read.text), { notes: read.notes });
    }
    const popup = idOf(read.text, "Open in new window");
    if (popup) {
      await tab.click(popup);
      await tab.settle();
      read = await tab.read();
      check("a window.open link stays in the tab, with a note", browser.tabs.length === 1 && /Popup target/.test(read.text) && read.notes.some((note) => /new window/.test(note)), {
        tabs: browser.tabs.length,
        url: tab.url,
        notes: read.notes,
      });
      tab.back();
      await tab.settle();
      read = await tab.read();
    }
    const geo = idOf(read.text, "Where am I");
    if (geo) {
      await tab.click(geo);
      await tab.settle();
      read = await tab.read();
      check("a permission request is denied", /Location: denied/.test(read.text), read.text.match(/Location: \w+/)?.[0]);
    }
    const before = read.text;
    check("the heading is on screen before scrolling", /Kiki browser harness/.test(before) && !/Item 50/.test(before), before.slice(0, 80));
    await tab.scroll({ direction: "down" });
    await tab.settle();
    read = await tab.read();
    check("scrolling down changes what's on screen", read.text !== before, read.text.slice(-120));
    check("scrolls to text", await tab.scroll({ to: "Item 40" }));
    await tab.settle();
    read = await tab.read();
    check("reads only what's on screen after scrolling", /Item 40/.test(read.text) && !/Kiki browser harness\n/.test(read.text), read.text.slice(0, 120));
    console.error("step: screenshot + coordinates");

    const shot = await tab.screenshot();
    if (shot) {
      await tab.scroll({ to: "Say hello" });
      await tab.settle();
      const fresh = await tab.read({ screenshot: true });
      const rect = (await tab.webContents.executeJavaScript(
        `(() => { const r = document.getElementById("hello").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: innerWidth, h: innerHeight }; })()`,
      )) as { x: number; y: number; w: number; h: number };
      if (fresh.shot) {
        // The page was reloaded on the way (the popup, back), so its count starts over: compare before and after.
        const count = () => tab.webContents.executeJavaScript("window.helloCount || 0") as Promise<number>;
        const before = await count();
        const point = { x: (rect.x / rect.w) * fresh.shot.size.width, y: (rect.y / rect.h) * fresh.shot.size.height };
        await tab.clickAt(point, fresh.shot.size);
        await tab.settle();
        const after = await tab.read();
        const pressed = await count();
        check("clicks at screenshot coordinates", pressed === before + 1 && new RegExp(`Hello pressed: ${before + 1}`).test(after.text), {
          before,
          pressed,
          seen: after.text.match(/Hello pressed: \d+/)?.[0],
          rect,
          point,
          shot: fresh.shot.size,
        });
      } else {
        check("clicks at screenshot coordinates", false, "no screenshot");
      }
    }
    // The page was reloaded on the way (the popup, back): its ids are new, so read them again.
    await tab.scroll({ to: "first paragraph" });
    read = await tab.read();
    const linkAgain = idOf(read.text, "Second page");
    if (linkAgain) {
      check("clicks a link", (await tab.click(linkAgain)) === null);
      const navigated = await tab.settle();
      read = await tab.read();
      check("the link navigated and the new page reads", navigated && /Second page/.test(read.title + read.text), { title: read.title, url: tab.url });
    } else {
      check("clicks a link", false, read.text.slice(0, 200));
    }
    const stale = idOf(read.text, "Say hello");
    if (stale) {
      // Read on the second page, then the first comes back: the id is from another document.
      tab.back();
      await tab.settle();
      read = await tab.read();
      check("a control read on an earlier document is found again by what it says", (await tab.click(stale)) === null && /Hello pressed/.test((await tab.read()).text), { stale });
    }

    if (process.argv.includes("--with-show")) {
      console.error("step: show and hide the window (it appears for a moment)");
      await browser.show();
      const shown = await tab.read();
      check("the shown view reads the same page", /Kiki browser harness|Second page/.test(shown.title + shown.text) && browser.visible, { title: shown.title, url: tab.url });
      await sleep(1_000);
      browser.hide();
      await sleep(500);
      const hidden = await tab.read();
      check("hiding goes back to the offscreen page", !browser.visible && hidden.url === shown.url, { url: hidden.url });
    }
    browser.endTurn();
    check("tabs close at the end of the answer", browser.tabs.length === 0);

    // --- The target tools, as the model calls them. ---
    console.error("step: the target tools");
    const capture: Capture = { selection: "", notes: [] };
    const ctx: TargetContext = {
      targets: newTargets(capture, newScreenState()),
      look: { text: true, window: true, screenshot: false },
      // The address guard opens local addresses only when the question names them.
      question: `open ${url}`,
      helperVersion: 0,
      allow: { browser: true, windows: false, coordinates: true, autoApprove: false },
      onTarget: () => {},
      banner: (work) => work(),
    };
    let calls = 0;
    const tool = (name: string, input: Record<string, unknown>) => runTargetTool(ctx, { id: `h${calls++}`, name, input });
    const timed = async (name: string, input: Record<string, unknown>): Promise<{ result: ToolResult; ms: number }> => {
      const started = Date.now();
      const result = await tool(name, input);
      return { result, ms: Date.now() - started };
    };

    let result = await tool("open_url", { url });
    let text = result.screen?.text;
    check("open_url reads the page with the cookie notice noted", /Kiki browser harness/.test(text ?? "") && /cookie notice is open/.test(result.content), result.content);

    const covered = idOf(text, "Covered link");
    result = await tool("click", { control: covered ?? "b0" });
    check(
      "a covered link is clicked through the page, with a note on what was in the way, and the navigation is noted",
      /was in the way of “Covered link”/.test(result.content) && /The page changed to .*page=covered/.test(result.content) && /Covered page/.test(result.screen?.windowTitle ?? ""),
      result.content,
    );
    result = await tool("browser", { back: true });
    text = result.screen?.text;
    check("browser{back} waits for the page and reads it", /Kiki browser harness/.test(text ?? "") && /Covered link/.test(text ?? ""), result.content);

    const nothing = idOf(text, "Does nothing");
    const idle = await timed("click", { control: nothing ?? "b0" });
    check("a click that changes nothing says so, within a second", /Nothing visible changed/.test(idle.result.content) && idle.ms < 1_000, { ms: idle.ms, content: idle.result.content });

    const accept = idOf(text, "Accept all");
    result = await tool("click", { control: accept ?? "b0" });
    check(
      "clicking Accept all closes the notice, and the result shows only what changed",
      !/We use cookies/.test(result.screen?.text ?? "") && /lines unchanged, as in your last look/.test(result.screen?.text ?? "") && !/cookie notice is open/.test(result.content),
      { content: result.content, text: result.screen?.text?.slice(0, 300) },
    );

    const rerender = idOf(text, "Re-render me");
    result = await tool("click", { control: rerender ?? "b0" });
    check("a click that changes part of the page shows the change", /Generation 1/.test(result.screen?.text ?? ""), result.screen?.text?.slice(0, 300));
    result = await tool("click", { control: rerender ?? "b0" });
    check(
      "a control the page redrew is found again by what it says, and clicked",
      /had been redrawn; Kiki found “Re-render me” again/.test(result.content) && /Generation 2/.test(result.screen?.text ?? ""),
      { content: result.content, text: result.screen?.text?.slice(0, 300) },
    );

    const fetching = idOf(text, "Fetch slowly");
    const fetched = await timed("click", { control: fetching ?? "b0" });
    check("a click whose fetch takes a moment is read once the answer is in", /Fetched: slow answer/.test(fetched.result.screen?.text ?? ""), { ms: fetched.ms, text: fetched.result.screen?.text?.slice(0, 200) });

    const spa = idOf(text, "Go to About (SPA)");
    result = await tool("click", { control: spa ?? "b0" });
    check(
      "a route change is read once the route has rendered, and noted as in place",
      /About route loaded/.test(result.screen?.text ?? "") && /The address changed to .*route=about .*updated in place/.test(result.content),
      result.content,
    );

    const slow = idOf(text, "Search slowly");
    result = await tool("act", { actions: [{ click: slow ?? "b0" }, { wait: { text: "Results: 3" } }] });
    check("act's wait step holds for results that take a moment", /Did 2 steps/.test(result.content) && /Results: 3 items found/.test(result.screen?.text ?? ""), result.content);

    result = await tool("act", { actions: [{ click: idOf(text, "Second page") ?? "b0" }, { click: "b999" }] });
    check(
      "an act stopped after a navigation says which step, that the page changed, and shows the new page",
      /Did 1 step of 2/.test(result.content) && /Stopped at step 2 .*\(the page changed after an earlier step\)/.test(result.content) && /Second page/.test(result.screen?.windowTitle ?? ""),
      result.content,
    );

    console.error("step: an endless feed");
    let loadedLater = false;
    let atEnd = false;
    let scrolls = 0;
    for (; scrolls < 14 && !atEnd; scrolls++) {
      result = await tool("scroll", { direction: "down" });
      if (/loaded later/.test(result.screen?.text ?? "")) loadedLater = true;
      atEnd = Boolean(result.screen?.atEnd);
    }
    check("scrolling an endless feed reads what loads on the way, then reaches its end", loadedLater && atEnd && scrolls >= 6, { scrolls, loadedLater, atEnd });

    console.error("step: a page that never finishes loading (about 8 s)");
    const hanging = await timed("open_url", { url: `${server.origin}/hang.html` });
    check(
      "a page that never fires load is read anyway, marked still loading",
      /Hanging page/.test(hanging.result.screen?.text ?? "") && hanging.result.screen?.loading === true && /still loading/.test(hanging.result.content) && hanging.ms < 12_000,
      { ms: hanging.ms, content: hanging.result.content },
    );
    kikiBrowser().endTurn();
  } catch (error) {
    checks.push({ name: "harness", ok: false, detail: String(error instanceof Error ? error.stack ?? error.message : error) });
  } finally {
    server.close();
  }
  const failed = checks.filter((item) => !item.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
  return failed.length === 0 ? 0 : 1;
}
