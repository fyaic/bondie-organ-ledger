// Onboarding-refresh tests (Phase 1.9): the init "prime dashboard state" step
// (generates provenance.json + heatmap.json), its non-fatal guarantee, idempotent
// re-run, and the doctor attribution/readiness sections (present + honest wording).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { runInit } from "../src/onboard/init.ts";
import { runDoctor } from "../src/onboard/doctor.ts";
import { paths } from "../src/util.ts";

function mktmp(p: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

// throwaway git target with one organ file so provenance has a source and the
// ledger has a backfilled ticket (→ heatmap has nodes).
function makeOrganRepo(): string {
  const dir = mktmp("ol-rf-organ-");
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  execFileSync("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
  execFileSync("git", ["-C", dir, "config", "core.autocrlf", "false"]);
  fs.mkdirSync(path.join(dir, "skills", "note"), { recursive: true });
  fs.writeFileSync(path.join(dir, "skills", "note", "SKILL.md"), "hello\nworld\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  return dir;
}

test("init prime: generates state/provenance.json + state/heatmap.json (views full on first open)", () => {
  const home = mktmp("ol-rf-home-");
  const organ = makeOrganRepo();
  const res = runInit({ home, yes: true, openclaw: organ, noSnapshot: true });

  const p = paths(home);
  assert.ok(fs.existsSync(p.provenance), "state/provenance.json created");
  assert.ok(fs.existsSync(p.heatmap), "state/heatmap.json created");
  // structurally valid per existing types
  const prov = JSON.parse(fs.readFileSync(p.provenance, "utf8"));
  assert.ok(Array.isArray(prov.targets), "provenance.targets is an array");
  const hm = JSON.parse(fs.readFileSync(p.heatmap, "utf8"));
  assert.ok(hm.limits && typeof hm.limits.node_count === "number", "heatmap has limits.node_count");
  // the prime step reported readiness in the init log
  assert.ok(res.lines.some((l) => l.includes("[6/8] Prime dashboard state")), "prime step numbered [6/8]");
  assert.ok(res.lines.some((l) => l.includes("views ready")), "prime reported views ready");
  assert.ok(res.lines.some((l) => l.includes("[8/8] Done")), "onboard reached [8/8] Done");
});

test("init prime: NON-FATAL — a prime write failure does not fail onboarding", () => {
  const home = mktmp("ol-rf-home-");
  const organ = makeOrganRepo();
  // sabotage: pre-create state/provenance.json as a DIRECTORY so writeFileSync throws.
  fs.mkdirSync(path.join(home, "state", "provenance.json"), { recursive: true });

  let threw = false;
  let res: { lines: string[] } | null = null;
  try {
    res = runInit({ home, yes: true, openclaw: organ, noSnapshot: true });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "runInit must NOT throw when prime fails");
  assert.ok(res!.lines.some((l) => l.includes("prime skipped (non-fatal)")), "prime failure reported as non-fatal");
  assert.ok(res!.lines.some((l) => l.includes("[8/8] Done")), "onboard still completed");
});

test("init prime: --no-prime skips generation cleanly", () => {
  const home = mktmp("ol-rf-home-");
  const organ = makeOrganRepo();
  const res = runInit({ home, yes: true, openclaw: organ, noSnapshot: true, noPrime: true });
  assert.ok(res.lines.some((l) => l.includes("[6/8] Prime dashboard state")));
  assert.ok(res.lines.some((l) => l.includes("skipped (--no-prime)")), "reported --no-prime skip");
  assert.equal(fs.existsSync(paths(home).heatmap), false, "no heatmap.json when primed off");
});

test("init: idempotent re-run refreshes state + revisit note + chain intact", () => {
  const home = mktmp("ol-rf-home-");
  const organ = makeOrganRepo();
  runInit({ home, yes: true, openclaw: organ, noSnapshot: true });
  const res2 = runInit({ home, yes: true, openclaw: organ, noSnapshot: true });
  assert.ok(res2.lines.some((l) => l.includes("既有安装已刷新")), "revisit note shown on re-run");
  assert.ok(res2.lines.some((l) => l.includes("chain: intact ✓")), "chain intact after re-run");
});

test("doctor: attribution + readiness sections present and HONEST (no proven/已证明 overclaim)", () => {
  const home = mktmp("ol-rf-home-");
  const organ = makeOrganRepo();
  runInit({ home, yes: true, openclaw: organ, noSnapshot: true });

  const { lines } = runDoctor(home);
  const text = lines.join("\n");
  assert.ok(lines.some((l) => l.includes("[attribution]")), "attribution section present");
  assert.ok(lines.some((l) => l.includes("[readiness]")), "readiness overview present");
  assert.ok(text.includes("视图就绪"), "readiness line uses 视图就绪 overview");
  // engagement guidance for an un-wired home (no principal stream yet)
  assert.ok(text.includes("attribution NOT wired") || text.includes("un-instrumented"), "honest 未接入 guidance");
  // HONESTY: attested must never be presented as proof
  assert.ok(!/已证明|\bproven\b/i.test(text.replace(/provenance/gi, "")), "no proven/已证明 overclaim in doctor output");
  assert.ok(text.includes("非密码学证明") || text.includes("attested"), "attested qualified as non-cryptographic");
});

test("doctor: engaged path — a present principal stream reads as 归因 已接", () => {
  const home = mktmp("ol-rf-home-");
  const organ = makeOrganRepo();
  runInit({ home, yes: true, openclaw: organ, noSnapshot: true });
  // inject one attested im-user turn record
  const turns = paths(home).principalTurns;
  fs.mkdirSync(path.dirname(turns), { recursive: true });
  fs.writeFileSync(turns, JSON.stringify({
    turn_id: "wecom:m1", session_id: "s1", ts_start: "2026-07-14T22:00:00.000Z",
    principal: { kind: "im-user", channel: "wecom", id: "u1", display: "张三", verified: true, attestation: "platform-attested" },
  }) + "\n");

  const text = runDoctor(home).lines.join("\n");
  assert.ok(text.includes("attribution engaged"), "engaged wording when stream present");
  assert.ok(text.includes("归因 已接"), "readiness shows 归因 已接");
});
