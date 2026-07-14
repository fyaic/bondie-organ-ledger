#!/usr/bin/env node
// organledger CLI. Minimal argv parsing (no heavy deps).
//   init | doctor | paths | reset | uninstall
//   daemon | once | report | rollback | approve | reject | verify-ledger | status
import { spawn } from "node:child_process";

import { loadConfigSafe, ensureDirs, defaultLedgerHome, paths, isInitialized } from "../util.ts";
import { Daemon, liveDaemonPid } from "../core/daemon.ts";
import { OpenClawWatcher } from "../adapters/openclaw/watcher.ts";
import { buildReport } from "./report.ts";
import { rollback } from "./rollback.ts";
import { approve, reject } from "./approve.ts";
import { Ledger } from "../core/ledger.ts";
import { runInit } from "../onboard/init.ts";
import { backfillFromGitHistory } from "../onboard/backfill.ts";
import { runDoctor } from "../onboard/doctor.ts";
import { printPaths, runReset, runUninstall } from "../onboard/lifecycle.ts";
import { installAutostart } from "../onboard/autostart.ts";
import { startDashboardServer } from "../dashboard/server.ts";
import type { Config } from "../types.ts";

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const f: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        f[key] = next;
        i++;
      } else {
        f[key] = true;
      }
    }
  }
  return f;
}

const S = (v: string | boolean | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;

function openDashboard(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const home = S(flags["home"]) || defaultLedgerHome();

  // ---- commands that do NOT require an existing config ----
  switch (cmd) {
    case "dashboard": {
      const port = Number(S(flags["port"]) || "7377") || 7377;
      const theme = S(flags["theme"]) === "dark" ? "dark" : "light";
      await startDashboardServer({ port, theme, ledgerHome: home });
      if (flags["open"]) openDashboard(`http://localhost:${port}`);
      return;
    }
    case "init": {
      const res = runInit({
        home,
        yes: !!flags["yes"],
        openclaw: S(flags["openclaw"]),
        hermes: S(flags["hermes"]),
        noSnapshot: !!flags["no-snapshot"],
        noBackfill: !!flags["no-backfill"],
        fullHistory: !!flags["full-history"],
      });
      res.lines.forEach((l) => console.log(l));
      if (flags["yes"] && !flags["no-autostart"]) {
        // in --yes mode, do not surprise-install autostart; only if explicitly asked
      }
      if (flags["autostart"]) installAutostart(S(flags["home"])).forEach((l) => console.log("  " + l));
      return;
    }
    case "doctor": {
      const r = runDoctor(home);
      r.lines.forEach((l) => console.log(l));
      process.exit(r.healthy ? 0 : 1);
    }
    case "paths":
      printPaths(home).forEach((l) => console.log(l));
      return;
    case "reset":
      runReset(home, { all: !!flags["all"], confirm: !!flags["confirm"] }).forEach((l) => console.log(l));
      return;
    case "uninstall":
      runUninstall(home).forEach((l) => console.log(l));
      return;
    case "autostart":
      installAutostart(S(flags["home"])).forEach((l) => console.log(l));
      return;
    case undefined:
    case "help":
    case "--help":
      return printHelp(home);
  }

  // ---- commands that require a config ----
  const cfg = loadConfigSafe(home);
  if (!cfg) {
    console.error("未初始化 —— 先运行 'organledger init'  (not initialized — run 'organledger init')");
    process.exit(1);
  }
  ensureDirs(cfg.ledger_home);

  switch (cmd) {
    case "daemon":
      return runDaemon(cfg);
    case "once":
      return runOnce(cfg);
    case "report": {
      const { outPath, md } = buildReport(cfg, S(flags["date"]) || "today");
      console.log(md);
      console.log(`\n[written] ${outPath}`);
      return;
    }
    case "rollback": {
      if (guardSingleWriter(cfg)) return;
      const out = rollback(cfg, {
        change: S(flags["change"]),
        session: S(flags["session"]),
        before: S(flags["before"]),
        confirm: !!flags["confirm"],
      });
      out.forEach((l) => console.log(l));
      return;
    }
    case "approve":
      if (guardSingleWriter(cfg)) return;
      approve(cfg, rest[0]).forEach((l) => console.log(l));
      return;
    case "reject":
      if (guardSingleWriter(cfg)) return;
      reject(cfg, rest[0]).forEach((l) => console.log(l));
      return;
    case "backfill": {
      if (guardSingleWriter(cfg)) return;
      const ledger = new Ledger(cfg.ledger_home);
      const before = ledger.all().length;
      const fullHistory = !!flags["full-history"];
      const sinceDays = Number(S(flags["since-days"]) || "90") || 90;
      for (const t of cfg.targets) {
        if (!t.git) {
          console.log(`  ${t.system}: not a git repo — nothing to backfill`);
          continue;
        }
        const r = backfillFromGitHistory(t, ledger, cfg, { fullHistory, sinceDays });
        const span = r.earliest && r.latest ? `  [${r.earliest.slice(0, 10)} → ${r.latest.slice(0, 10)}]` : "";
        console.log(`  ${t.system}: ${r.note}${span}`);
      }
      const v = new Ledger(cfg.ledger_home).verify();
      console.log(`  tickets ${before} → ${ledger.all().length}; chain: ${v.ok ? "intact ✓" : "BROKEN@" + v.brokenIndex}`);
      process.exit(v.ok ? 0 : 1);
    }
    case "verify-ledger": {
      const v = new Ledger(cfg.ledger_home).verify();
      console.log(v.ok ? `OK: ${v.detail}` : `TAMPER: ${v.detail}`);
      process.exit(v.ok ? 0 : 1);
    }
    case "status": {
      const l = new Ledger(cfg.ledger_home);
      console.log(`ledger_home: ${cfg.ledger_home}`);
      console.log(`tickets: ${l.all().length}`);
      console.log(`targets: ${cfg.targets.map((t) => `${t.system}@${t.home}`).join(", ")}`);
      const v = l.verify();
      console.log(`chain: ${v.ok ? "intact" : "BROKEN@" + v.brokenIndex}`);
      return;
    }
    default:
      printHelp(home);
  }
}

function printHelp(home: string): void {
  const uninit = !isInitialized(home);
  const lines = [
    "organledger — Agent organ governance (Phase 1.5)",
    "",
  ];
  if (uninit) lines.push("未初始化 —— 先运行 'organledger init'   (not initialized — run 'organledger init')", "");
  lines.push(
    "  init [--yes] [--openclaw <p>] [--hermes <p>] [--home <p>] [--no-snapshot] [--no-backfill] [--full-history] [--autostart]",
    "  backfill [--full-history] [--since-days N]   replay target git history into the ledger (idempotent)",
    "  doctor                     health report (env/paths/config/audit/runtime/capacity)",
    "  paths                      show where every artifact lives",
    "  reset [--keep-audit(default) | --all --confirm]",
    "  uninstall                  stop guidance + remove autostart (keeps your data)",
    "  autostart                  install login autostart (Windows Scheduled Task)",
    "  dashboard [--port 7377] [--theme light|dark] [--open]",
    "",
    "  daemon                     start consumer + OpenClaw watcher (single instance)",
    "  once                       drain inbox + flush commits, then exit",
    "  report [--date today|YYYY-MM-DD]",
    "  rollback --change <id> | --session <id> | --before <ts> [--confirm]",
    "  approve <change_id> | reject <change_id>",
    "  verify-ledger              validate hash chain",
    "  status                     quick summary"
  );
  lines.forEach((l) => console.log(l));
}

// enforce the single-writer invariant for ledger/git-mutating commands.
function guardSingleWriter(cfg: Config): boolean {
  const pid = liveDaemonPid(paths(cfg.ledger_home).lock);
  if (pid) {
    console.error(
      `[organledger] a daemon (pid ${pid}) is running and is the single ledger/git writer.\n` +
        `Stop it before approve/reject/rollback (Ctrl-C the daemon), then retry.\n` +
        `This prevents concurrent writers from corrupting the hash chain.`
    );
    return true;
  }
  return false;
}

async function runDaemon(cfg: Config): Promise<void> {
  const d = new Daemon(cfg);
  if (!d.acquireLock()) {
    console.error("[organledger] another daemon holds the lock — exiting (single committer).");
    process.exit(1);
  }
  d.log.info("daemon", `up. ledger_home=${cfg.ledger_home} targets=${cfg.targets.map((t) => t.system).join(",")}`);

  const watchers: OpenClawWatcher[] = [];
  for (const target of cfg.targets) {
    if (target.system === "openclaw" && target.git) {
      const w = new OpenClawWatcher(cfg, target, d.log);
      w.start();
      watchers.push(w);
      d.log.info("watcher", `watching ${target.home} [${target.watch.join(", ")}]`);
    }
  }
  d.start(200);

  const shutdown = async () => {
    d.log.info("daemon", "shutting down…");
    for (const w of watchers) await w.stop();
    await d.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runOnce(cfg: Config): Promise<void> {
  const d = new Daemon(cfg);
  if (!d.acquireLock()) {
    console.error("[organledger] daemon lock held; run once needs exclusive access.");
    process.exit(1);
  }
  const n = await d.drainOnce();
  await d.committer.flushNow();
  d.releaseLock();
  d.log.info("once", `processed ${n} event(s).`);
}

main().catch((e) => {
  console.error("[organledger] fatal:", e);
  process.exit(1);
});
