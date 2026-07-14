// P7 coverage: approve (held → commit) and rollback --change (safety branch +
// revert + rolled_back ticket), both non-destructive.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Daemon } from "../src/core/daemon.ts";
import { approve, reject } from "../src/cli/approve.ts";
import { rollback } from "../src/cli/rollback.ts";
import { Ledger } from "../src/core/ledger.ts";
import type { Config, OrganEvent, Ticket } from "../src/types.ts";

function mktmp(p: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}
function initGit(dir: string) {
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  execFileSync("git", ["-C", dir, "config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(dir, ".gitkeep"), "");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
}
function env() {
  const ledgerHome = mktmp("ol-rb-l-");
  const organHome = mktmp("ol-rb-o-");
  initGit(organHome);
  fs.mkdirSync(path.join(ledgerHome, "events"), { recursive: true });
  const cfg: Config = {
    ledger_home: ledgerHome,
    targets: [{ system: "openclaw", home: organHome, watch: ["skills"], git: true, ignore: [] }],
    severity_rules: [{ glob: "skills/**", severity: "high", delete_gate: "held" }],
    rewrite_ratio_critical: 0.5,
    debounce_ms: 15,
    session_squash_ms: 60,
    gate: { default: "observe", held_on: ["critical", "delete"] },
  };
  return { cfg, organHome, ledgerHome };
}
function evt(rel: string, op: OrganEvent["op"]): OrganEvent {
  return {
    event_id: "evt-" + Math.random().toString(36).slice(2),
    ts: new Date().toISOString(),
    system: "openclaw", source: "out-of-band", path: rel, op,
    before_hash: null, after_hash: null,
    ctx: { session_id: null, origin: null, author_hint: null, reason: null, pid: null, argv: null },
  };
}
function tickets(ledgerHome: string) {
  return new Ledger(ledgerHome).all();
}
function logCount(home: string) {
  return parseInt(execFileSync("git", ["-C", home, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim(), 10);
}

test("approve: held delete → real commit + approved ticket + chain intact", async () => {
  const { cfg, organHome, ledgerHome } = env();
  const d = new Daemon(cfg);
  fs.mkdirSync(path.join(organHome, "skills/k"), { recursive: true });
  fs.writeFileSync(path.join(organHome, "skills/k/SKILL.md"), "x");
  execFileSync("git", ["-C", organHome, "add", "-A"]);
  execFileSync("git", ["-C", organHome, "commit", "-q", "-m", "seed"]);
  const before = logCount(organHome);
  fs.rmSync(path.join(organHome, "skills/k/SKILL.md"));
  d.inbox.appendEvent(evt("skills/k/SKILL.md", "delete"));
  await d.runToIdle();

  const held = tickets(ledgerHome).find((t) => t.status === "held")!;
  assert.ok(held, "held ticket exists");
  assert.equal(logCount(organHome), before, "no commit while held");

  const out = approve(cfg, held.change_id);
  assert.ok(out.join("\n").includes("approved"));
  assert.equal(logCount(organHome), before + 1, "approve created the commit");
  const appr = tickets(ledgerHome).find((t) => t.status === "approved");
  assert.ok(appr && appr.git_commit, "approved ticket with commit");
  assert.equal(new Ledger(ledgerHome).verify().ok, true);
});

test("rollback --change: safety branch + revert + rolled_back ticket", async () => {
  const { cfg, organHome, ledgerHome } = env();
  const d = new Daemon(cfg);
  fs.mkdirSync(path.join(organHome, "skills/r"), { recursive: true });
  fs.writeFileSync(path.join(organHome, "skills/r/SKILL.md"), "hello");
  d.inbox.appendEvent(evt("skills/r/SKILL.md", "create"));
  await d.runToIdle();
  const created = tickets(ledgerHome).find((t) => t.status === "observed" && t.git_commit)!;
  assert.ok(fs.existsSync(path.join(organHome, "skills/r/SKILL.md")));

  const out = rollback(cfg, { change: created.change_id });
  const joined = out.join("\n");
  assert.ok(joined.includes("safety branch"), "safety branch created");
  assert.ok(joined.includes("reverted"), "revert ran");
  assert.ok(!fs.existsSync(path.join(organHome, "skills/r/SKILL.md")), "file removed by revert");
  const branches = execFileSync("git", ["-C", organHome, "branch"], { encoding: "utf8" });
  assert.ok(/organledger-safety/.test(branches), "safety branch present");
  assert.ok(tickets(ledgerHome).some((t) => t.status === "rolled_back"));
  assert.equal(new Ledger(ledgerHome).verify().ok, true);
});

test("reject: held → rejected ticket, no commit", async () => {
  const { cfg, organHome, ledgerHome } = env();
  const d = new Daemon(cfg);
  fs.mkdirSync(path.join(organHome, "skills/j"), { recursive: true });
  fs.writeFileSync(path.join(organHome, "skills/j/SKILL.md"), "x");
  execFileSync("git", ["-C", organHome, "add", "-A"]);
  execFileSync("git", ["-C", organHome, "commit", "-q", "-m", "seed"]);
  const before = logCount(organHome);
  fs.rmSync(path.join(organHome, "skills/j/SKILL.md"));
  d.inbox.appendEvent(evt("skills/j/SKILL.md", "delete"));
  await d.runToIdle();
  const held = tickets(ledgerHome).find((t) => t.status === "held")!;
  reject(cfg, held.change_id);
  assert.equal(logCount(organHome), before, "reject makes no commit");
  assert.ok(tickets(ledgerHome).some((t) => t.status === "rejected"));
  assert.ok(!fs.existsSync(path.join(cfg.ledger_home, "ledger", "held", held.change_id + ".json")));
});
