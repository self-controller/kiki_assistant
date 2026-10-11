// Runs this Kiki server in the background as a systemd user service, so it starts at login and restarts
// if it crashes. Linux only.
//
//   npm run service -w server -- install     # write the unit, then enable and start it
//   npm run service -w server -- uninstall   # stop, disable and remove it
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const UNIT = "kiki-server.service";
const serverDir = resolve(import.meta.dirname, "..");
const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const unitFile = join(configHome, "systemd", "user", UNIT);

function systemctl(...args: string[]): void {
  execFileSync("systemctl", ["--user", ...args], { stdio: "inherit" });
}

/** systemd splits ExecStart on spaces, so quote each argument. */
function quote(arg: string): string {
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function install(): void {
  const unit = [
    "[Unit]",
    "Description=Kiki server",
    "",
    "[Service]",
    "Type=simple",
    // The server reads .env and the database path relative to its own folder.
    `WorkingDirectory=${serverDir}`,
    `ExecStart=${[process.execPath, "--disable-warning=ExperimentalWarning", "src/index.ts"].map(quote).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  mkdirSync(join(unitFile, ".."), { recursive: true });
  writeFileSync(unitFile, unit);
  systemctl("daemon-reload");
  systemctl("enable", "--now", UNIT);
  console.log(`Kiki server runs in the background now and starts when you log in (${unitFile}).`);
  console.log(`Logs: journalctl --user -u ${UNIT} -f`);
}

function uninstall(): void {
  try {
    systemctl("disable", "--now", UNIT);
  } catch {
    // Not installed or already stopped.
  }
  rmSync(unitFile, { force: true });
  systemctl("daemon-reload");
  console.log("Removed the Kiki server service.");
}

if (process.platform !== "linux") {
  console.error("The background service uses systemd, so it's Linux only. Elsewhere, run `npm start -w server`.");
  process.exit(1);
}
const command = process.argv[2];
if (command === "install") install();
else if (command === "uninstall") uninstall();
else {
  console.error("Usage: npm run service -w server -- install | uninstall");
  process.exit(1);
}
