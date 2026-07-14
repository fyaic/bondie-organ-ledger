// Onboarding tests: non-destructive v1→v2 migration, paths v2, logger rotation,
// config v2 load-with-defaults. Uses throwaway homes (no real ~/.organledger).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { paths, readVersion, loadConfigSafe, git } from "../src/util.ts";
import { migrateLayout, needsMigration } from "../src/onboard/migrate.ts";
import { Ledger } from "../src/core/ledger.ts";
import { Logger } from "../src/onboard/logger.ts";
import { DEFAULT_IGNORE } from "../src/onboard/init.ts";
import { backfillFromGitHistory } from "../src/onboard/backfill.ts";
import type { Config, Target, Ticket } from "../src/types.ts";

function mktmp(p: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

// minimal config: skills=high, cron=high; ignore runtime churn under cron/runs
function testConfig(home: string): Config {
  return {
    ledger_home: home,
    targets: [],
    severity_rules: [
      { glob: "skills/**", severity: "high" },
      { glob: "cron/**", severity: "high" },
    ],
    rewrite_ratio_critical: 0.5,
    debounce_ms: 3000,
    session_squash_ms: 15000,
    gate: { default: "observe", held_on: ["critical", "delete"] },
  };
}

// build a throwaway git target with 3 commits touching organ + runtime files
function makeGitTarget(): { home: string; target: Target } {
  const home = mktmp("ol-git-");
  git(home, ["init", "-q"]);
  git(home, ["config", "user.email", "t@t"]);
  git(home, ["config", "user.name", "Tester"]);
  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.join(home, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), body);
  };
  write("skills/s0/SKILL.md", "v1\n");
  git(home, ["add", "-A"]); git(home, ["commit", "-q", "-m", "add s0"]);
  write("skills/s1/SKILL.md", "hello\n");
  write("cron/runs/run-1.jsonl", '{"x":1}\n'); // runtime churn — must be dropped
  git(home, ["add", "-A"]); git(home, ["commit", "-q", "-m", "add s1 + a run"]);
  write("skills/s0/SKILL.md", "v2 changed\n");
  git(home, ["add", "-A"]); git(home, ["commit", "-q", "-m", "edit s0"]);
  const target: Target = {
    system: "openclaw", home, watch: ["skills", "cron"], git: true,
    ignore: ["cron/runs/**"],
  };
  return { home, target };
}

// Build a realistic v1 (flat) home: a valid 3-ticket chain + flat state artifacts.
function makeV1Home(): { home: string; ticketCount: number } {
  const home = mktmp("ol-v1-");
  // seed a valid hash chain via the real Ledger (writes ledger/tickets.jsonl)
  const ledger = new Ledger(home);
  for (let i = 0; i < 3; i++) {
    ledger.append({
      change_id: ledger.nextChangeId(),
      system: "openclaw", source: "out-of-band",
      author: { type: "unknown", id: null, verified: false },
      session_id: null, file: `skills/s${i}/SKILL.md`, op: "create",
      before_hash: null, after_hash: "sha256:x", reason: null,
      severity: "high", status: "observed", git_commit: null,
      prev_ticket_hash: "", created_at: new Date().toISOString(),
    } as Ticket);
  }
  // flat state artifacts (v1 layout)
  fs.mkdirSync(path.join(home, "events", "processed"), { recursive: true });
  fs.writeFileSync(path.join(home, "events", "inbox.jsonl"), '{"event_id":"evt-1"}\n');
  fs.writeFileSync(path.join(home, "events", "processed", "batch-old.jsonl"), '{"event_id":"evt-0"}\n');
  fs.writeFileSync(path.join(home, "daemon.lock"), "99999");
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ ledger_home: home, targets: [] }));
  return { home, ticketCount: 3 };
}

test("needsMigration detects v1 flat layout", () => {
  const { home } = makeV1Home();
  assert.equal(needsMigration(home), true);
});

test("migrate v1→v2 is non-destructive: chain intact, zero ticket loss", () => {
  const { home, ticketCount } = makeV1Home();
  const before = new Ledger(home).verify();
  assert.equal(before.ok, true);

  const res = migrateLayout(home);
  assert.equal(res.migrated, true);
  assert.equal(res.ticketsBefore, ticketCount);
  assert.equal(res.ticketsAfter, ticketCount);

  // RED LINE: chain still intact, count preserved
  const after = new Ledger(home).verify();
  assert.equal(after.ok, true);

  // v2 layout in place
  const p = paths(home);
  assert.ok(fs.existsSync(p.inbox), "state/events/inbox.jsonl moved");
  assert.ok(fs.existsSync(p.lock), "state/daemon.lock moved");
  assert.ok(fs.existsSync(p.logs), "logs/ created");
  assert.ok(fs.existsSync(p.cache), "cache/ created");
  assert.equal(fs.readFileSync(p.inbox, "utf8").trim(), '{"event_id":"evt-1"}', "inbox content preserved");
  // legacy flat locations gone
  assert.ok(!fs.existsSync(path.join(home, "events")), "legacy events/ removed");
  assert.ok(!fs.existsSync(path.join(home, "daemon.lock")), "legacy lock removed");
  // VERSION stamped
  const v = readVersion(home);
  assert.equal(v?.layout, 2);
  // audit path unchanged
  assert.equal(p.tickets, path.join(home, "ledger", "tickets.jsonl"));
  // backup taken
  assert.ok(res.backup && fs.existsSync(res.backup), "pre-migration backup exists");
});

test("migrate is idempotent: second run is a no-op", () => {
  const { home } = makeV1Home();
  migrateLayout(home);
  const r2 = migrateLayout(home);
  assert.equal(r2.migrated, false);
  assert.equal(new Ledger(home).verify().ok, true);
});

test("paths v2 exposes partitioned keys; audit paths unchanged", () => {
  const home = mktmp("ol-paths-");
  const p = paths(home);
  assert.ok(p.inbox.includes(path.join("state", "events")));
  assert.ok(p.lock.endsWith(path.join("state", "daemon.lock")));
  assert.ok(p.logs.endsWith("logs"));
  assert.ok(p.cache.endsWith("cache"));
  assert.ok(p.tickets.endsWith(path.join("ledger", "tickets.jsonl")));
  assert.ok(p.reports.endsWith(path.join("reports", "audit")));
});

test("logger: writes formatted lines to disk, errors to .err, no file contents", () => {
  const home = mktmp("ol-log-");
  const log = new Logger(home, "info", false /* no console echo in test */);
  log.info("daemon", "up. watching ~/.openclaw");
  log.warn("watcher", "EPERM skills/x/.tmp — skipped");
  log.error("committer", "git add failed: 128");
  log.debug("daemon", "this is below info — must NOT appear");

  const day = new Date().toISOString().slice(0, 10);
  const main = fs.readFileSync(path.join(home, "logs", `daemon-${day}.log`), "utf8");
  const err = fs.readFileSync(path.join(home, "logs", `daemon-${day}.err.log`), "utf8");

  assert.match(main, /\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[INFO\] \[daemon\] up\./);
  assert.ok(!main.includes("below info"), "debug filtered at info level");
  assert.ok(err.includes("[WARN]") && err.includes("[ERROR]"), "warn+error tee'd to .err");
  assert.ok(!err.includes("[INFO]"), "info not in .err");
});

test("logger.pruneOld removes files older than retention", () => {
  const home = mktmp("ol-log2-");
  const log = new Logger(home, "info", false);
  const logs = path.join(home, "logs");
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, "daemon-2000-01-01.log"), "old\n");
  fs.writeFileSync(path.join(logs, "daemon-2000-01-01.err.log"), "old\n");
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(logs, `daemon-${today}.log`), "new\n");
  const removed = log.pruneOld(14);
  assert.equal(removed, 2, "two expired files removed");
  assert.ok(fs.existsSync(path.join(logs, `daemon-${today}.log`)), "today's log kept");
});

test("loadConfigSafe returns null when uninitialized (no crash)", () => {
  const home = mktmp("ol-empty-");
  assert.equal(loadConfigSafe(home), null);
});

test("DEFAULT_IGNORE carries the Phase-1 runtime exclusions", () => {
  for (const p of ["cron/runs/**", "flows/*.sqlite", "tasks/*.sqlite", "**/*.log", "agents/main/**"]) {
    assert.ok(DEFAULT_IGNORE.includes(p), `missing ${p}`);
  }
});

test("backfill: git history → tickets, chain intact, verified stays false, churn dropped", () => {
  const ledgerHome = mktmp("ol-bf-");
  const { target } = makeGitTarget();
  const cfg = testConfig(ledgerHome);
  const ledger = new Ledger(ledgerHome);

  const r = backfillFromGitHistory(target, ledger, cfg, { fullHistory: true });

  // 3 organ changes: create s0, create s1, update s0 (cron/runs churn dropped)
  assert.equal(r.tickets, 3, "three organ-definition tickets");
  assert.ok(r.droppedFiles >= 1, "cron/runs runtime file dropped");
  assert.equal(new Ledger(ledgerHome).verify().ok, true, "hash chain intact after backfill");

  const tickets = new Ledger(ledgerHome).all();
  assert.ok(tickets.every((t) => t.author.verified === false), "author.verified never true");
  assert.ok(tickets.every((t) => !!t.git_commit), "every ticket carries its git_commit");
  assert.ok(tickets.every((t) => t.status === "observed"), "historical tickets are observed, not held");
  assert.ok(!tickets.some((t) => t.file.startsWith("cron/runs/")), "no runtime-churn ticket");
  // ops mapped from git status
  assert.ok(tickets.some((t) => t.file === "skills/s0/SKILL.md" && t.op === "create"));
  assert.ok(tickets.some((t) => t.file === "skills/s0/SKILL.md" && t.op === "update"));
  // git author captured as an UNVERIFIED hint
  assert.ok(tickets.some((t) => (t.author.id ?? "").includes("git:Tester")), "git author stored as hint");
});

test("backfill is idempotent: re-run adds zero tickets (dedup by git_commit)", () => {
  const ledgerHome = mktmp("ol-bf2-");
  const { target } = makeGitTarget();
  const cfg = testConfig(ledgerHome);

  const first = backfillFromGitHistory(target, new Ledger(ledgerHome), cfg, { fullHistory: true });
  const countAfterFirst = new Ledger(ledgerHome).all().length;
  const second = backfillFromGitHistory(target, new Ledger(ledgerHome), cfg, { fullHistory: true });

  assert.equal(second.tickets, 0, "second run appends nothing");
  assert.ok(second.skippedCommits >= 3, "all commits recognized as already recorded");
  assert.equal(new Ledger(ledgerHome).all().length, countAfterFirst, "ledger size unchanged");
  assert.equal(new Ledger(ledgerHome).verify().ok, true);
  assert.equal(first.tickets, 3);
});

test("backfill on a non-git target is a safe no-op", () => {
  const ledgerHome = mktmp("ol-bf3-");
  const cfg = testConfig(ledgerHome);
  const target: Target = { system: "hermes", home: mktmp("ol-nogit-"), watch: ["skills"], git: false, ignore: [] };
  const r = backfillFromGitHistory(target, new Ledger(ledgerHome), cfg, {});
  assert.equal(r.tickets, 0);
  assert.match(r.note, /not a git repo/);
});
