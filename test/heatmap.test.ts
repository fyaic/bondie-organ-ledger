// Heatmap tests (Phase 1.7 feature B). The head red line is PRIVACY — two of
// these assert it directly: (1) heatmap.json carries ONLY the whitelist fields
// (no content/diff/hash/reason/secret), (2) sensitive paths are redacted (name
// hidden) while their heat is preserved. Also covers changed-only frequency, the
// bounded full-tree walk (exclusions + child folding + depth cap), and a
// missing/empty target being a safe no-op (not a crash).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "../src/core/ledger.ts";
import { buildHeatmap } from "../src/onboard/heatmap.ts";
import type { HeatNode } from "../src/onboard/heatmap.ts";
import type { Config, Op, Target, Ticket } from "../src/types.ts";

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function seed(home: string, rows: Array<{ file: string; op?: Op; created_at?: string }>): void {
  const ledger = new Ledger(home);
  for (const r of rows) {
    ledger.append({
      change_id: ledger.nextChangeId(), system: "openclaw", source: "out-of-band",
      author: { type: "unknown", id: null, verified: false }, session_id: null, origin: null,
      file: r.file, op: r.op ?? "update", before_hash: null, after_hash: "sha256:x",
      reason: null, severity: "high", status: "observed", git_commit: null,
      prev_ticket_hash: "", created_at: r.created_at ?? "2026-05-14T10:00:00+08:00",
    } as Ticket);
  }
}

function cfgFor(home: string, target: Target): Config {
  return {
    ledger_home: home, targets: [target], severity_rules: [], rewrite_ratio_critical: 0.5,
    debounce_ms: 10, session_squash_ms: 100, gate: { default: "observe", held_on: [] },
  };
}

function target(home: string, targetHome: string, ignore: string[] = []): Target {
  return { system: "openclaw", home: targetHome, watch: ["skills", "agents"], git: true, ignore };
}

function walkNodes(root: HeatNode, fn: (n: HeatNode) => void): void {
  fn(root);
  for (const c of root.children || []) walkNodes(c, fn);
}

function find(root: HeatNode, pred: (n: HeatNode) => boolean): HeatNode | null {
  let hit: HeatNode | null = null;
  walkNodes(root, (n) => { if (!hit && pred(n)) hit = n; });
  return hit;
}

test("changed-only frequency: leaf counts and directory aggregation are correct", () => {
  const home = mktmp("ol-hm-freq-");
  seed(home, [
    { file: "skills/eye-on/SKILL.md" }, { file: "skills/eye-on/SKILL.md" }, { file: "skills/eye-on/SKILL.md" },
    { file: "skills/eye-on/board.md" },
    { file: "skills/other/x.md" },
  ]);
  const report = buildHeatmap(cfgFor(home, target(home, home)), { window: "all", fullTree: false });
  const root = report.targets[0].root;
  assert.equal(root.change_count, 5, "root aggregates every change");
  const skill = find(root, (n) => n.name === "eye-on")!;
  assert.equal(skill.change_count, 4, "dir = sum of descendant leaves (3 + 1)");
  const leaf = find(skill, (n) => n.name === "SKILL.md")!;
  assert.equal(leaf.change_count, 3, "leaf count = ticket count for that exact path");
  assert.equal(leaf.type, "file");
  assert.equal(skill.type, "dir");
});

test("window filter: --window Nd only counts recent tickets", () => {
  const home = mktmp("ol-hm-win-");
  const old = "2026-01-01T10:00:00+08:00";
  const recent = new Date(Date.now() - 2 * 86400000).toISOString();
  seed(home, [{ file: "skills/eye-on/a.md", created_at: old }, { file: "skills/eye-on/b.md", created_at: recent }]);
  const all = buildHeatmap(cfgFor(home, target(home, home)), { window: "all" });
  const win = buildHeatmap(cfgFor(home, target(home, home)), { window: "7d" });
  assert.equal(all.targets[0].root.change_count, 2);
  assert.equal(win.targets[0].root.change_count, 1, "7d window drops the old ticket");
});

// ---- PRIVACY ASSERTION 1: strict field whitelist, no blacklist, no secrets ---
test("PRIVACY: heatmap.json carries ONLY whitelist fields — no content/diff/hash/reason/secret", () => {
  const home = mktmp("ol-hm-priv1-");
  seed(home, [
    { file: "skills/eye-on/SKILL.md", op: "create" },
    { file: "agents/AGENTS.md", op: "update" },
  ]);
  const report = buildHeatmap(cfgFor(home, target(home, home)), { window: "all", fullTree: false });

  const ALLOWED = new Set(["name", "type", "change_count", "last_change", "depth", "redacted", "truncated", "children"]);
  walkNodes(report.targets[0].root, (n) => {
    for (const k of Object.keys(n)) {
      assert.ok(ALLOWED.has(k), `HeatNode leaked a non-whitelisted field: "${k}"`);
    }
  });

  const json = JSON.stringify(report);
  for (const banned of ['"reason"', '"before_hash"', '"after_hash"', '"content"', '"diff"', '"git_commit"', '"remote_url"', '"provenance"', '"author"']) {
    assert.ok(!json.includes(banned), `heatmap.json must not contain ${banned}`);
  }
  assert.ok(!/-----BEGIN|AKIA[0-9A-Z]{16}|sk-[a-zA-Z0-9]{20}|PRIVATE KEY/.test(json), "no secret patterns");
});

// ---- PRIVACY ASSERTION 2: sensitive glob redacts name, KEEPS heat -----------
test("PRIVACY: sensitive paths are redacted (name hidden) but change_count is preserved", () => {
  const home = mktmp("ol-hm-priv2-");
  seed(home, [
    { file: "agents/main/sessions/sessions.json" },
    { file: "agents/main/sessions/sessions.json" },
    { file: "skills/x/agents/main/auth-profiles.json" }, // nested agents/main (on-site shape)
    { file: "skills/x/.env" },
    { file: "skills/eye-on/SKILL.md" }, // NOT sensitive → not redacted
  ]);
  const report = buildHeatmap(cfgFor(home, target(home, home)), { window: "all", fullTree: false });
  const root = report.targets[0].root;

  // every redacted node hides its real name but keeps heat
  let redactedCount = 0;
  walkNodes(root, (n) => {
    if (n.redacted) {
      redactedCount++;
      assert.equal(n.name, "•••", "redacted node name is masked");
      assert.ok(n.change_count >= 0, "heat is still present");
    }
  });
  assert.ok(redactedCount > 0, "sensitive nodes were redacted");

  // the agents/main subtree exists with heat but no readable leaf name survives
  const mainDir = find(root, (n) => n.redacted && n.change_count >= 2);
  assert.ok(mainDir, "a redacted node retains its (>=2) change_count — heat visible, name hidden");

  // a non-sensitive skill file is NOT redacted and keeps its name
  const clean = find(root, (n) => n.name === "SKILL.md");
  assert.ok(clean && !clean.redacted, "ordinary skill file stays visible");
});

test("bounded full-tree: node_modules/.git excluded, huge dir folded + truncated marked", () => {
  const home = mktmp("ol-hm-bound-");
  const tgt = mktmp("ol-hm-target-");
  // real on-disk structure
  fs.mkdirSync(path.join(tgt, "skills", "eye-on"), { recursive: true });
  fs.writeFileSync(path.join(tgt, "skills", "eye-on", "SKILL.md"), "x");
  fs.mkdirSync(path.join(tgt, "node_modules", "junk"), { recursive: true });
  fs.writeFileSync(path.join(tgt, "node_modules", "junk", "index.js"), "x");
  fs.mkdirSync(path.join(tgt, ".git"), { recursive: true });
  fs.writeFileSync(path.join(tgt, ".git", "HEAD"), "ref: x");
  // a directory with 250 children → must fold beyond MAX_CHILDREN(200)
  const big = path.join(tgt, "skills", "big");
  fs.mkdirSync(big, { recursive: true });
  for (let i = 0; i < 250; i++) fs.writeFileSync(path.join(big, `f${i}.txt`), "x");

  const report = buildHeatmap(cfgFor(home, target(home, tgt)), { window: "all", fullTree: true });
  const root = report.targets[0].root;

  // exclusions
  assert.ok(!find(root, (n) => n.name === "node_modules"), "node_modules excluded");
  assert.ok(!find(root, (n) => n.name === ".git"), ".git excluded");
  assert.ok(find(root, (n) => n.name === "eye-on"), "normal dir present via fs walk");

  // folding
  const bigNode = find(root, (n) => n.name === "big")!;
  assert.ok(bigNode.truncated, "over-full dir marked truncated");
  assert.ok((bigNode.children || []).some((c) => c.name.startsWith("…")), "a '…(已折叠 N 项)' node is present");
  assert.ok((bigNode.children || []).length <= 201, "kept children capped at MAX_CHILDREN(+1 collapse)");

  // global bounds honored
  assert.ok(report.limits.node_count <= report.limits.max_nodes, "node_count within MAX_NODES");
});

test("depth cap: a pathologically deep path folds into its MAX_DEPTH ancestor (heat kept), no explosion", () => {
  const home = mktmp("ol-hm-deep-");
  // 10-segment path (mirrors the on-site malformed 73-segment ticket)
  seed(home, [{ file: "skills/a/b/c/d/e/f/g/h/deep.md" }]);
  const report = buildHeatmap(cfgFor(home, target(home, home)), { window: "all", fullTree: false });
  const root = report.targets[0].root;
  let maxDepth = 0;
  walkNodes(root, (n) => { if (n.depth > maxDepth) maxDepth = n.depth; });
  assert.ok(maxDepth <= report.limits.max_depth, `tree depth ${maxDepth} <= MAX_DEPTH ${report.limits.max_depth}`);
  assert.equal(root.change_count, 1, "the deep change's heat is still counted (folded, not lost)");
  assert.ok(find(root, (n) => n.truncated), "a node is marked truncated where the deep path was folded");
});

test("missing/empty target is a safe no-op (hermes not present) — empty tree, no crash", () => {
  const home = mktmp("ol-hm-hermes-");
  const missing = path.join(os.tmpdir(), "definitely-not-here-" + "xyz");
  const tgt: Target = { system: "hermes", home: missing, watch: ["skills"], git: false, ignore: [] };
  const report = buildHeatmap(cfgFor(home, tgt), { window: "all", fullTree: true });
  assert.equal(report.targets.length, 1);
  const root = report.targets[0].root;
  assert.equal(root.change_count, 0, "no tickets, no fs → zero heat");
  assert.deepEqual(root.children, [], "empty tree, not a crash");
});
