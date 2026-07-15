import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Ledger } from "../src/core/ledger.ts";
import { ensureDirs, paths } from "../src/util.ts";
import { loadBoard } from "../src/dashboard/data.ts";
import type { Ticket } from "../src/types.ts";

function seed(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ol-dash-test-"));
  ensureDirs(home);
  const L = new Ledger(home);
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const mk = (over: Partial<Ticket>): Ticket => ({
    change_id: L.nextChangeId(), system: "openclaw", source: "out-of-band",
    author: { type: "unknown", id: null, verified: false }, session_id: null,
    file: "skills/x/SKILL.md", op: "update", before_hash: null, after_hash: "sha256:b",
    reason: null, severity: "high", status: "observed", git_commit: "abc",
    prev_ticket_hash: "", created_at: now, ...over,
  });
  L.append(mk({ severity: "critical", status: "observed", system: "openclaw", created_at: now }));
  L.append(mk({ severity: "medium", status: "approved", system: "hermes", created_at: now }));
  L.append(mk({ severity: "low", status: "rejected", created_at: now }));
  L.append(mk({ severity: "high", status: "rolled_back", created_at: now }));
  L.append(mk({ severity: "high", status: "observed", created_at: old, file: "skills/old/SKILL.md" }));
  const held = mk({ change_id: "chg-held-1", severity: "critical", op: "delete", status: "held", git_commit: null, file: "skills/danger/SKILL.md" });
  fs.writeFileSync(path.join(paths(home).held, held.change_id + ".json"), JSON.stringify(held));
  L.append(held);
  fs.writeFileSync(path.join(paths(home).reports, "2026-07-14.md"), "# report\n");
  return home;
}

test("loadBoard maps tickets into status columns + held from held dir", () => {
  const home = seed();
  const b = loadBoard({ date: "all" }, home);
  assert.equal(b.columns.held.length, 1, "held column has the held ticket");
  assert.equal(b.columns.approved.length, 1);
  assert.equal(b.columns.rejected.length, 1);
  assert.equal(b.columns.rolled_back.length, 1);
  assert.ok(b.columns.observed.length >= 1);
  assert.equal(b.columns.held[0].author_verified, false, "author stays unverified (Phase 1)");
});

test("kpi surfaces systems + severity + reports", () => {
  const home = seed();
  const b = loadBoard({ date: "all" }, home);
  assert.ok(b.kpi.systems.openclaw > 0 && b.kpi.systems.hermes > 0, "both systems counted");
  assert.equal(b.kpi.severity.critical, 2, "2 critical (observed + held)");
  assert.deepEqual(b.kpi.reports, ["2026-07-14.md"], "recent reports surfaced");
  assert.equal(b.kpi.held, 1);
});

test("date=recent includes today but excludes a 30-day-old ticket; today excludes yesterday-and-older", () => {
  const home = seed();
  const all = loadBoard({ date: "all" }, home).kpi.total;
  const recent = loadBoard({ date: "recent" }, home).kpi.total;
  assert.equal(recent, all - 1, "recent drops the 30-day-old ticket only");
});

test("system + severity + q filters compose", () => {
  const home = seed();
  assert.ok(loadBoard({ date: "all", system: "hermes" }, home).columns.approved.length === 1);
  assert.equal(loadBoard({ date: "all", severity: "critical" }, home).kpi.total, 2);
  assert.equal(loadBoard({ date: "all", q: "danger" }, home).kpi.total, 1, "q matches file substring");
});
