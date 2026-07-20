// Phase 2.1 — host-log writer attribution (C-tier: absolute path + ±time window).
// Locks the honest boundary: EVERY match here is WEAK (verified stays false, the
// principal red line from attribution.test.ts is untouched), path normalization is
// cross-platform, parsers tolerate garbage, and the four WriterIndex verdicts +
// missing-log degradation behave exactly per 03/04.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonPath, loadConfig } from "../src/util.ts";

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---- P1: canonPath (the JOIN key) ------------------------------------------
test("canonPath: slash + drive-letter normalize; win32 case-insensitive, posix case-sensitive", () => {
  if (process.platform === "win32") {
    assert.equal(canonPath("C:\\a\\B"), canonPath("C:/a/b"), "win32: backslash/case collapse to one key");
    assert.equal(canonPath("c:/Users/Ryshi/x.md"), "c:/users/ryshi/x.md");
  } else {
    // posix: never lower — /Users/Ryshi ≠ /users/ryshi
    assert.notEqual(canonPath("/Users/Ryshi/x"), canonPath("/users/ryshi/x"));
    assert.equal(canonPath("/a/b/"), "/a/b", "trailing slash dropped");
  }
  assert.equal(canonPath("/a/b/"), process.platform === "win32" ? "/a/b" : "/a/b", "trailing slash dropped both platforms");
});

// ---- P1: v1 config (no writer_index) still loads ---------------------------
test("config: a v1 config.json with no writer_index still loads (all-optional, additive)", () => {
  const home = mktmp("ol-wcfg-");
  const cfg = {
    ledger_home: home,
    targets: [], severity_rules: [], rewrite_ratio_critical: 0.5,
    debounce_ms: 5, session_squash_ms: 10,
    gate: { default: "observe", held_on: ["critical"] },
  };
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(cfg));
  const loaded = loadConfig(home);
  assert.equal(loaded.writer_index, undefined, "no writer_index key ⇒ undefined, no crash");
  assert.equal(loaded.debounce_ms, 5);
});

// ---- P2: parsers (fixed real-shape fixtures — never read live logs) ---------
import { parseClaude } from "../src/adapters/hostlogs/claude.ts";
import { parseCodex } from "../src/adapters/hostlogs/codex.ts";
import { parseKimi, classifyKimiWd, kimiSource } from "../src/adapters/hostlogs/kimi.ts";

test("parseClaude: tool_use Write/Edit/MultiEdit → {claude-code, dev, canonPath abs, tsMs, ref}", () => {
  // real shape (P-1 sample): backslash absolute path, tool_use in message.content[]
  const line = JSON.stringify({
    timestamp: "2026-07-15T01:50:35.620Z",
    message: { content: [
      { type: "text", text: "ok" },
      { type: "tool_use", name: "Write", id: "toolu_01U5", input: { file_path: "C:\\Users\\ryshi\\Documents\\x\\INIT.md", content: "hi" } },
    ] },
  });
  const recs = parseClaude(line + "\n", "claude.jsonl");
  assert.equal(recs.length, 1);
  assert.equal(recs[0].source, "claude-code");
  assert.equal(recs[0].actor_class, "dev");
  assert.equal(recs[0].absPath, canonPath("C:\\Users\\ryshi\\Documents\\x\\INIT.md"));
  assert.equal(recs[0].tsMs, Date.parse("2026-07-15T01:50:35.620Z"));
  assert.equal(recs[0].ref, "claude.jsonl#toolu_01U5");
  // non-write tool_use (Read/Bash) produces nothing
  const noise = JSON.stringify({ timestamp: "2026-07-15T01:50:00.000Z", message: { content: [{ type: "tool_use", name: "Bash", id: "b1", input: { command: "ls" } }] } });
  assert.equal(parseClaude(noise, "c").length, 0);
});

test("parseKimi: tool.call Write → {source by actor_class, canonPath, top-level time epoch ms}", () => {
  const line = JSON.stringify({
    type: "context.append_loop_event",
    event: { type: "tool.call", name: "Edit", toolCallId: "tool_xyz", args: { path: "C:/Hello-World/organledger/README.md", old_string: "a", new_string: "b" } },
    time: 1784169951034,
  });
  const dev = parseKimi(line, "wire.jsonl", "dev");
  assert.equal(dev.length, 1);
  assert.equal(dev[0].source, "kimi-code");
  assert.equal(dev[0].actor_class, "dev");
  assert.equal(dev[0].absPath, canonPath("C:/Hello-World/organledger/README.md"));
  assert.equal(dev[0].tsMs, 1784169951034);
  assert.equal(dev[0].ref, "wire.jsonl#tool_xyz");
  // same line classified as agent (hermes bucket) → source flips, path unchanged
  const agent = parseKimi(line, "wire.jsonl", "agent");
  assert.equal(agent[0].source, "hermes");
  assert.equal(agent[0].actor_class, "agent");
  // a non-tool.call loop event (step.begin) yields nothing
  assert.equal(parseKimi(JSON.stringify({ type: "context.append_loop_event", event: { type: "step.begin" }, time: 1 }), "w", "dev").length, 0);
});

test("classifyKimiWd: wd_hermes_* → agent; others → dev; wdActorMap prefix override", () => {
  assert.equal(classifyKimiWd("wd_hermes_37aa57e34be5"), "agent");
  assert.equal(classifyKimiWd("wd_organledger_2c54befa4283"), "dev");
  assert.equal(classifyKimiWd("wd_openclaw_abc", { "wd_openclaw_": "agent" }), "agent", "config override adds a new agent bucket");
  assert.equal(kimiSource("agent"), "hermes");
  assert.equal(kimiSource("dev"), "kimi-code");
});

test("parseCodex: apply_patch multi-file → one record per file; relative resolves to cwd, absolute stays", () => {
  const meta = JSON.stringify({ type: "session_meta", timestamp: "2026-05-19T07:00:00.000Z", payload: { cwd: "C:\\Users\\ryshi", originator: "codex-tui" } });
  const patch = "*** Begin Patch\n*** Update File: docs\\a.md\n@@\n-x\n+y\n*** Add File: C:\\Users\\ryshi\\b.md\n+new\n*** End Patch";
  const call = JSON.stringify({ type: "response_item", timestamp: "2026-05-19T07:30:27.149Z", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "call_gb", input: patch } });
  const recs = parseCodex(meta + "\n" + call + "\n", "rollout.jsonl");
  assert.equal(recs.length, 2, "two *** File: lines → two records");
  assert.equal(recs[0].source, "codex");
  assert.equal(recs[0].actor_class, "dev");
  // relative "docs\a.md" resolved against cwd C:\Users\ryshi
  assert.equal(recs[0].absPath, canonPath(path.resolve("C:\\Users\\ryshi", "docs\\a.md")));
  // absolute path preserved (resolve leaves it intact)
  assert.equal(recs[1].absPath, canonPath("C:\\Users\\ryshi\\b.md"));
  assert.equal(recs[0].tsMs, recs[1].tsMs, "same apply_patch → shared tsMs");
  assert.equal(recs[0].tsMs, Date.parse("2026-05-19T07:30:27.149Z"));
});

// ---- P2: resilience — garbage / empty / missing fields never throw ----------
test("parsers: torn/garbage/empty lines are skipped, never thrown", () => {
  const junk = "not json\n\n{ half\n" + JSON.stringify({ nope: 1 }) + "\n";
  assert.deepEqual(parseClaude(junk, "c"), []);
  assert.deepEqual(parseKimi(junk, "k", "dev"), []);
  assert.deepEqual(parseCodex(junk, "x"), []);
  // missing timestamp / path → skipped
  assert.deepEqual(parseClaude(JSON.stringify({ message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "C:/a" } }] } }), "c"), [], "no timestamp → skip");
  assert.deepEqual(parseKimi(JSON.stringify({ type: "context.append_loop_event", event: { type: "tool.call", name: "Write", args: {} }, time: 1 }), "k", "dev"), [], "no path → skip");
});

// ---- P3: WriterIndex — four verdicts + window boundary + degrade + tail ------
import { WriterIndex } from "../src/core/writer-index.ts";

const T0 = 1784169951034; // fixed epoch base

interface Layout { root: string; claudeProjects: string; codex: string; kimiSessions: string; organHermes: string; organOpenclaw: string; }
function layout(): Layout {
  const root = mktmp("ol-widx-");
  const claudeProjects = path.join(root, "claude", "projects", "enc");
  const codex = path.join(root, "codex");
  const kimiSessions = path.join(root, "kimi");
  const organHermes = path.join(root, "organ", "hermes");
  const organOpenclaw = path.join(root, "organ", "openclaw");
  for (const d of [claudeProjects, path.join(codex, "sessions"), kimiSessions, organHermes, organOpenclaw]) fs.mkdirSync(d, { recursive: true });
  return { root, claudeProjects, codex, kimiSessions, organHermes, organOpenclaw };
}
function claudeWrite(absPath: string, tsIso: string, id = "toolu_1"): string {
  return JSON.stringify({ timestamp: tsIso, message: { content: [{ type: "tool_use", name: "Write", id, input: { file_path: absPath, content: "x" } }] } }) + "\n";
}
function kimiWrite(absPath: string, tsMs: number, id = "tool_1"): string {
  return JSON.stringify({ type: "context.append_loop_event", event: { type: "tool.call", name: "Write", toolCallId: id, args: { path: absPath, content: "x" } }, time: tsMs }) + "\n";
}
function writeKimiWire(kimiRoot: string, wdSlug: string, agentName: string, body: string): string {
  const dir = path.join(kimiRoot, wdSlug, "session_1", "agents", agentName);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "wire.jsonl");
  fs.writeFileSync(f, body);
  return f;
}
function mkIndex(L: Layout, over: Partial<ConstructorParameters<typeof WriterIndex>[0]> = {}): WriterIndex {
  return new WriterIndex({
    roots: { claudeProjects: L.claudeProjects, codex: L.codex, kimiSessions: L.kimiSessions },
    organRoots: [{ system: "hermes", home: L.organHermes }, { system: "openclaw", home: L.organOpenclaw }],
    windowMs: 90_000, eliminationOn: true, ...over,
  });
}

test("WriterIndex dev-log: a Claude write claims the path → writer:local, local dev evidence (weak)", () => {
  const L = layout();
  const P = "C:/Hello-World/organledger/skills/x/SKILL.md";
  fs.writeFileSync(path.join(L.claudeProjects, "s.jsonl"), claudeWrite(P.replace(/\//g, "\\"), new Date(T0).toISOString()));
  const idx = mkIndex(L); idx.refresh();
  const r = idx.matchOutOfBand(P, T0 + 10_000);
  assert.equal(r.match, "dev-log");
  assert.equal(r.writer, "local");
  assert.equal(r.principalKind, "local");
  assert.equal(r.evidence?.source, "claude-code");
  assert.equal(r.evidence?.actor_class, "dev");
  assert.equal(r.evidence?.matched_by, "path+time");
  assert.equal(r.evidence?.delta_ms, 10_000);
});

test("WriterIndex agent-log: a Kimi wd_hermes write claims the path → writer:agent-runtime, autonomy self", () => {
  const L = layout();
  const P = "C:/Users/ryshi/AppData/Local/hermes/memory/note.md";
  writeKimiWire(L.kimiSessions, "wd_hermes_abc", "main", kimiWrite(P, T0));
  const idx = mkIndex(L); idx.refresh();
  const r = idx.matchOutOfBand(P, T0 + 500);
  assert.equal(r.match, "agent-log");
  assert.equal(r.writer, "agent-runtime");
  assert.equal(r.principalKind, "autonomous");
  assert.equal(r.autonomy, "self");
  assert.equal(r.evidence?.source, "hermes");
  assert.equal(r.evidence?.actor_class, "agent");
});

test("WriterIndex sub-agent wire (agents/agent-3) is scanned, inheriting the wd bucket's actor_class", () => {
  const L = layout();
  const P = "C:/Users/ryshi/AppData/Local/hermes/skills/y.md";
  writeKimiWire(L.kimiSessions, "wd_hermes_abc", "agent-3", kimiWrite(P, T0)); // sub-agent, not main
  const idx = mkIndex(L); idx.refresh();
  assert.equal(idx.matchOutOfBand(P, T0).match, "agent-log", "sub-agent write still counts as the hermes agent");
});

test("WriterIndex ambiguous: DEV + AGENT both claim the path in-window → stays local, records both rivals", () => {
  const L = layout();
  const P = "C:/Users/ryshi/AppData/Local/hermes/memory/contended.md";
  fs.writeFileSync(path.join(L.claudeProjects, "s.jsonl"), claudeWrite(P.replace(/\//g, "\\"), new Date(T0).toISOString()));
  writeKimiWire(L.kimiSessions, "wd_hermes_abc", "main", kimiWrite(P, T0 + 2000));
  const idx = mkIndex(L); idx.refresh();
  const r = idx.matchOutOfBand(P, T0 + 1000);
  assert.equal(r.match, "ambiguous");
  assert.equal(r.writer, "local", "contention → never guess,退回 local");
  assert.equal(r.principalKind, "local");
  assert.equal(r.evidence?.rivals?.length, 2);
  assert.deepEqual(new Set(r.evidence?.rivals?.map((x) => x.actor_class)), new Set(["dev", "agent"]));
});

test("WriterIndex elimination: no log claims it, path in organ root → weak agent (on); off → none", () => {
  const L = layout();
  const P = path.join(L.organOpenclaw, "workspace", "memory", "self-edit.md");
  const on = mkIndex(L); on.refresh();
  const r = on.matchOutOfBand(P, T0);
  assert.equal(r.match, "elimination");
  assert.equal(r.writer, "agent-runtime");
  assert.equal(r.autonomy, "unknown");
  assert.equal(r.evidence?.source, "openclaw");
  assert.equal(r.evidence?.delta_ms, undefined, "no positive match → NO fake delta");
  assert.ok(r.evidence?.note?.includes("weak inference"));
  // same write OUTSIDE any organ root → none (not our governance object)
  assert.equal(on.matchOutOfBand("C:/Hello-World/organledger/src/x.ts", T0).match, "none");
  // elimination disabled → falls back to none even inside organ root
  const off = mkIndex(L, { eliminationOn: false }); off.refresh();
  assert.equal(off.matchOutOfBand(P, T0).match, "none");
});

test("WriterIndex window boundary: Δt = W hits, Δt = W+1 misses", () => {
  const L = layout();
  const P = "C:/Hello-World/organledger/w.md";
  fs.writeFileSync(path.join(L.claudeProjects, "s.jsonl"), claudeWrite(P.replace(/\//g, "\\"), new Date(T0).toISOString()));
  const idx = mkIndex(L, { windowMs: 1000 }); idx.refresh();
  assert.equal(idx.matchOutOfBand(P, T0 + 1000).match, "dev-log", "Δt == W → hit");
  assert.equal(idx.matchOutOfBand(P, T0 + 1001).match, "none", "Δt == W+1 → miss");
});

test("WriterIndex degrade: missing roots → empty, no crash, every match is none/elimination-only", () => {
  const root = mktmp("ol-widx-empty-");
  const idx = new WriterIndex({
    roots: { claudeProjects: path.join(root, "nope1"), codex: path.join(root, "nope2"), kimiSessions: path.join(root, "nope3") },
    organRoots: [], windowMs: 90_000,
  });
  idx.refresh(); // must not throw
  assert.equal(idx.size(), 0);
  assert.equal(idx.matchOutOfBand("C:/anything.md", T0).match, "none");
});

test("WriterIndex tail: appended write is picked up on the next refresh (incremental)", () => {
  const L = layout();
  const P1 = "C:/Hello-World/organledger/a.md";
  const P2 = "C:/Hello-World/organledger/b.md";
  const f = path.join(L.claudeProjects, "s.jsonl");
  fs.writeFileSync(f, claudeWrite(P1.replace(/\//g, "\\"), new Date(T0).toISOString(), "id1"));
  const idx = mkIndex(L); idx.refresh();
  assert.equal(idx.matchOutOfBand(P1, T0).match, "dev-log");
  assert.equal(idx.matchOutOfBand(P2, T0).match, "none");
  fs.appendFileSync(f, claudeWrite(P2.replace(/\//g, "\\"), new Date(T0).toISOString(), "id2"));
  idx.refresh(); // reads only the appended bytes
  assert.equal(idx.matchOutOfBand(P2, T0).match, "dev-log", "tail picked up the appended write");
});

test("WriterIndex codex: cwd from session_meta resolves a later relative apply_patch across the tail", () => {
  const L = layout();
  const f = path.join(L.codex, "archived_sessions", "rollout-x.jsonl");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const meta = JSON.stringify({ type: "session_meta", timestamp: new Date(T0).toISOString(), payload: { cwd: "C:\\Hello-World\\organledger" } });
  fs.writeFileSync(f, meta + "\n");
  const idx = mkIndex(L); idx.refresh(); // consumes only the session_meta line first
  const patch = "*** Begin Patch\n*** Update File: docs\\rel.md\n@@\n-a\n+b\n*** End Patch";
  fs.appendFileSync(f, JSON.stringify({ type: "response_item", timestamp: new Date(T0).toISOString(), payload: { type: "custom_tool_call", name: "apply_patch", call_id: "c1", input: patch } }) + "\n");
  idx.refresh(); // cwd must survive from the earlier refresh to resolve the relative path
  const P = path.resolve("C:\\Hello-World\\organledger", "docs\\rel.md");
  assert.equal(idx.matchOutOfBand(P, T0).match, "dev-log", "relative patch path resolved via cwd carried across refreshes");
});

// ---- P4: normalizer out-of-band branch (the接入 point) ----------------------
import { resolveAttribution, normalize } from "../src/core/normalizer.ts";
import { Ledger } from "../src/core/ledger.ts";
import type { OrganEvent, Target } from "../src/types.ts";

function oobEvt(absPath: string, tsMs: number, system: "hermes" | "openclaw" = "openclaw"): OrganEvent {
  return {
    event_id: "evt-oob", ts: new Date(tsMs).toISOString(), system, source: "out-of-band",
    path: "IGNORED-uses-absPath-arg", op: "update", before_hash: null, after_hash: "sha256:a",
    ctx: { session_id: null, origin: null, author_hint: null, reason: null, pid: 9, argv: null },
  };
}

test("P4 out-of-band + dev-log: writer stays local, local_writer:dev, weak evidence, verified FALSE", () => {
  const L = layout();
  const P = "C:/Users/ryshi/.openclaw/workspace/memory/note.md";
  fs.writeFileSync(path.join(L.claudeProjects, "s.jsonl"), claudeWrite(P.replace(/\//g, "\\"), new Date(T0).toISOString()));
  const wi = mkIndex(L); wi.refresh();
  const a = resolveAttribution(oobEvt(P, T0 + 5000), null, wi, P);
  assert.equal(a.writer, "local");
  assert.equal(a.local_writer, "dev");
  assert.equal(a.match, "dev-log");
  assert.equal(a.principal.kind, "local");
  assert.equal(a.principal.verified, false, "C-tier NEVER sets verified");
  assert.equal(a.writer_evidence?.source, "claude-code");
});

test("P4 out-of-band + agent-log/elimination: writer agent-runtime autonomous, verified FALSE", () => {
  const L = layout();
  // agent-log: hermes kimi write claims the path
  const P = "C:/Users/ryshi/AppData/Local/hermes/memory/self.md";
  writeKimiWire(L.kimiSessions, "wd_hermes_abc", "main", kimiWrite(P, T0));
  const wi = mkIndex(L); wi.refresh();
  const a = resolveAttribution(oobEvt(P, T0, "hermes"), null, wi, P);
  assert.equal(a.writer, "agent-runtime");
  assert.equal(a.principal.kind, "autonomous");
  assert.equal(a.autonomy, "self");
  assert.equal(a.match, "agent-log");
  assert.equal(a.principal.verified, false);

  // elimination: no log, path inside openclaw organ root
  const E = path.join(L.organOpenclaw, "workspace", "IDENTITY.md");
  const a2 = resolveAttribution(oobEvt(E, T0), null, wi, E);
  assert.equal(a2.writer, "agent-runtime");
  assert.equal(a2.autonomy, "unknown");
  assert.equal(a2.match, "elimination");
  assert.equal(a2.principal.verified, false);
  assert.equal(a2.writer_evidence?.delta_ms, undefined);
});

test("P4 out-of-band ambiguous stays local; and NO writerIndex → exact Phase 2 behavior (bypass)", () => {
  const L = layout();
  const P = path.join(L.organHermes, "contended.md").replace(/\\/g, "/");
  fs.writeFileSync(path.join(L.claudeProjects, "s.jsonl"), claudeWrite(P.replace(/\//g, "\\"), new Date(T0).toISOString()));
  writeKimiWire(L.kimiSessions, "wd_hermes_abc", "main", kimiWrite(P, T0 + 1000));
  const wi = mkIndex(L); wi.refresh();
  const amb = resolveAttribution(oobEvt(P, T0, "hermes"), null, wi, P);
  assert.equal(amb.match, "ambiguous");
  assert.equal(amb.writer, "local");
  assert.equal(amb.local_writer, undefined, "ambiguous is NOT labelled dev");
  assert.ok(amb.writer_evidence?.rivals?.length === 2);

  // bypass: writerIndex omitted → byte-identical to the pre-2.1 local/none result
  const base = resolveAttribution(oobEvt(P, T0, "hermes"), null);
  assert.deepEqual(base, { writer: "local", principal: base.principal, autonomy: "unknown", turn_id: null, match: "none" });
  assert.equal(base.local_writer, undefined);
  assert.equal(base.writer_evidence, undefined);
});

test("P4 in-band branch is UNTOUCHED even when a writerIndex is passed", () => {
  const L = layout(); const wi = mkIndex(L); wi.refresh();
  const inband: OrganEvent = {
    event_id: "e", ts: new Date(T0).toISOString(), system: "hermes", source: "in-band",
    path: "skills/x.md", op: "update", before_hash: null, after_hash: "sha256:a",
    ctx: { session_id: "sess-X", origin: null, author_hint: "agent", reason: null, pid: 1, argv: null },
  };
  // known session, no principal → autonomous/self, exactly as Phase 2 (writerIndex ignored)
  const a = resolveAttribution(inband, null, wi, path.join(L.organHermes, "skills/x.md"));
  assert.equal(a.writer, "agent-runtime");
  assert.equal(a.principal.kind, "autonomous");
  assert.equal(a.autonomy, "self");
  assert.equal(a.match, "none");
  assert.equal(a.local_writer, undefined, "in-band never carries local_writer");
  assert.equal(a.writer_evidence, undefined, "in-band never carries writer_evidence");
});

test("P4 normalize integration: out-of-band ticket carries local_writer/evidence; author.verified false; chain intact", () => {
  const L = layout();
  const ledgerHome = mktmp("ol-wnorm-");
  const ledger = new Ledger(ledgerHome);
  const target: Target = { system: "openclaw", home: L.organOpenclaw, watch: ["workspace"], git: false, ignore: [] };
  const rel = "workspace/memory/x.md";
  const abs = path.join(target.home, rel);
  fs.writeFileSync(path.join(L.claudeProjects, "s.jsonl"), claudeWrite(abs, new Date(T0).toISOString()));
  const wi = mkIndex(L); wi.refresh();
  const evt: OrganEvent = {
    event_id: "e1", ts: new Date(T0 + 3000).toISOString(), system: "openclaw", source: "out-of-band",
    path: rel, op: "update", before_hash: null, after_hash: "sha256:z",
    ctx: { session_id: null, origin: null, author_hint: null, reason: null, pid: 1, argv: null },
  };
  const { ticket } = normalize(evt, target, ledger, null, wi);
  assert.equal(ticket.attribution?.match, "dev-log");
  assert.equal(ticket.attribution?.local_writer, "dev");
  assert.equal(ticket.attribution?.writer_evidence?.matched_by, "path+time");
  assert.equal(ticket.attribution?.principal.verified, false);
  assert.equal(ticket.author.verified, false, "TicketAuthor.verified stays literal false");
  // chain stays intact once appended
  ledger.append(ticket);
  assert.equal(new Ledger(ledgerHome).verify().ok, true);
});

// ---- P5: board writer filter + stats byWriter (honest, no silent gaps) -------
import { loadBoard, buildAttributionStats, writerBucketOf, toCard } from "../src/dashboard/data.ts";
import type { Attribution, Ticket } from "../src/types.ts";

function wTicket(change_id: string, match: Attribution["match"], over: Partial<Attribution> = {}): Ticket {
  const isAgent = match === "agent-log" || match === "elimination";
  const attribution: Attribution = {
    writer: isAgent ? "agent-runtime" : "local",
    principal: isAgent
      ? { kind: "autonomous", channel: null, id: null, display: null, verified: false, attestation: "unverified" }
      : { kind: "local", channel: "local", id: null, display: null, verified: false, attestation: "unverified" },
    autonomy: match === "agent-log" ? "self" : "unknown",
    turn_id: null, match,
    ...(match === "dev-log" ? { local_writer: "dev" as const } : {}),
    ...over,
  };
  return {
    change_id, system: "openclaw", source: "out-of-band",
    author: { type: "unknown", id: null, verified: false }, session_id: null, origin: null,
    file: `workspace/${change_id}.md`, op: "update", before_hash: null, after_hash: "sha256:x",
    reason: null, severity: "low", status: "observed", git_commit: null,
    prev_ticket_hash: "", created_at: new Date(T0).toISOString(), attribution,
  };
}

function seedWriterBoard(): string {
  const home = mktmp("ol-wboard-");
  const file = path.join(home, "ledger", "tickets.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows: Ticket[] = [
    wTicket("chg-dev", "dev-log"),
    wTicket("chg-agent", "agent-log"),
    wTicket("chg-elim", "elimination"),
    wTicket("chg-amb", "ambiguous"),
    wTicket("chg-none", "none"),
    { ...wTicket("chg-noattr", "none"), attribution: undefined } as Ticket, // untagged → unrefined
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return home;
}

test("P5 writerBucketOf: match → bucket (dev / agent-autonomous incl elimination / ambiguous / unrefined)", () => {
  assert.equal(writerBucketOf(toCard(wTicket("a", "dev-log"))), "dev");
  assert.equal(writerBucketOf(toCard(wTicket("b", "agent-log"))), "agent-autonomous");
  assert.equal(writerBucketOf(toCard(wTicket("c", "elimination"))), "agent-autonomous");
  assert.equal(writerBucketOf(toCard(wTicket("d", "ambiguous"))), "ambiguous");
  assert.equal(writerBucketOf(toCard(wTicket("e", "none"))), "unrefined");
});

test("P5 board writer filter selects the right cards; unrefined includes untagged", () => {
  const home = seedWriterBoard();
  const dev = Object.values(loadBoard({ date: "all", writer: "dev" }, home).columns).flat();
  assert.deepEqual(dev.map((c) => c.change_id), ["chg-dev"]);
  const agent = Object.values(loadBoard({ date: "all", writer: "agent-autonomous" }, home).columns).flat();
  assert.deepEqual(new Set(agent.map((c) => c.change_id)), new Set(["chg-agent", "chg-elim"]));
  const unref = Object.values(loadBoard({ date: "all", writer: "unrefined" }, home).columns).flat();
  assert.deepEqual(new Set(unref.map((c) => c.change_id)), new Set(["chg-none", "chg-noattr"]), "untagged card is unrefined, never dropped");
});

test("P5 buildAttributionStats byWriter: four buckets sum to total (no silent gaps)", () => {
  const home = seedWriterBoard();
  const s = buildAttributionStats(home, { date: "all" });
  assert.equal(s.total, 6);
  assert.equal(s.byWriter.dev, 1);
  assert.equal(s.byWriter["agent-autonomous"], 2, "agent-log + elimination");
  assert.equal(s.byWriter.ambiguous, 1);
  assert.equal(s.byWriter.unrefined, 2, "none + untagged");
  assert.equal(s.byWriter.dev + s.byWriter["agent-autonomous"] + s.byWriter.ambiguous + s.byWriter.unrefined, s.total);
  assert.equal(s.byMatch["elimination"], 1, "elimination surfaced in byMatch too");
  // honesty: NONE of these weak writer buckets bumped verifiedAttested
  assert.equal(s.verifiedAttested, 0);
});

// ---- P6: daemon-level SIMULATED end-to-end (host log → committed ticket) ------
import { Daemon } from "../src/core/daemon.ts";
import { execFileSync } from "node:child_process";
import { readJsonl } from "../src/util.ts";

function initGit(dir: string): void {
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  execFileSync("git", ["-C", dir, "config", "core.autocrlf", "false"]);
  execFileSync("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, ".gitkeep"), "");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
}

test("P6 daemon E2E: a Claude host-log write → committed out-of-band ticket is dev-log; an unclaimed organ write → elimination; chain intact", async () => {
  const L = layout();
  const ledgerHome = mktmp("ol-we2e-");
  const organHome = L.organOpenclaw;
  initGit(organHome);
  fs.mkdirSync(path.join(ledgerHome, "events"), { recursive: true });

  // a Claude Code transcript claims a write to organ file "workspace/memory/dev.md"
  const devRel = "workspace/memory/dev.md";
  const devAbs = path.join(organHome, devRel);
  fs.mkdirSync(path.dirname(devAbs), { recursive: true });
  const nowMs = Date.now();
  fs.writeFileSync(path.join(L.claudeProjects, "s.jsonl"), claudeWrite(devAbs, new Date(nowMs).toISOString()));

  // config wires the WriterIndex roots to our fixture host-log dirs (roots override —
  // the exact non-standard-install path). organRoots come from targets → organHome.
  const cfg = {
    ledger_home: ledgerHome,
    targets: [{ system: "openclaw" as const, home: organHome, watch: ["workspace"], git: true, ignore: [] }],
    severity_rules: [{ glob: "workspace/**", severity: "medium" as const }],
    rewrite_ratio_critical: 0.5, debounce_ms: 5, session_squash_ms: 10,
    gate: { default: "observe" as const, held_on: ["critical", "delete"] },
    writer_index: { enabled: true, window_ms: 90_000, elimination: true, roots: { claudeProjects: L.claudeProjects, codex: L.codex, kimiSessions: L.kimiSessions } },
  };
  const d = new Daemon(cfg);
  assert.ok(d.writerIndex, "daemon built a WriterIndex from config");

  // 1. the dev write actually happens on disk + an out-of-band event is observed.
  fs.writeFileSync(devAbs, "edited by a coding tool\n");
  d.inbox.appendEvent({
    event_id: "evt-dev", ts: new Date(nowMs + 2000).toISOString(), system: "openclaw", source: "out-of-band",
    path: devRel, op: "create", before_hash: null, after_hash: null,
    ctx: { session_id: null, origin: null, author_hint: null, reason: null, pid: 1, argv: null },
  });
  // 2. an agent self-edit with NO coding-tool log, inside the organ root → elimination.
  const elimRel = "workspace/IDENTITY.md";
  const elimAbs = path.join(organHome, elimRel);
  fs.writeFileSync(elimAbs, "self-rewritten identity\n");
  d.inbox.appendEvent({
    event_id: "evt-elim", ts: new Date(nowMs + 3000).toISOString(), system: "openclaw", source: "out-of-band",
    path: elimRel, op: "create", before_hash: null, after_hash: null,
    ctx: { session_id: null, origin: null, author_hint: null, reason: null, pid: 2, argv: null },
  });
  await d.runToIdle();

  const tickets = readJsonl<Ticket>(path.join(ledgerHome, "ledger", "tickets.jsonl"));
  const dev = tickets.find((t) => t.file === devRel);
  const elim = tickets.find((t) => t.file === elimRel);
  // dev-log: writer stays local but refined as dev, with weak evidence, verified false
  assert.equal(dev?.attribution?.match, "dev-log");
  assert.equal(dev?.attribution?.writer, "local");
  assert.equal(dev?.attribution?.local_writer, "dev");
  assert.equal(dev?.attribution?.writer_evidence?.source, "claude-code");
  assert.equal(dev?.attribution?.principal.verified, false);
  // elimination: writer agent-runtime autonomous unknown, no fake delta, verified false
  assert.equal(elim?.attribution?.match, "elimination");
  assert.equal(elim?.attribution?.writer, "agent-runtime");
  assert.equal(elim?.attribution?.autonomy, "unknown");
  assert.equal(elim?.attribution?.writer_evidence?.delta_ms, undefined);
  assert.equal(elim?.attribution?.principal.verified, false);
  // author.verified is still literally false everywhere; the hash chain is intact.
  assert.ok(tickets.every((t) => t.author.verified === false));
  assert.equal(d.ledger.verify().ok, true, "chain intact with the new writer evidence fields");
});

// ---- Post-polish: parser + index edge cases --------------------------------
test("edge: Codex apply_patch with NO session_meta (cwd null) — absolute path still resolves; relative is left as-is", () => {
  const abs = "C:\\Hello-World\\organledger\\abs.md";
  const patch = "*** Begin Patch\n*** Update File: " + abs + "\n@@\n-a\n+b\n*** End Patch";
  const call = JSON.stringify({ type: "response_item", timestamp: "2026-05-19T07:30:27.149Z", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "c1", input: patch } });
  const recs = parseCodex(call + "\n", "r"); // no session_meta line → cwd stays null
  assert.equal(recs.length, 1);
  assert.equal(recs[0].absPath, canonPath(abs), "absolute patch path usable even without cwd");
});

test("edge: Codex Delete File line is captured too (op-agnostic — any *** X File: is a touch)", () => {
  const meta = JSON.stringify({ type: "session_meta", timestamp: "2026-05-19T07:00:00.000Z", payload: { cwd: "C:\\w" } });
  const patch = "*** Begin Patch\n*** Delete File: gone.md\n*** End Patch";
  const call = JSON.stringify({ type: "response_item", timestamp: "2026-05-19T07:30:00.000Z", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "c2", input: patch } });
  const recs = parseCodex(meta + "\n" + call + "\n", "r");
  assert.equal(recs.length, 1);
  assert.equal(recs[0].absPath, canonPath(path.resolve("C:\\w", "gone.md")));
});

test("edge: Kimi MultiEdit tool.call → single record on args.path", () => {
  const line = JSON.stringify({ type: "context.append_loop_event", event: { type: "tool.call", name: "MultiEdit", toolCallId: "t", args: { path: "C:/x/multi.md", edits: [{}, {}] } }, time: T0 });
  const recs = parseKimi(line, "w", "dev");
  assert.equal(recs.length, 1);
  assert.equal(recs[0].absPath, canonPath("C:/x/multi.md"));
});

test("edge: WriterIndex picks the MIN Δt among multiple in-window dev candidates", () => {
  const L = layout();
  const P = "C:/Hello-World/organledger/multi.md";
  fs.writeFileSync(path.join(L.claudeProjects, "s.jsonl"),
    claudeWrite(P.replace(/\//g, "\\"), new Date(T0).toISOString(), "far") +
    claudeWrite(P.replace(/\//g, "\\"), new Date(T0 + 4000).toISOString(), "near"));
  const idx = mkIndex(L); idx.refresh();
  const r = idx.matchOutOfBand(P, T0 + 5000); // near is Δ1000, far is Δ5000
  assert.equal(r.match, "dev-log");
  assert.equal(r.evidence?.delta_ms, 1000, "closest candidate wins");
  assert.ok(r.evidence?.ref?.endsWith("#near"));
});

test("edge: wdActorMap config override promotes a new bucket to agent (future openclaw kimi桶)", () => {
  const L = layout();
  const P = "C:/Users/ryshi/.openclaw/workspace/note.md";
  writeKimiWire(L.kimiSessions, "wd_openclaw_zzz", "main", kimiWrite(P, T0));
  // default (no override): wd_openclaw_* is treated as DEV → dev-log
  const def = mkIndex(L); def.refresh();
  assert.equal(def.matchOutOfBand(P, T0).match, "dev-log");
  // with override: wd_openclaw_ → agent → agent-log (no code change needed)
  const ovr = mkIndex(L, { wdActorMap: { "wd_openclaw_": "agent" } }); ovr.refresh();
  const r = ovr.matchOutOfBand(P, T0);
  assert.equal(r.match, "agent-log");
  assert.equal(r.evidence?.source, "openclaw", "an openclaw kimi bucket is honestly labelled openclaw (not hermes)");
});
