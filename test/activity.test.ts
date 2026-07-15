// Activity log tests (Phase 1.7 feature A): per-day aggregation with MIXED-
// timezone tickets bucketing to one LOCAL day, folder rollups + plain-language
// summary, upstream counting, and the逐条 day detail carrying NO file content.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "../src/core/ledger.ts";
import { loadActivity, loadActivityDay, rollupKey, remoteShort } from "../src/dashboard/activity.ts";
import { localDay } from "../src/util.ts";
import type { Op, Provenance, Ticket } from "../src/types.ts";

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function seed(home: string, rows: Array<Partial<Ticket> & { file: string; op: Op; created_at: string }>): void {
  const ledger = new Ledger(home);
  for (const r of rows) {
    ledger.append({
      change_id: ledger.nextChangeId(),
      system: r.system ?? "openclaw",
      source: "out-of-band",
      author: { type: "unknown", id: null, verified: false },
      session_id: null,
      origin: null,
      file: r.file,
      op: r.op,
      before_hash: null,
      after_hash: "sha256:x",
      reason: r.reason ?? null,
      severity: "high",
      status: "observed",
      git_commit: null,
      prev_ticket_hash: "",
      created_at: r.created_at,
      ...(r.provenance ? { provenance: r.provenance } : {}),
    } as Ticket);
  }
}

const pull = (remote: string): Provenance => ({
  kind: "pull", repo_root: "/r", remote_url: remote, branch: "main",
  from_commit: "a", to_commit: "b", verified: true,
});

test("rollupKey: skill → skills/<name>; top-level folder → first segment; trailing slash tolerated", () => {
  assert.equal(rollupKey("skills/eye-on/SKILL.md"), "skills/eye-on");
  assert.equal(rollupKey("agents/AGENTS.md"), "agents");
  assert.equal(rollupKey("skills/bondie-monorepo-push/"), "skills/bondie-monorepo-push");
  assert.equal(rollupKey("cron/jobs.json"), "cron");
});

test("remoteShort: strips host + .git → short repo name", () => {
  assert.equal(remoteShort("https://github.com/fyaic/bondie-eye-on.git"), "bondie-eye-on");
  assert.equal(remoteShort("https://github.com/fyaic/Bondie"), "Bondie");
  assert.equal(remoteShort(null), null);
});

test("mixed-timezone tickets bucket into ONE local day (util.localDay is the single source)", () => {
  const home = mktmp("ol-act-tz-");
  // SAME instant, expressed with a +08:00 offset and as UTC — must land on the
  // same local calendar day regardless of the machine's timezone.
  const tsPlus8 = "2026-05-14T08:00:00+08:00";
  const tsUtc = "2026-05-14T00:00:00Z"; // identical instant
  assert.equal(localDay(tsPlus8), localDay(tsUtc), "same instant → same local day");
  seed(home, [
    { file: "skills/eye-on/SKILL.md", op: "update", created_at: tsPlus8 },
    { file: "skills/eye-on/board.md", op: "create", created_at: tsUtc },
  ]);
  const act = loadActivity("all", home);
  assert.equal(act.days.length, 1, "both tickets fall on one local day");
  assert.equal(act.days[0].date, localDay(tsPlus8), "day is the local-day bucket");
  assert.equal(act.days[0].total, 2);
  assert.equal(act.days[0].created, 1);
  assert.equal(act.days[0].updated, 1);
});

test("folder rollup + plain-language summary reflect op counts", () => {
  const home = mktmp("ol-act-roll-");
  seed(home, [
    { file: "skills/eye-on/a.md", op: "update", created_at: "2026-05-14T10:00:00+08:00" },
    { file: "skills/eye-on/b.md", op: "update", created_at: "2026-05-14T11:00:00+08:00" },
    { file: "skills/eye-on/c.md", op: "update", created_at: "2026-05-14T12:00:00+08:00" },
    { file: "skills/team-management/x.md", op: "create", created_at: "2026-05-14T13:00:00+08:00" },
    { file: "skills/team-management/y.md", op: "create", created_at: "2026-05-14T14:00:00+08:00" },
  ]);
  const day = loadActivity("all", home).days[0];
  const eye = day.rollups.find((r) => r.key === "skills/eye-on");
  const team = day.rollups.find((r) => r.key === "skills/team-management");
  assert.equal(eye!.updated, 3);
  assert.equal(team!.created, 2);
  // summary is Chinese plain language, one clause per rollup, dominant op
  assert.ok(day.summary.some((s) => s.includes("eye-on 技能更新 3 处")), `got: ${day.summary.join(" | ")}`);
  assert.ok(day.summary.some((s) => s.includes("team-management 技能新增 2 文件")), `got: ${day.summary.join(" | ")}`);
});

test("upstream events counted and surfaced in summary (从 <remote> 拉取)", () => {
  const home = mktmp("ol-act-up-");
  seed(home, [
    { file: "skills/eye-on/SKILL.md", op: "update", created_at: "2026-06-24T10:00:00+08:00", provenance: pull("https://github.com/fyaic/Bondie.git") },
    { file: "skills/eye-on/board.md", op: "update", created_at: "2026-06-24T11:00:00+08:00", provenance: pull("https://github.com/fyaic/Bondie.git") },
    { file: "skills/eye-on/note.md", op: "update", created_at: "2026-06-24T12:00:00+08:00" }, // agent edit, no upstream
  ]);
  const day = loadActivity("all", home).days[0];
  assert.equal(day.upstream_events, 2, "two pull tickets counted as upstream");
  const eye = day.rollups.find((r) => r.key === "skills/eye-on");
  assert.equal(eye!.upstream, 2);
  assert.equal(eye!.remote_short, "Bondie", "single upstream source → short remote name");
  assert.ok(day.summary.some((s) => s.includes("从 Bondie 拉取更新 2 次")), `got: ${day.summary.join(" | ")}`);
});

test("day detail reuses the card model and carries NO file content/diff field", () => {
  const home = mktmp("ol-act-day-");
  seed(home, [
    { file: "skills/eye-on/SKILL.md", op: "update", created_at: "2026-05-14T10:00:00+08:00", reason: "git: tune eye-on prompt" },
  ]);
  const date = localDay("2026-05-14T10:00:00+08:00");
  const detail = loadActivityDay(date, home);
  assert.equal(detail.items.length, 1);
  const item = detail.items[0];
  // A-posture: path / op / reason(commit subject) allowed; content/diff/body NOT present
  assert.equal(item.file, "skills/eye-on/SKILL.md");
  assert.equal(item.reason, "git: tune eye-on prompt");
  const json = JSON.stringify(detail);
  for (const forbidden of ['"content":', '"diff":', '"body":', '"patch":']) {
    assert.ok(!json.includes(forbidden), `day detail must not carry ${forbidden}`);
  }
});

test("empty ledger → no days, no crash", () => {
  const home = mktmp("ol-act-empty-");
  new Ledger(home); // creates nothing
  const act = loadActivity("all", home);
  assert.deepEqual(act.days, []);
});
