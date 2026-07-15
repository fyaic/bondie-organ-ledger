#!/usr/bin/env node
// organledger CLI. Minimal argv parsing (no heavy deps).
//   init | doctor | paths | reset | uninstall
//   daemon | once | report | rollback | approve | reject | verify-ledger | status
import { spawn } from "node:child_process";
import * as fs from "node:fs";

import { loadConfigSafe, ensureDirs, defaultLedgerHome, paths, isInitialized } from "../util.ts";
import { Daemon, liveDaemonPid } from "../core/daemon.ts";
import { OpenClawWatcher } from "../adapters/openclaw/watcher.ts";
import { buildReport } from "./report.ts";
import { rollback } from "./rollback.ts";
import { approve, reject } from "./approve.ts";
import { Ledger } from "../core/ledger.ts";
import { runInit } from "../onboard/init.ts";
import { backfillFromGitHistory, backfillReflog } from "../onboard/backfill.ts";
import { runDoctor } from "../onboard/doctor.ts";
import { buildProvenanceReport, writeProvenanceReport, formatProvenanceTable } from "../onboard/provenance.ts";
import { buildHeatmap, writeHeatmapReport, formatHeatmapSummary } from "../onboard/heatmap.ts";
import { printPaths, runReset, runUninstall } from "../onboard/lifecycle.ts";
import { installAutostart } from "../onboard/autostart.ts";
import { startDashboardServer } from "../dashboard/server.ts";
import { buildAttributionStats } from "../dashboard/data.ts";
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

// Synchronous y/N prompt on the controlling TTY. Non-interactive stdin (piped /
// CI) returns false so init never blocks — the caller then prints guidance to
// use --yes. Kept sync so runInit stays a straight-line function.
function promptYesNo(question: string): boolean {
  if (!process.stdin.isTTY) return false;
  process.stdout.write(question);
  const buf = Buffer.alloc(64);
  let bytes = 0;
  try {
    bytes = fs.readSync(0, buf, 0, buf.length, null);
  } catch {
    return false;
  }
  const ans = buf.toString("utf8", 0, bytes).trim().toLowerCase();
  return ans === "y" || ans === "yes";
}

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
      // interactive only when the user neither pre-approved (--yes) nor opted out
      // (--no-snapshot): then ask before writing a commit into the target repo.
      const interactive = !flags["yes"] && !flags["no-snapshot"];
      runInit({
        home,
        yes: !!flags["yes"],
        openclaw: S(flags["openclaw"]),
        hermes: S(flags["hermes"]),
        noSnapshot: !!flags["no-snapshot"],
        noBackfill: !!flags["no-backfill"],
        fullHistory: !!flags["full-history"],
        emit: (l) => console.log(l),
        confirmSnapshot: interactive
          ? () => promptYesNo("\n  建立首扫水位快照？将向目标 repo 写入 1 条 scoped commit。(y/N) ")
          : undefined,
      });
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
        if (flags["reflog"]) {
          const rl = backfillReflog(t, ledger, cfg, { includeNonUpstream: !!flags["include-non-upstream"] });
          console.log(`  ${t.system} [reflog]: ${rl.note}`);
        }
      }
      const v = new Ledger(cfg.ledger_home).verify();
      console.log(`  tickets ${before} → ${ledger.all().length}; chain: ${v.ok ? "intact ✓" : "BROKEN@" + v.brokenIndex}`);
      process.exit(v.ok ? 0 : 1);
    }
    case "provenance": {
      // READ-ONLY: scans each target's GitSources and writes state/provenance.json
      // for the dashboard. Safe to run while the daemon is up (no ledger writes,
      // no guardSingleWriter). --fetch is the only networked path (fetch-only).
      const fetch = !!flags["fetch"];
      const report = buildProvenanceReport(cfg, { fetch });
      if (flags["json"]) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        const nSources = report.targets.reduce((n, g) => n + g.sources.length, 0);
        console.log(`OrganLedger provenance — ${nSources} source(s)${fetch ? " (fetched)" : " (offline, ahead/behind as of last fetch)"}`);
        formatProvenanceTable(report).forEach((l) => console.log(l));
      }
      const out = writeProvenanceReport(cfg.ledger_home, report);
      if (!flags["json"]) console.log(`\n[written] ${out}`);
      return;
    }
    case "heatmap": {
      // READ-ONLY file-tree heatmap: derives change frequency from the ledger and
      // reads target DIRECTORY ENTRIES (names/types only) — never file contents.
      // Writes state/heatmap.json for the dashboard's file-tree view. Safe while
      // the daemon is up (no ledger writes, no guardSingleWriter).
      //   default        full organ tree (excludes node_modules/.git/… + config.ignore)
      //   --changed-only  only paths that actually changed (1.7's old default)
      //   --redact[=glob] hide sensitive names (off by default; local nav needs real names)
      //   --full-tree     accepted for back-compat (full tree is now the default)
      const window = S(flags["window"]) || "all";
      const changedOnly = !!flags["changed-only"];
      const redactOn = !!flags["redact"];
      const redactFlag = S(flags["redact"]);
      const redact = redactFlag ? redactFlag.split(",").map((g) => g.trim()).filter(Boolean) : [];
      const report = buildHeatmap(cfg, { window, changedOnly, redactOn, redact });
      if (flags["json"]) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`OrganLedger ${formatHeatmapSummary(report)}`);
        if (report.limits.truncated) {
          console.log(`  ⚠ 已折叠/截断部分节点（node_modules/.git 已排除，超限目录折叠）——见 heatmap.json truncated 标记。`);
        }
      }
      const out = writeHeatmapReport(cfg.ledger_home, report);
      if (!flags["json"]) console.log(`\n[written] ${out}`);
      return;
    }
    case "attribution": {
      // Honest distribution over the principal (who-caused-it) axis. Un-attributed
      // tickets count as unknown — NO silent gaps. `verified` here means only
      // "im-user + platform-attested" (channel-authenticated + runtime self-report,
      // NOT cryptographic proof); local is always unverified by design.
      const date = (flags["date"] as string) || "all";
      const stats = buildAttributionStats(cfg.ledger_home, { date });
      if (flags["json"]) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }
      const pct = (n: number) => (stats.total ? `${((n / stats.total) * 100).toFixed(1)}%` : "0%");
      console.log(`attribution stats (date=${stats.date}) — ${stats.total} ticket(s)`);
      console.log(`  主使 principal:`);
      console.log(`    👤 IM 用户请求 im-user   : ${stats.byKind["im-user"]} (${pct(stats.byKind["im-user"])})`);
      console.log(`    🤖 agent 自主 autonomous : ${stats.byKind.autonomous} (${pct(stats.byKind.autonomous)})`);
      console.log(`    🖥 本机 local(未验证)     : ${stats.byKind.local} (${pct(stats.byKind.local)})`);
      console.log(`    ❔ 未知 unknown(未插桩)   : ${stats.byKind.unknown} (${pct(stats.byKind.unknown)})   ← no silent gaps`);
      const channels = Object.keys(stats.byChannel);
      if (channels.length) console.log(`  渠道 channel: ${channels.map((c) => `${c}=${stats.byChannel[c]}`).join(", ")}`);
      console.log(`  关联强度 match: ${Object.keys(stats.byMatch).map((m) => `${m}=${stats.byMatch[m]}`).join(", ")}`);
      console.log(`  ✅ 已认证主使 verified(=im-user+platform-attested,非密码学证明): ${stats.verifiedAttested} (${pct(stats.verifiedAttested)})`);
      console.log(`  📩 autonomy=requested(据本轮请求·忠实性未证): ${stats.requested}`);
      return;
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
    "  backfill [--full-history] [--since-days N] [--reflog]   replay target git history (all GitSources) into the ledger (idempotent)",
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
    "  provenance [--fetch] [--json]   scan each organ folder's git source → state/provenance.json (read-only)",
    "  heatmap [--window all|Nd] [--changed-only] [--redact[=glob,...]] [--json]   file-tree heatmap (color=frequency) → state/heatmap.json (read-only)",
    "  attribution --stats [--date today|YYYY-MM-DD] [--json]   principal (who-caused-it) distribution (im-user/autonomous/local/unknown; honest, no silent gaps)",
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
