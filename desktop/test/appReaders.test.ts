import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Exec } from "../src/main/apps/families.ts";
import { kittySocket, parseKittyConfig, readKitty, type KittyDeps } from "../src/main/apps/handlers/kitty.ts";
import { readWezterm } from "../src/main/apps/handlers/wezterm.ts";
import { readApp } from "../src/main/apps/registry.ts";
import { nameSuffix } from "../src/main/apps/titles.ts";
import type { AppHandler, ReadContext } from "../src/main/apps/types.ts";
import { isSecretPath, readVscodeFile, titlePaths } from "../src/main/apps/vscodeFile.ts";

const context = (overrides: Partial<ReadContext> = {}): ReadContext => ({
  identity: {},
  selection: "",
  signal: new AbortController().signal,
  ...overrides,
});

/** A fake program: records each call and answers from `reply`. */
function fakeExec(reply: (file: string, args: string[]) => string | Error) {
  const calls: { file: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const exec: Exec = async (file, args, { env }) => {
    calls.push({ file, args, env });
    const out = reply(file, args);
    if (out instanceof Error) throw out;
    return out;
  };
  return { exec, calls };
}

afterEach(() => vi.unstubAllEnvs());

describe("readApp", () => {
  const handler = (read: AppHandler["read"]): AppHandler => ({ id: "test", name: "Test", kind: "terminal", match: {}, read });

  it("gives up on a reader that's too slow, and tells it to stop", async () => {
    let signal: AbortSignal | undefined;
    const slow = handler((ctx) => {
      signal = ctx.signal;
      return new Promise(() => {});
    });
    await expect(readApp(slow, { identity: {}, selection: "" }, 20)).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
  });

  it("leaves a reader that fails to the generic result", async () => {
    const broken = handler(async () => {
      throw new Error("no such program");
    });
    await expect(readApp(broken, { identity: {}, selection: "" })).resolves.toBeUndefined();
  });

  it("does nothing for apps without a reader", async () => {
    await expect(readApp({ id: "x", name: "X", kind: "browser", match: {} }, { identity: {}, selection: "" })).resolves.toBeUndefined();
  });
});

describe("WezTerm", () => {
  it("reads the focused pane with its CLI, not the pane Kiki was started from", async () => {
    vi.stubEnv("WEZTERM_PANE", "3");
    const { exec, calls } = fakeExec(() => "$ cargo build\nerror[E0425]: cannot find value `x`\n$ \n");
    const extras = await readWezterm(context({ selection: "cannot find value" }), exec);
    expect(calls[0]).toMatchObject({ file: "wezterm", args: ["cli", "get-text", "--start-line", "-80"] });
    expect(calls[0]!.env).not.toHaveProperty("WEZTERM_PANE");
    expect(extras?.vicinity).toEqual({
      kind: "terminal",
      before: "$ cargo build\nerror[E0425]: ",
      anchor: "cannot find value",
      after: " `x`\n$ \n",
    });
  });

  it("asks the flatpak's own CLI", async () => {
    const { exec, calls } = fakeExec(() => "$ ");
    await readWezterm(context({ identity: { sandboxedId: "org.wezfurlong.wezterm" } }), exec);
    expect(calls[0]!.file).toBe("flatpak");
    expect(calls[0]!.args.slice(0, 5)).toEqual(["run", "--command=wezterm", "org.wezfurlong.wezterm", "cli", "get-text"]);
  });

  it("has nothing for an empty screen, or a missing CLI", async () => {
    await expect(readWezterm(context(), fakeExec(() => "\n\n").exec)).resolves.toBeUndefined();
    await expect(readWezterm(context(), fakeExec(() => new Error("ENOENT")).exec)).rejects.toThrow("ENOENT");
  });
});

describe("kitty", () => {
  const deps = (config: string, reply: (args: string[]) => string | Error) => {
    const fake = fakeExec((_file, args) => reply(args));
    const value: KittyDeps = { exec: fake.exec, readConfig: async () => config, program: async () => "/opt/kitty/bin/kitty" };
    return { deps: value, calls: fake.calls };
  };
  const ON = "allow_remote_control yes\nlisten_on unix:/tmp/kitty\n";
  const reply = (args: string[]) => (args.includes("selection") ? "make\n" : "$ make\nmake: *** No targets.\n$ ");

  it("reads the active window's screen and what's highlighted in it, over its socket", async () => {
    const { deps: d, calls } = deps(ON, reply);
    const extras = await readKitty(context({ identity: { pid: 42 }, selection: "stale" }), d);
    expect(calls.map((call) => call.args)).toEqual([
      ["@", "--to", "unix:/tmp/kitty-42", "get-text", "--extent", "screen"],
      ["@", "--to", "unix:/tmp/kitty-42", "get-text", "--extent", "selection"],
    ]);
    expect(calls[0]!.file).toBe("/opt/kitty/bin/kitty");
    expect(extras).toEqual({
      selection: "make",
      vicinity: { kind: "terminal", before: "$ make\n", anchor: "make", after: ": *** No targets.\n$ " },
    });
  });

  it("says nothing is highlighted when kitty says so", async () => {
    const { deps: d } = deps(ON, (args) => (args.includes("selection") ? "" : "$ ls\n"));
    expect(await readKitty(context({ identity: { pid: 42 }, selection: "stale" }), d)).toMatchObject({ selection: "" });
  });

  it("goes on without the selection when only that fails", async () => {
    const { deps: d } = deps(ON, (args) => (args.includes("selection") ? new Error("no") : "$ ls\n"));
    const extras = await readKitty(context({ identity: { pid: 42 } }), d);
    expect(extras).not.toHaveProperty("selection");
    expect(extras?.vicinity?.before).toBe("$ ls\n");
  });

  it("asks nothing unless remote control is on without a prompt, and kitty listens", async () => {
    for (const config of ["", "allow_remote_control ask\nlisten_on unix:/tmp/k", "allow_remote_control yes", "allow_remote_control no\nlisten_on unix:/tmp/k"]) {
      const { deps: d, calls } = deps(config, reply);
      expect(await readKitty(context({ identity: { pid: 42 } }), d), config).toBeUndefined();
      expect(calls).toEqual([]);
    }
    const { deps: d, calls } = deps(ON, reply);
    expect(await readKitty(context(), d)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("reads kitty.conf like kitty: comments skipped, later lines win", () => {
    const config = parseKittyConfig("# allow_remote_control yes\nallow_remote_control no\n  allow_remote_control socket-only  \n");
    expect(config.get("allow_remote_control")).toBe("socket-only");
  });

  it("finds kitty's socket", () => {
    expect(kittySocket("unix:/tmp/kitty", 42)).toBe("unix:/tmp/kitty-42");
    expect(kittySocket("unix:@kitty-{kitty_pid}", 42)).toBe("unix:@kitty-42");
    expect(kittySocket("unix:${XDG_RUNTIME_DIR}/kitty", 42, { XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("unix:/run/user/1000/kitty-42");
    expect(kittySocket("unix:~/kitty.sock", 42)).toBe(`unix:${homedir()}/kitty.sock-42`);
    expect(kittySocket("tcp:localhost:5000", 42)).toBe("tcp:localhost:5000");
    expect(kittySocket("none", 42)).toBeUndefined();
    expect(kittySocket(undefined, 42)).toBeUndefined();
  });
});

describe("VS Code's file", () => {
  const suffixes = ["Visual Studio Code"].map(nameSuffix);
  const dir = mkdtempSync(join(tmpdir(), "kiki-vscode-"));
  const file = (name: string, text: string | Buffer) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  const lines = Array.from({ length: 200 }, (_, i) => `const line${i} = ${i};`).join("\n");
  const main = file("main.ts", lines);
  const read = (title: string, selection: string) => readVscodeFile(context({ windowTitle: title, selection }), suffixes);

  it("reads the lines around the highlight, when the title has the file's full path", async () => {
    const extras = await read(`${main} - kiki - Visual Studio Code`, "line120 = 120");
    expect(extras?.vicinity).toMatchObject({ kind: "editor", anchor: "line120 = 120" });
    expect(extras?.vicinity?.before.endsWith("const line119 = 119;\nconst ")).toBe(true);
    expect(extras?.vicinity?.after.startsWith(";\nconst line121")).toBe(true);
  });

  it("finds a file whose path has the title's separator in it, and one with Windows line ends", async () => {
    const odd = file("draft - v2.ts", "let a = 1;\r\nlet b = 2;\r\n");
    expect((await read(`${odd} - kiki - Visual Studio Code`, "let b = 2;"))?.vicinity?.before).toBe("let a = 1;\n");
  });

  it("reads nothing it can't be sure is what's on screen", async () => {
    // Unsaved, VS Code's usual title (no path), nothing highlighted, not in the file, or in it twice.
    expect(await read(`● ${main} - kiki - Visual Studio Code`, "line120 = 120")).toBeUndefined();
    expect(await read("main.ts - kiki - Visual Studio Code", "line120 = 120")).toBeUndefined();
    expect(await read(`${main} - kiki - Visual Studio Code`, "   ")).toBeUndefined();
    expect(await read(`${main} - kiki - Visual Studio Code`, "not in the file")).toBeUndefined();
    expect(await read(`${main} - kiki - Visual Studio Code`, "const")).toBeUndefined();
    expect(await read(`${join(dir, "gone.ts")} - kiki - Visual Studio Code`, "x")).toBeUndefined();
  });

  it("never reads secrets, big files or binaries", async () => {
    const env = file(".env", "API_KEY=abc\nOTHER=1\n");
    expect(await read(`${env} - kiki - Visual Studio Code`, "OTHER=1")).toBeUndefined();
    const big = file("big.txt", "x".repeat(1_100_000) + "needle");
    expect(await read(`${big} - kiki - Visual Studio Code`, "needle")).toBeUndefined();
    const binary = file("blob.bin", Buffer.from("abc\u0000needle"));
    expect(await read(`${binary} - kiki - Visual Studio Code`, "needle")).toBeUndefined();
    expect(isSecretPath("/home/me/.ssh/config")).toBe(true);
    expect(isSecretPath("/home/me/certs/server.pem")).toBe(true);
    expect(isSecretPath("/home/me/.env.local")).toBe(true);
    expect(isSecretPath("/home/me/id_ed25519")).toBe(true);
    expect(isSecretPath("/home/me/src/environment.ts")).toBe(false);
  });

  it("takes paths from the title, longest first", () => {
    expect(titlePaths("~/a - b.ts - kiki - Visual Studio Code", suffixes)).toEqual([
      join(homedir(), "a - b.ts - kiki"),
      join(homedir(), "a - b.ts"),
      join(homedir(), "a"),
    ]);
    expect(titlePaths("relative.ts - kiki - Visual Studio Code", suffixes)).toEqual([]);
  });
});
