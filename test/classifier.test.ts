// Unit tests: glob severity mapping, rewrite-ratio escalation, gate decisions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/core/classifier.ts";
import { gate } from "../src/core/gate.ts";
import type { Config } from "../src/types.ts";

const cfg: Config = {
  ledger_home: ".",
  targets: [],
  severity_rules: [
    { glob: "skills/**", severity: "high", delete_gate: "held" },
    { glob: "agents/**", severity: "high", rewrite_ratio_critical: 0.5 },
    { glob: "cron/**", severity: "high" },
    { glob: "memory/**", severity: "medium" },
    { glob: "tasks/**", severity: "low" },
  ],
  rewrite_ratio_critical: 0.5,
  debounce_ms: 10,
  session_squash_ms: 100,
  gate: { default: "observe", held_on: ["critical", "delete"] },
};

test("path → severity mapping (first match wins)", () => {
  assert.equal(classify({ path: "skills/note/SKILL.md", op: "update" }, cfg).severity, "high");
  assert.equal(classify({ path: "memory/MEMORY.md", op: "update" }, cfg).severity, "medium");
  assert.equal(classify({ path: "tasks/runs/x.json", op: "update" }, cfg).severity, "low");
  assert.equal(classify({ path: "cron/jobs.json", op: "update" }, cfg).severity, "high");
  // unmatched → low fallback
  assert.equal(classify({ path: "random/thing.txt", op: "update" }, cfg).severity, "low");
});

test("large-rewrite escalation to critical (>50% lines deleted)", () => {
  const before = Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n");
  const after = "l0\nl1\n"; // 100 → 2
  const r = classify({ path: "agents/AGENTS.md", op: "update", beforeText: before, afterText: after }, cfg);
  assert.equal(r.severity, "critical");
  assert.equal(r.escalated, true);
});

test("small edit does NOT escalate", () => {
  const before = Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n");
  const after = Array.from({ length: 95 }, (_, i) => `l${i}`).join("\n"); // 5% removed
  const r = classify({ path: "agents/AGENTS.md", op: "update", beforeText: before, afterText: after }, cfg);
  assert.equal(r.severity, "high");
  assert.equal(r.escalated, false);
});

test("gate: default observe; critical & delete → held", () => {
  assert.equal(gate("high", "update", cfg).status, "observed");
  assert.equal(gate("medium", "create", cfg).status, "observed");
  assert.equal(gate("critical", "update", cfg).status, "held");
  assert.equal(gate("high", "delete", cfg).status, "held");
  assert.equal(gate("low", "delete", cfg).status, "held"); // any delete held
});
