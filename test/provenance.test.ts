// Provenance layer tests (Phase 1.6): GitSource scanning, verified-provenance
// injection, additive schema (chain intact), and reflog upstream-event mapping.
// Uses throwaway git repos — including an EMBEDDED repo inside the target — so
// the "a target is not one repo" reality is exercised, not mocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveSources, inspectSource, scanSources } from "../src/onboard/provenance.ts";
import { backfillFromGitHistory, backfillReflog } from "../src/onboard/backfill.ts";
import { Ledger } from "../src/core/ledger.ts";
import { canonicalJson } from "../src/util.ts";
import type { Config, Target, Ticket } from "../src/types.ts";

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "Tester"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

function write(dir: string, rel: string, body: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

// A parent repo governing skills/plain, with an EMBEDDED repo at skills/embedded
// that has its own remote (origin) — exactly the on-site shape.
function makeNestedTarget(): { home: string; nested: string; target: Target } {
  const home = mktmp("ol-prov-");
  initRepo(home);
  write(home, "skills/plain/SKILL.md", "parent skill\n");
  git(home, ["add", "-A"]);
  git(home, ["commit", "-q", "-m", "parent skill"]);
  git(home, ["branch", "-M", "main"]);

  const nested = path.join(home, "skills", "embedded");
  fs.mkdirSync(nested, { recursive: true });
  initRepo(nested);
  write(nested, "SKILL.md", "nested v1\n");
  write(nested, "board.md", "board v1\n");
  git(nested, ["add", "-A"]);
  git(nested, ["commit", "-q", "-m", "nested init"]);
  git(nested, ["branch", "-M", "main"]);
  git(nested, ["remote", "add", "origin", "https://example.com/embedded.git"]);

  const target: Target = {
    system: "openclaw", home, watch: ["skills"], git: true, ignore: ["**/*.log"],
  };
  return { home, nested, target };
}

function testConfig(home: string): Config {
  return {
    ledger_home: home,
    targets: [],
    severity_rules: [
      { glob: "skills/**", severity: "high", delete_gate: "held" },
      { glob: "agents/**", severity: "high" },
    ],
    rewrite_ratio_critical: 0.5,
    debounce_ms: 10,
    session_squash_ms: 100,
    gate: { default: "observe", held_on: ["critical", "delete"] },
  };
}

test("resolveSources: finds parent (rel='') + embedded repo as separate sources", () => {
  const { target } = makeNestedTarget();
  const sources = resolveSources(target);
  const parent = sources.find((s) => !s.is_nested);
  const nested = sources.find((s) => s.is_nested);
  assert.ok(parent, "parent source present");
  assert.equal(parent!.rel, "", "parent rel is empty");
  assert.ok(nested, "embedded source present");
  assert.equal(nested!.rel, "skills/embedded", "embedded rel is full target-relative path");
  assert.equal(sources.length, 2, "exactly parent + one embedded");
});

test("inspectSource: remote/branch/dirty resolved; no-upstream ahead/behind null (no crash)", () => {
  const { nested, target } = makeNestedTarget();
  const src = resolveSources(target).find((s) => s.is_nested)!;
  let info = inspectSource(src);
  assert.equal(info.branch, "main");
  assert.equal(info.remote_name, "origin");
  assert.equal(info.remote_url, "https://example.com/embedded.git");
  assert.equal(info.upstream, null, "no tracking branch → null upstream");
  assert.equal(info.ahead, null, "no upstream → ahead null");
  assert.equal(info.behind, null, "no upstream → behind null");
  assert.equal(info.dirty, false, "clean tree");

  // introduce a local uncommitted change → dirty flips true
  fs.writeFileSync(path.join(nested, "SKILL.md"), "nested v2 (drift)\n");
  info = inspectSource(src);
  assert.equal(info.dirty, true, "uncommitted change detected as drift");
});

test("additive schema red line: provenance is optional — old ticket bytes unchanged, chain intact", () => {
  const home = mktmp("ol-provchain-");
  const ledger = new Ledger(home);
  const base: Omit<Ticket, "provenance"> = {
    change_id: ledger.nextChangeId(), system: "openclaw", source: "out-of-band",
    author: { type: "unknown", id: null, verified: false }, session_id: null, origin: null,
    file: "skills/x/SKILL.md", op: "create", before_hash: null, after_hash: "sha256:x",
    reason: null, severity: "high", status: "observed", git_commit: null,
    prev_ticket_hash: "", created_at: "2026-07-01T00:00:00.000Z",
  };
  // a ticket WITHOUT provenance must canonicalize identically to before the field existed
  assert.ok(!canonicalJson(base).includes("provenance"), "undefined provenance key omitted from canonical JSON");

  ledger.append({ ...base } as Ticket); // no provenance
  ledger.append({
    ...base, change_id: ledger.nextChangeId(),
    provenance: { kind: "content", repo_root: "/r", remote_url: "u", branch: "main", from_commit: null, to_commit: "abc", verified: true },
  } as Ticket); // with provenance
  const v = new Ledger(home).verify();
  assert.equal(v.ok, true, "chain intact across no-provenance + provenance tickets");
});

test("backfill embedded repo: content tickets carry verified provenance; author stays unverified", () => {
  const { target, nested } = makeNestedTarget();
  const ledgerHome = mktmp("ol-provbf-");
  const cfg = testConfig(ledgerHome);
  const ledger = new Ledger(ledgerHome);

  const r = backfillFromGitHistory(target, ledger, cfg, { fullHistory: true });
  assert.ok(r.tickets >= 3, "parent skill + embedded SKILL.md/board.md backfilled");

  const all = new Ledger(ledgerHome).all();
  // embedded files use the FULL target-relative path (D-P7), not repo-relative
  const embedded = all.filter((t) => t.file.startsWith("skills/embedded/"));
  assert.ok(embedded.length >= 2, "embedded repo produced content tickets");
  assert.ok(embedded.some((t) => t.file === "skills/embedded/SKILL.md"), "path is skills/embedded/SKILL.md");
  for (const t of embedded) {
    assert.equal(t.provenance?.kind, "content");
    assert.equal(t.provenance?.verified, true, "provenance verified (content-addressed)");
    assert.equal(t.provenance?.remote_url, "https://example.com/embedded.git");
    assert.equal(t.provenance?.to_commit, t.git_commit, "content provenance to_commit = ticket commit");
    assert.equal(t.author.verified, false, "identity NEVER verified");
  }
  // parent-tracked skill also present with its own (remote-less) provenance
  assert.ok(all.some((t) => t.file === "skills/plain/SKILL.md" && t.provenance?.kind === "content"));
  assert.equal(new Ledger(ledgerHome).verify().ok, true, "chain intact after multi-source backfill");
  void nested;
});

test("backfill --no-provenance opt-out: content tickets carry no provenance", () => {
  const { target } = makeNestedTarget();
  const ledgerHome = mktmp("ol-provoff-");
  const cfg = testConfig(ledgerHome);
  const ledger = new Ledger(ledgerHome);
  backfillFromGitHistory(target, ledger, cfg, { fullHistory: true, noProvenance: true });
  const all = new Ledger(ledgerHome).all();
  assert.ok(all.length >= 3);
  assert.ok(all.every((t) => t.provenance === undefined), "no provenance injected when opted out");
});

test("reflog: a real merge becomes an upstream-update ticket (kind=merge, from→to, verified)", () => {
  const home = mktmp("ol-reflog-");
  initRepo(home);
  write(home, "skills/s/SKILL.md", "v1\n");
  git(home, ["add", "-A"]);
  git(home, ["commit", "-q", "-m", "base"]);
  git(home, ["branch", "-M", "main"]);
  // branch, diverge, merge back with a merge commit (no-ff) → reflog "merge" entry
  git(home, ["checkout", "-q", "-b", "feature"]);
  write(home, "skills/s/board.md", "feature\n");
  git(home, ["add", "-A"]);
  git(home, ["commit", "-q", "-m", "feature work"]);
  git(home, ["checkout", "-q", "main"]);
  git(home, ["merge", "--no-ff", "-q", "-m", "merge feature", "feature"]);

  const ledgerHome = mktmp("ol-reflogL-");
  const cfg = testConfig(ledgerHome);
  const target: Target = { system: "openclaw", home, watch: ["skills"], git: true, ignore: [] };
  const ledger = new Ledger(ledgerHome);

  const r = backfillReflog(target, ledger, cfg, {});
  assert.ok(r.events >= 1, "at least one upstream-update (merge) event");
  const merged = new Ledger(ledgerHome).all().find((t) => t.provenance?.kind === "merge");
  assert.ok(merged, "merge event ticket present");
  assert.equal(merged!.op, "update");
  assert.equal(merged!.provenance?.verified, true);
  assert.ok(merged!.provenance?.to_commit, "to_commit set");
  assert.ok(merged!.provenance?.from_commit, "from_commit set (pre-merge HEAD)");
  assert.equal(merged!.author.verified, false, "who merged stays unverified");
  assert.equal(new Ledger(ledgerHome).verify().ok, true, "chain intact after reflog backfill");

  // idempotent: re-run adds nothing (fingerprint dedup)
  const r2 = backfillReflog(target, new Ledger(ledgerHome), cfg, {});
  assert.equal(r2.events, 0, "reflog backfill is idempotent");
});

test("reflog: no upstream events in a commit-only repo is a safe no-op (not a failure)", () => {
  const home = mktmp("ol-reflog2-");
  initRepo(home);
  write(home, "skills/s/SKILL.md", "only commits here\n");
  git(home, ["add", "-A"]);
  git(home, ["commit", "-q", "-m", "c1"]);
  write(home, "skills/s/SKILL.md", "edit\n");
  git(home, ["add", "-A"]);
  git(home, ["commit", "-q", "-m", "c2"]);

  const ledgerHome = mktmp("ol-reflog2L-");
  const cfg = testConfig(ledgerHome);
  const target: Target = { system: "openclaw", home, watch: ["skills"], git: true, ignore: [] };
  const r = backfillReflog(target, new Ledger(ledgerHome), cfg, {});
  assert.equal(r.events, 0, "no pull/merge/clone → zero events");
  assert.match(r.note, /no upstream updates/, "honestly reports no upstream events");
  // but the machinery works when asked for all HEAD moves
  const r2 = backfillReflog(target, new Ledger(ledgerHome), cfg, { includeNonUpstream: true });
  assert.ok(r2.events >= 1, "commit entries surface as local-commit moves when requested");
  void scanSources;
});
