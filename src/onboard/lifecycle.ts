// `paths` / `reset` / `uninstall`. Non-destructive by default: reset keeps audit,
// --all backs up first; uninstall never touches the governed target's .git/audit.
import * as fs from "node:fs";
import * as path from "node:path";
import { paths, loadConfigSafe, readVersion, expandHome } from "../util.ts";
import { liveDaemonPid } from "../core/daemon.ts";
import { backupHome } from "./migrate.ts";
import { removeAutostart } from "./autostart.ts";

// `paths`: live view of the 04.3 product inventory.
export function printPaths(homeArg: string): string[] {
  const home = expandHome(homeArg);
  const p = paths(home);
  const rows: Array<[string, string, string]> = [
    ["config", p.config, "config"],
    ["VERSION", p.version, "config"],
    ["ledger/tickets.jsonl", p.tickets, "audit ★"],
    ["ledger/held/", p.held, "audit"],
    ["reports/audit/", p.reports, "audit"],
    ["state/events/inbox.jsonl", p.inbox, "state"],
    ["state/events/processed/", p.processed, "state"],
    ["state/provenance.json", p.provenance, "state"],
    ["state/heatmap.json", p.heatmap, "state"],
    ["state/daemon.lock", p.lock, "state"],
    ["logs/", p.logs, "logs"],
    ["cache/", p.cache, "cache"],
  ];
  const out: string[] = [`OrganLedger paths — ${home}`, ""];
  for (const [label, abs, cls] of rows) {
    out.push(`  [${cls.padEnd(8)}] ${exists(abs) ? "✓" : "·"} ${label}  →  ${abs}`);
  }
  const cfg = loadConfigSafe(home);
  if (cfg) {
    out.push("", "  targets (audit lives inside each):");
    for (const t of cfg.targets) {
      out.push(`    ${t.system}: ${t.home}/.git , ${t.home}/logs/organ-audit.jsonl`);
    }
  }
  out.push("", "  Backup essentials: ledger/ + config.json + VERSION (rest is recomputable).");
  return out;
}

export interface ResetOptions {
  all?: boolean;
  confirm?: boolean;
}

// reset --keep-audit (default): clear state/ logs/ cache/, keep ledger/ config.
// reset --all --confirm: back up whole home, then clear everything.
export function runReset(homeArg: string, opts: ResetOptions): string[] {
  const home = expandHome(homeArg);
  const p = paths(home);
  const out: string[] = [];

  if (liveDaemonPid(p.lock)) {
    return ["a daemon is running — stop it before reset (it owns state/logs)."];
  }

  if (opts.all) {
    if (!opts.confirm) {
      return [
        "reset --all is destructive (removes ledger/ audit too).",
        "Re-run with --confirm. A full backup is taken first.",
      ];
    }
    const bak = backupHome(home);
    out.push(`backed up → ${bak}`);
    for (const name of ["ledger", "reports", "state", "logs", "cache"]) {
      rmDir(path.join(home, name));
    }
    rmFile(p.config);
    rmFile(p.version);
    out.push("reset --all: removed config, ledger, reports, state, logs, cache (backup kept).");
    return out;
  }

  // default: keep audit
  for (const dir of [p.state, p.logs, p.cache]) rmDir(dir);
  fs.mkdirSync(p.processed, { recursive: true });
  fs.mkdirSync(p.logs, { recursive: true });
  fs.mkdirSync(p.cache, { recursive: true });
  out.push("reset --keep-audit: cleared state/, logs/, cache/.");
  out.push("kept: ledger/ (hash chain), config.json, VERSION.");
  return out;
}

// uninstall: stop-guidance + remove autostart. NEVER touches the target's .git/audit.
export function runUninstall(homeArg: string): string[] {
  const home = expandHome(homeArg);
  const p = paths(home);
  const out: string[] = ["OrganLedger uninstall"];
  const pid = liveDaemonPid(p.lock);
  if (pid) out.push(`  ⚠ daemon running (pid ${pid}) — stop it first (Ctrl-C or Stop-Process).`);
  else out.push("  daemon not running.");
  out.push(...removeAutostart().map((l) => "  " + l));
  const cfg = loadConfigSafe(home);
  out.push("  Governed data is LEFT IN PLACE (your decision):");
  out.push(`    - ${home} (ledger/config/logs) — delete manually if you want it gone`);
  if (cfg) for (const t of cfg.targets) out.push(`    - ${t.home}/.git & /logs/organ-audit.jsonl — audit trail inside your target, untouched`);
  out.push("  OrganLedger removes only its autostart hook; nothing in your OpenClaw/Hermes is deleted.");
  return out;
}

function exists(p: string): boolean {
  return fs.existsSync(p);
}
function rmDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
function rmFile(f: string): void {
  try {
    fs.rmSync(f, { force: true });
  } catch {
    /* ignore */
  }
}
