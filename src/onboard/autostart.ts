// Autostart on login. Windows: Scheduled Task (schtasks). mac/Linux: emit a
// launchd/systemd template (⏳ not machine-verified this phase). No dependencies.
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const TASK_NAME = "OrganLedgerDaemon";

function cliEntry(): string {
  // absolute path to src/cli/index.ts (works from a `node ... index.ts` install)
  return path.resolve(process.argv[1] || "src/cli/index.ts");
}

export function isAutostartInstalled(): boolean {
  if (process.platform !== "win32") return false;
  try {
    execFileSync("schtasks", ["/query", "/tn", TASK_NAME], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function installAutostart(homeFlag?: string): string[] {
  if (process.platform !== "win32") {
    return emitUnixTemplate();
  }
  const node = process.execPath;
  const entry = cliEntry();
  const homeArg = homeFlag ? ` --home "${homeFlag}"` : "";
  const tr = `"${node}" "${entry}" daemon${homeArg}`;
  try {
    execFileSync(
      "schtasks",
      ["/create", "/tn", TASK_NAME, "/tr", tr, "/sc", "onlogon", "/rl", "limited", "/f"],
      { stdio: "pipe" }
    );
    return [`autostart installed: Scheduled Task "${TASK_NAME}" runs on logon`, `  → ${tr}`];
  } catch (e) {
    return [`autostart install failed (${(e as Error).message.split("\n")[0]})`, ...manualWindowsSteps(tr)];
  }
}

export function removeAutostart(): string[] {
  if (process.platform !== "win32") return ["autostart removal: remove the launchd/systemd unit you installed (see docs)."];
  try {
    execFileSync("schtasks", ["/delete", "/tn", TASK_NAME, "/f"], { stdio: "pipe" });
    return [`autostart removed: Scheduled Task "${TASK_NAME}" deleted`];
  } catch {
    return [`autostart task "${TASK_NAME}" not present (nothing to remove)`];
  }
}

function manualWindowsSteps(tr: string): string[] {
  return [
    "  manual step (run in an elevated shell if needed):",
    `  schtasks /create /tn ${TASK_NAME} /tr ${tr} /sc onlogon /f`,
  ];
}

// mac/Linux: write a ready-to-use template next to the repo; do not activate.
function emitUnixTemplate(): string[] {
  const node = process.execPath;
  const entry = cliEntry();
  const outDir = path.join(path.dirname(entry), "..", "..", "scripts");
  fs.mkdirSync(outDir, { recursive: true });
  if (process.platform === "darwin") {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.organledger.daemon</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${entry}</string><string>daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>\n`;
    const f = path.join(outDir, "com.organledger.daemon.plist");
    fs.writeFileSync(f, plist);
    return [`macOS template written: ${f}`, `  install: cp to ~/Library/LaunchAgents/ && launchctl load <it> (⏳ not verified this phase)`];
  }
  const unit = `[Unit]
Description=OrganLedger daemon
[Service]
ExecStart=${node} ${entry} daemon
Restart=always
[Install]
WantedBy=default.target\n`;
  const f = path.join(outDir, "organledger.service");
  fs.writeFileSync(f, unit);
  return [`Linux template written: ${f}`, `  install: cp to ~/.config/systemd/user/ && systemctl --user enable --now organledger (⏳ not verified this phase)`];
}
