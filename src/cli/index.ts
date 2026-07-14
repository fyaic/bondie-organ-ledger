#!/usr/bin/env node
// organledger CLI. Minimal argv parsing (no heavy deps).
//   daemon | once | report [--date] | rollback --change|--session|--before [--confirm]
//   approve <id> | reject <id> | verify-ledger | status
import { loadConfig, ensureDirs, defaultLedgerHome, paths } from "../util.ts";
import { Daemon, liveDaemonPid } from "../core/daemon.ts";
import { OpenClawWatcher } from "../adapters/openclaw/watcher.ts";
import { buildReport } from "./report.ts";
import { rollback } from "./rollback.ts";
import { approve, reject } from "./approve.ts";
import { Ledger } from "../core/ledger.ts";
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

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const cfg: Config = loadConfig((flags["home"] as string) || defaultLedgerHome());
  ensureDirs(cfg.ledger_home);

  switch (cmd) {
    case "daemon":
      return runDaemon(cfg);
    case "once":
      return runOnce(cfg);
    case "report": {
      const { outPath, md } = buildReport(cfg, (flags["date"] as string) || "today");
      console.log(md);
      console.log(`\n[written] ${outPath}`);
      return;
    }
    case "rollback": {
      if (guardSingleWriter(cfg)) return;
      const out = rollback(cfg, {
        change: flags["change"] as string | undefined,
        session: flags["session"] as string | undefined,
        before: flags["before"] as string | undefined,
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
      console.log(
        [
          "organledger — Agent organ governance (Phase 1)",
          "",
          "  daemon                     start consumer + OpenClaw watcher (single instance)",
          "  once                       drain inbox + flush commits, then exit",
          "  report [--date today|YYYY-MM-DD]",
          "  rollback --change <id> | --session <id> | --before <ts> [--confirm]",
          "  approve <change_id> | reject <change_id>",
          "  verify-ledger              validate hash chain",
          "  status                     quick summary",
        ].join("\n")
      );
  }
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
    return true; // blocked
  }
  return false;
}

async function runDaemon(cfg: Config): Promise<void> {
  const d = new Daemon(cfg);
  if (!d.acquireLock()) {
    console.error("[organledger] another daemon holds the lock — exiting (single committer).");
    process.exit(1);
  }
  console.log(`[organledger] daemon up. ledger_home=${cfg.ledger_home}`);

  const watchers: OpenClawWatcher[] = [];
  for (const target of cfg.targets) {
    if (target.system === "openclaw" && target.git) {
      const w = new OpenClawWatcher(cfg, target);
      w.start();
      watchers.push(w);
      console.log(`[organledger] watching ${target.home} [${target.watch.join(", ")}]`);
    }
  }
  d.start(200);

  const shutdown = async () => {
    console.log("\n[organledger] shutting down…");
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
  console.log(`[organledger] processed ${n} event(s).`);
}

main().catch((e) => {
  console.error("[organledger] fatal:", e);
  process.exit(1);
});
