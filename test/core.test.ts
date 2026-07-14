// Core pipeline tests against a throwaway git repo + temp ledger home.
// Covers: ticket/commit/chain, debounce, session squash, held gate, tamper, lock.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Daemon } from "../src/core/daemon.ts";
import { sha256, canonicalJson, appendLine, readJsonl } from "../src/util.ts";
import type { Config, OrganEvent, Ticket } from "../src/types.ts";

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGit(dir: string): void {
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  execFileSync("git", ["-C", dir, "config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(dir, ".gitkeep"), "");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
}

function makeEnv() {
  const ledgerHome = mktmp("ol-ledger-");
  const organHome = mktmp("ol-organ-");
  initGit(organHome);
  fs.mkdirSync(path.join(ledgerHome, "events"), { recursive: true });
  const cfg: Config = {
    ledger_home: ledgerHome,
    targets: [
      {
        system: "openclaw",
        home: organHome,
        watch: ["skills", "agents"],
        git: true,
        ignore: [],
      },
    ],
    severity_rules: [
      { glob: "skills/**", severity: "high", delete_gate: "held" },
      { glob: "agents/**", severity: "high", rewrite_ratio_critical: 0.5 },
      { glob: "memory/**", severity: "medium" },
      { glob: "tasks/**", severity: "low" },
    ],
    rewrite_ratio_critical: 0.5,
    debounce_ms: 20,
    session_squash_ms: 100,
    gate: { default: "observe", held_on: ["critical", "delete"] },
  };
  return { cfg, ledgerHome, organHome };
}

function writeOrgan(home: string, rel: string, content: string): void {
  const abs = path.join(home, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function evt(system: "openclaw", rel: string, op: OrganEvent["op"], session: string | null): OrganEvent {
  return {
    event_id: "evt-" + Math.random().toString(36).slice(2),
    ts: new Date().toISOString(),
    system,
    source: "out-of-band",
    path: rel,
    op,
    before_hash: null,
    after_hash: null,
    ctx: { session_id: session, origin: null, author_hint: null, reason: null, pid: null, argv: null },
  };
}

function gitLogCount(home: string): number {
  return parseInt(execFileSync("git", ["-C", home, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim(), 10);
}

test("create → ticket(verified:false) + commit + chain intact", async () => {
  const { cfg, organHome, ledgerHome } = makeEnv();
  const d = new Daemon(cfg);
  writeOrgan(organHome, "skills/note/SKILL.md", "hello\nworld\n");
  d.inbox.appendEvent(evt("openclaw", "skills/note/SKILL.md", "create", null));
  await d.runToIdle();

  const tickets = readJsonl<Ticket>(path.join(ledgerHome, "ledger", "tickets.jsonl"));
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].author.verified, false);
  assert.equal(tickets[0].severity, "high");
  assert.equal(tickets[0].status, "observed");
  assert.ok(tickets[0].git_commit, "git_commit filled");
  assert.equal(gitLogCount(organHome), 2, "one new commit");
  assert.equal(d.ledger.verify().ok, true);
});

test("origin flows from event ctx into the ticket", async () => {
  const { cfg, organHome, ledgerHome } = makeEnv();
  const d = new Daemon(cfg);
  writeOrgan(organHome, "skills/o/SKILL.md", "x\n");
  const e = evt("openclaw", "skills/o/SKILL.md", "create", "sess-o");
  e.ctx.origin = "foreground";
  d.inbox.appendEvent(e);
  await d.runToIdle();
  const tickets = readJsonl<Ticket>(path.join(ledgerHome, "ledger", "tickets.jsonl"));
  assert.equal(tickets[tickets.length - 1].origin, "foreground");
});

test("debounce: same file 2 writes → 1 commit", async () => {
  const { cfg, organHome } = makeEnv();
  const d = new Daemon(cfg);
  const before = gitLogCount(organHome);
  writeOrgan(organHome, "skills/a/SKILL.md", "v1");
  d.inbox.appendEvent(evt("openclaw", "skills/a/SKILL.md", "create", null));
  await d.drainOnce();
  writeOrgan(organHome, "skills/a/SKILL.md", "v2");
  d.inbox.appendEvent(evt("openclaw", "skills/a/SKILL.md", "update", null));
  await d.drainOnce();
  await d.committer.flushNow();
  assert.equal(gitLogCount(organHome) - before, 1, "coalesced to a single commit");
});

test("session squash: 3 files same session → 1 commit, 3 tickets", async () => {
  const { cfg, organHome, ledgerHome } = makeEnv();
  const d = new Daemon(cfg);
  const before = gitLogCount(organHome);
  for (const n of ["x", "y", "z"]) {
    writeOrgan(organHome, `skills/${n}/SKILL.md`, "c");
    d.inbox.appendEvent(evt("openclaw", `skills/${n}/SKILL.md`, "create", "sess-1"));
  }
  await d.runToIdle();
  assert.equal(gitLogCount(organHome) - before, 1, "single squashed commit");
  const tickets = readJsonl<Ticket>(path.join(ledgerHome, "ledger", "tickets.jsonl"));
  assert.equal(tickets.length, 3);
  const commits = new Set(tickets.map((t) => t.git_commit));
  assert.equal(commits.size, 1, "all 3 tickets share one commit");
});

test("held: delete → status held, NO commit, held file written", async () => {
  const { cfg, organHome, ledgerHome } = makeEnv();
  const d = new Daemon(cfg);
  writeOrgan(organHome, "skills/del/SKILL.md", "x");
  execFileSync("git", ["-C", organHome, "add", "-A"]);
  execFileSync("git", ["-C", organHome, "commit", "-q", "-m", "seed"]);
  const before = gitLogCount(organHome);
  fs.rmSync(path.join(organHome, "skills/del/SKILL.md"));
  d.inbox.appendEvent(evt("openclaw", "skills/del/SKILL.md", "delete", null));
  await d.runToIdle();
  assert.equal(gitLogCount(organHome), before, "no commit for held delete");
  const tickets = readJsonl<Ticket>(path.join(ledgerHome, "ledger", "tickets.jsonl"));
  assert.equal(tickets[tickets.length - 1].status, "held");
  assert.ok(fs.existsSync(path.join(ledgerHome, "ledger", "held", tickets[tickets.length - 1].change_id + ".json")));
});

test("critical escalation: >50% deletion of agents file → held", async () => {
  const { cfg, organHome, ledgerHome } = makeEnv();
  const d = new Daemon(cfg);
  const big = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  writeOrgan(organHome, "agents/AGENTS.md", big);
  execFileSync("git", ["-C", organHome, "add", "-A"]);
  execFileSync("git", ["-C", organHome, "commit", "-q", "-m", "seed agents"]);
  writeOrgan(organHome, "agents/AGENTS.md", "line 0\nline 1\n"); // 100 → 2 lines
  d.inbox.appendEvent(evt("openclaw", "agents/AGENTS.md", "update", null));
  await d.runToIdle();
  const tickets = readJsonl<Ticket>(path.join(ledgerHome, "ledger", "tickets.jsonl"));
  const last = tickets[tickets.length - 1];
  assert.equal(last.severity, "critical");
  assert.equal(last.status, "held");
});

test("hash chain tamper detection", async () => {
  const { cfg, organHome, ledgerHome } = makeEnv();
  const d = new Daemon(cfg);
  for (const n of ["a", "b", "c"]) {
    writeOrgan(organHome, `skills/${n}/SKILL.md`, "c");
    d.inbox.appendEvent(evt("openclaw", `skills/${n}/SKILL.md`, "create", `s-${n}`));
    await d.runToIdle();
  }
  assert.equal(d.ledger.verify().ok, true);
  // tamper: rewrite a middle ticket's reason
  const tf = path.join(ledgerHome, "ledger", "tickets.jsonl");
  const lines = readJsonl<Ticket>(tf);
  lines[1].reason = "TAMPERED";
  fs.writeFileSync(tf, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const v = new Daemon(cfg).ledger.verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenIndex, 2, "break detected at ticket after the tampered one");
});

test("single-instance lock: second daemon cannot acquire", async () => {
  const { cfg } = makeEnv();
  const d1 = new Daemon(cfg);
  assert.equal(d1.acquireLock(), true);
  const d2 = new Daemon(cfg);
  assert.equal(d2.acquireLock(), false, "second instance blocked");
  d1.releaseLock();
  assert.equal(d2.acquireLock(), true, "released → acquirable");
  d2.releaseLock();
});

test("replay idempotency: same events drained twice → no duplicate commits", async () => {
  const { cfg, organHome, ledgerHome } = makeEnv();
  const d = new Daemon(cfg);
  writeOrgan(organHome, "skills/rp/SKILL.md", "x");
  const e = evt("openclaw", "skills/rp/SKILL.md", "create", "sess-rp");
  d.inbox.appendEvent(e);
  await d.runToIdle();
  const commitsAfter1 = gitLogCount(organHome);
  const ticketsAfter1 = readJsonl<Ticket>(path.join(ledgerHome, "ledger", "tickets.jsonl")).length;
  // replay the SAME event id
  d.inbox.appendEvent(e);
  await d.runToIdle();
  assert.equal(gitLogCount(organHome), commitsAfter1, "no new commit on replay");
  // change_id differs but file already committed → no dup commit; ticket count may grow by a no-op sealed ticket at most
  const ticketsAfter2 = readJsonl<Ticket>(path.join(ledgerHome, "ledger", "tickets.jsonl")).length;
  assert.ok(ticketsAfter2 >= ticketsAfter1);
});
