// Attribution layer tests (Phase 2: identity / principal).
// Locks the HEAD red line — honest layered attribution — with executable asserts:
//   * local writes are ALWAYS verified:false, kind:"local" (never guessed)
//   * principal.verified:true ONLY for im-user + platform-attested channel
//   * autonomy:"requested" carries no faithfulness claim; agent-autonomous = "self"
//   * un-instrumented / no-turn writes degrade to unknown, they do not crash
//   * additive schema: attribution is optional; old ticket bytes + chain unchanged
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "../src/core/ledger.ts";
import { PrincipalIndex } from "../src/core/principal-index.ts";
import { canonicalJson } from "../src/util.ts";
import type { Attribution, Ticket, TurnRecord } from "../src/types.ts";

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function imTurn(turn_id: string, session_id: string | null, ts_start: string, id: string, display: string, channel: "wecom" | "feishu" = "wecom"): TurnRecord {
  return {
    turn_id, session_id, ts_start,
    principal: { kind: "im-user", channel, id, display, verified: true, attestation: "platform-attested" },
  };
}

function writeTurns(file: string, recs: TurnRecord[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

// ---- P1: additive schema red line -----------------------------------------
test("additive schema red line: attribution is optional — old ticket bytes unchanged, chain intact", () => {
  const home = mktmp("ol-attrchain-");
  const ledger = new Ledger(home);
  const base: Omit<Ticket, "attribution"> = {
    change_id: ledger.nextChangeId(), system: "hermes", source: "in-band",
    author: { type: "unknown", id: null, verified: false }, session_id: null, origin: null,
    file: "skills/x/SKILL.md", op: "create", before_hash: null, after_hash: "sha256:x",
    reason: null, severity: "high", status: "observed", git_commit: null,
    prev_ticket_hash: "", created_at: "2026-07-01T00:00:00.000Z",
  };
  // a ticket WITHOUT attribution must canonicalize identically to before the field existed
  assert.ok(!canonicalJson(base).includes("attribution"), "undefined attribution key omitted from canonical JSON");

  const attr: Attribution = {
    writer: "agent-runtime",
    principal: { kind: "im-user", channel: "wecom", id: "u123", display: "张三", verified: true, attestation: "platform-attested" },
    autonomy: "requested", turn_id: "wecom:msg:1", match: "turn-id",
  };
  ledger.append({ ...base } as Ticket);                                   // no attribution
  ledger.append({ ...base, change_id: ledger.nextChangeId(), attribution: attr } as Ticket); // with attribution
  const v = new Ledger(home).verify();
  assert.equal(v.ok, true, "chain intact across no-attribution + attribution tickets");
});

// ---- P2: PrincipalIndex (byTurn / bySession / nearest / resilience) --------
test("PrincipalIndex: byTurn exact, bySession unambiguous, nearest within window", () => {
  const file = path.join(mktmp("ol-turns-"), "principal", "turns.jsonl");
  writeTurns(file, [
    imTurn("wecom:msg:1", "sess-A", "2026-07-14T10:00:00.000Z", "u1", "张三"),
    imTurn("wecom:msg:2", "sess-B", "2026-07-14T10:05:00.000Z", "u2", "李四"),
    imTurn("wecom:msg:3", "sess-B", "2026-07-14T10:06:00.000Z", "u2", "李四"), // same principal, still unambiguous
  ]);
  const idx = new PrincipalIndex(file);
  idx.refresh();
  assert.equal(idx.size(), 3);
  assert.equal(idx.byTurn("wecom:msg:1")?.principal.id, "u1", "byTurn exact");
  assert.equal(idx.byTurn("nope"), null, "byTurn miss → null");
  assert.equal(idx.bySession("sess-B")?.principal.id, "u2", "bySession single principal");
  const near = idx.nearestInSession("sess-A", "2026-07-14T10:00:30.000Z", 60 * 1000);
  assert.equal(near?.turn_id, "wecom:msg:1", "nearest within ±window");
  assert.equal(idx.nearestInSession("sess-A", "2026-07-14T12:00:00.000Z", 60 * 1000), null, "outside window → null");
});

test("PrincipalIndex: ambiguous session (mixed principals) → bySession null (never guess)", () => {
  const file = path.join(mktmp("ol-turns-"), "principal", "turns.jsonl");
  writeTurns(file, [
    imTurn("wecom:msg:1", "grp-1", "2026-07-14T10:00:00.000Z", "u1", "张三"),
    imTurn("wecom:msg:2", "grp-1", "2026-07-14T10:01:00.000Z", "u2", "李四"),
  ]);
  const idx = new PrincipalIndex(file);
  idx.refresh();
  assert.equal(idx.bySession("grp-1"), null, "mixed-principal session is ambiguous → null");
  // but time-window can still pick the closest one (weak)
  assert.equal(idx.nearestInSession("grp-1", "2026-07-14T10:00:50.000Z", 60 * 1000)?.principal.id, "u2");
});

test("PrincipalIndex: missing stream → empty, all queries null, no crash", () => {
  const idx = new PrincipalIndex(path.join(mktmp("ol-turns-"), "does-not-exist.jsonl"));
  idx.refresh(); // must not throw
  assert.equal(idx.size(), 0);
  assert.equal(idx.byTurn("x"), null);
  assert.equal(idx.bySession("x"), null);
  assert.equal(idx.nearestInSession("x", "2026-07-14T10:00:00.000Z"), null);
});

test("PrincipalIndex: torn/garbage lines skipped; append-only tail picks up new turns", () => {
  const file = path.join(mktmp("ol-turns-"), "principal", "turns.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(imTurn("wecom:msg:1", "s", "2026-07-14T10:00:00.000Z", "u1", "张三")) + "\n{ this is not json \n");
  const idx = new PrincipalIndex(file);
  idx.refresh();
  assert.equal(idx.size(), 1, "garbage line skipped, good record kept");
  // append a new record; incremental refresh must ingest only the new bytes
  fs.appendFileSync(file, JSON.stringify(imTurn("wecom:msg:9", "s2", "2026-07-14T10:10:00.000Z", "u9", "王五")) + "\n");
  idx.refresh();
  assert.equal(idx.size(), 2, "tail picked up appended turn");
  assert.equal(idx.byTurn("wecom:msg:9")?.principal.id, "u9");
});

// ---- P3: resolveAttribution — four branches + honesty invariants -----------
import { resolveAttribution, normalize } from "../src/core/normalizer.ts";
import type { OrganEvent, Target } from "../src/types.ts";

function inbandEvt(over: Partial<OrganEvent["ctx"]> = {}, ts = "2026-07-14T10:00:00.500Z"): OrganEvent {
  return {
    event_id: "evt-1", ts, system: "hermes", source: "in-band",
    path: "skills/note/SKILL.md", op: "update", before_hash: null, after_hash: "sha256:a",
    ctx: { session_id: null, origin: null, author_hint: "agent", reason: null, pid: 1, argv: null, ...over },
  };
}

function makeIndex(recs: TurnRecord[]): PrincipalIndex {
  const file = path.join(mktmp("ol-turns-"), "principal", "turns.jsonl");
  writeTurns(file, recs);
  const idx = new PrincipalIndex(file);
  idx.refresh();
  return idx;
}

test("resolveAttribution: in-band + turn hit → im-user / verified / attested / requested (match:turn-id)", () => {
  const idx = makeIndex([imTurn("wecom:msg:1", "sess-A", "2026-07-14T10:00:00.000Z", "u1", "张三")]);
  const a = resolveAttribution(inbandEvt({ turn_id: "wecom:msg:1", session_id: "sess-A" }), idx);
  assert.equal(a.writer, "agent-runtime");
  assert.equal(a.principal.kind, "im-user");
  assert.equal(a.principal.id, "u1");
  assert.equal(a.principal.verified, true);
  assert.equal(a.principal.attestation, "platform-attested");
  assert.equal(a.autonomy, "requested");         // NOTE: not a faithfulness proof
  assert.equal(a.match, "turn-id");
});

test("resolveAttribution: in-band, session fallback → match:session", () => {
  const idx = makeIndex([imTurn("wecom:msg:1", "sess-A", "2026-07-14T10:00:00.000Z", "u1", "张三")]);
  const a = resolveAttribution(inbandEvt({ session_id: "sess-A" /* no turn_id */ }), idx);
  assert.equal(a.principal.id, "u1");
  assert.equal(a.match, "session");
  assert.equal(a.autonomy, "requested");
});

test("resolveAttribution: in-band, time-window fallback → match:time-window (weak)", () => {
  // ambiguous session (two principals) forces bySession→null; nearest picks closest
  const idx = makeIndex([
    imTurn("wecom:msg:1", "grp-1", "2026-07-14T10:00:00.000Z", "u1", "张三"),
    imTurn("wecom:msg:2", "grp-1", "2026-07-14T09:50:00.000Z", "u2", "李四"),
  ]);
  const a = resolveAttribution(inbandEvt({ session_id: "grp-1" }, "2026-07-14T10:00:10.000Z"), idx);
  assert.equal(a.match, "time-window");
  assert.equal(a.principal.id, "u1", "nearest in time wins (weak)");
});

test("resolveAttribution: in-band, known session but NO principal → autonomous / self (honesty red line)", () => {
  const idx = makeIndex([]); // empty stream
  const a = resolveAttribution(inbandEvt({ session_id: "sess-X" }), idx);
  assert.equal(a.writer, "agent-runtime");
  assert.equal(a.principal.kind, "autonomous");
  assert.equal(a.principal.verified, false);
  assert.equal(a.autonomy, "self");
  assert.equal(a.match, "none");
});

test("resolveAttribution: in-band, no turn AND no session → unknown (not falsely autonomous)", () => {
  const a = resolveAttribution(inbandEvt({}), null);
  assert.equal(a.principal.kind, "unknown");
  assert.equal(a.principal.verified, false);
  assert.equal(a.autonomy, "unknown");
});

test("resolveAttribution: out-of-band write → local, verified:false ALWAYS (never guess you/CC/agent)", () => {
  const evt: OrganEvent = { ...inbandEvt(), source: "out-of-band", ctx: { session_id: null, origin: null, author_hint: null, reason: null, pid: 9, argv: null } };
  const a = resolveAttribution(evt, makeIndex([imTurn("wecom:msg:1", "s", "2026-07-14T10:00:00.000Z", "u1", "张三")]));
  assert.equal(a.writer, "local");
  assert.equal(a.principal.kind, "local");
  assert.equal(a.principal.verified, false);
  assert.equal(a.principal.attestation, "unverified");
  assert.equal(a.autonomy, "unknown");
});

test("HONESTY CLAMP: a turn record claiming verified for a non-attested / non-im principal is forced to false", () => {
  // forged record: verified:true but attestation is not platform-attested
  const forged: TurnRecord = {
    turn_id: "x:1", session_id: "s", ts_start: "2026-07-14T10:00:00.000Z",
    principal: { kind: "im-user", channel: "wecom", id: "u1", display: "X", verified: true, attestation: "unverified" },
  };
  const idx = makeIndex([forged]);
  const a = resolveAttribution(inbandEvt({ turn_id: "x:1", session_id: "s" }), idx);
  assert.equal(a.principal.verified, false, "unearned verified stripped by clamp");

  // forged record: verified:true but kind is not im-user
  const forged2: TurnRecord = {
    turn_id: "x:2", session_id: "s2", ts_start: "2026-07-14T10:00:00.000Z",
    principal: { kind: "local", channel: null, id: null, display: null, verified: true as unknown as boolean, attestation: "platform-attested" },
  };
  const idx2 = makeIndex([forged2]);
  const a2 = resolveAttribution(inbandEvt({ turn_id: "x:2", session_id: "s2" }), idx2);
  assert.equal(a2.principal.verified, false, "non-im-user can never be verified");
});

test("normalize integration: in-band event → ticket.attribution filled; author.verified still literally false", () => {
  const home = mktmp("ol-attrnorm-");
  const ledger = new Ledger(home);
  const idx = makeIndex([imTurn("wecom:msg:7", "sess-Z", "2026-07-14T10:00:00.000Z", "u7", "王七")]);
  const target: Target = { system: "hermes", home: mktmp("ol-attrhome-"), watch: ["skills"], git: false, ignore: [] };
  const { ticket } = normalize(inbandEvt({ turn_id: "wecom:msg:7", session_id: "sess-Z" }), target, ledger, idx);
  assert.equal(ticket.attribution?.principal.id, "u7");
  assert.equal(ticket.attribution?.principal.verified, true);
  assert.equal(ticket.attribution?.autonomy, "requested");
  assert.equal(ticket.author.verified, false, "TicketAuthor.verified stays literal false (untouched)");
});

// ---- P4: WeCom principal-turn emitter (reference impl of the contract writer) ---
import { wecomTurnRecord, emitWecomTurn } from "../src/adapters/wecom/principal-turn.ts";
import { paths } from "../src/util.ts";

test("wecomTurnRecord: maps inbound WeCom fields → attested im-user turn record", () => {
  const rec = wecomTurnRecord(
    { senderId: "wm_zhang", senderLabel: "张三", sessionKey: "wecom-acct1-chatX", messageSid: "wecom-1699-wm_zhang" },
    "2026-07-14T10:00:00.000Z"
  );
  assert.equal(rec.turn_id, "wecom:wecom-1699-wm_zhang", "<channel>:<msgid> convention");
  assert.equal(rec.session_id, "wecom-acct1-chatX", "sessionKey is the JOIN key");
  assert.equal(rec.principal.kind, "im-user");
  assert.equal(rec.principal.channel, "wecom");
  assert.equal(rec.principal.id, "wm_zhang");
  assert.equal(rec.principal.display, "张三");
  assert.equal(rec.principal.verified, true);
  assert.equal(rec.principal.attestation, "platform-attested");
});

test("emitWecomTurn → PrincipalIndex → JOIN round-trip (simulated end-to-end)", () => {
  const home = mktmp("ol-e2e-");
  // 1. WeCom bridge (out-of-repo) records the inbound turn
  emitWecomTurn(home, { senderId: "wm_li", senderLabel: "李四", sessionKey: "wecom-a-c1", messageSid: "m42", ts: "2026-07-14T10:00:00.000Z" });
  // 2. daemon-side index reads the stream
  const idx = new PrincipalIndex(paths(home).principalTurns);
  idx.refresh();
  // 3. agent writes an organ in that session with the turn id → attribution JOINs
  const a = resolveAttribution(inbandEvt({ turn_id: "wecom:m42", session_id: "wecom-a-c1" }), idx);
  assert.equal(a.principal.id, "wm_li");
  assert.equal(a.principal.verified, true);
  assert.equal(a.autonomy, "requested");
  assert.equal(a.match, "turn-id");
});

// ---- P4: daemon-level SIMULATED end-to-end (turns.jsonl + in-band event) ----
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

test("SIMULATED E2E: WeCom turn recorded → agent in-band write → committed ticket attributed to that user", async () => {
  const ledgerHome = mktmp("ol-e2edaemon-");
  const organHome = mktmp("ol-e2eorgan-");
  initGit(organHome);
  fs.mkdirSync(path.join(ledgerHome, "events"), { recursive: true });

  // 1. WeCom bridge (out-of-repo) records the inbound turn BEFORE the agent acts.
  emitWecomTurn(ledgerHome, { senderId: "wm_wang", senderLabel: "王五", sessionKey: "wecom-a-cX", messageSid: "sid1", ts: new Date().toISOString() });

  const cfg = {
    ledger_home: ledgerHome,
    targets: [{ system: "openclaw" as const, home: organHome, watch: ["skills"], git: true, ignore: [] }],
    severity_rules: [{ glob: "skills/**", severity: "medium" as const }],
    rewrite_ratio_critical: 0.5, debounce_ms: 5, session_squash_ms: 10,
    gate: { default: "observe" as const, held_on: ["critical", "delete"] },
  };
  const d = new Daemon(cfg);

  // 2. agent writes an organ file IN-BAND, carrying the turn_id from that message.
  fs.mkdirSync(path.join(organHome, "skills/note"), { recursive: true });
  fs.writeFileSync(path.join(organHome, "skills/note/SKILL.md"), "written on behalf of the WeCom user\n");
  d.inbox.appendEvent({
    event_id: "evt-x", ts: new Date().toISOString(), system: "openclaw", source: "in-band",
    path: "skills/note/SKILL.md", op: "create", before_hash: null, after_hash: null,
    ctx: { session_id: "wecom-a-cX", origin: "foreground", author_hint: "agent", reason: null, pid: 1, argv: null, turn_id: "wecom:sid1" },
  });
  await d.runToIdle();

  // 3. the committed ticket honestly attributes the change to the WeCom user.
  const tickets = readJsonl<Ticket>(path.join(ledgerHome, "ledger", "tickets.jsonl"));
  assert.equal(tickets.length, 1);
  const attr = tickets[0].attribution;
  assert.equal(attr?.writer, "agent-runtime", "the agent's hand wrote it");
  assert.equal(attr?.principal.kind, "im-user");
  assert.equal(attr?.principal.channel, "wecom");
  assert.equal(attr?.principal.id, "wm_wang", "principal = the external WeCom user");
  assert.equal(attr?.principal.verified, true);
  assert.equal(attr?.principal.attestation, "platform-attested");
  assert.equal(attr?.autonomy, "requested");
  assert.equal(attr?.match, "turn-id");
  assert.equal(tickets[0].author.verified, false, "TicketAuthor still literal false");
  assert.equal(d.ledger.verify().ok, true, "chain intact with attribution");
});

// ---- P5/P6: board card mapping + principal filter + stats (honest, no gaps) ----
import { buildAttributionStats, toCard } from "../src/dashboard/data.ts";

function attrTicket(change_id: string, over: Partial<Attribution> & { kind?: Attribution["principal"]["kind"] } = {}): Ticket {
  const kind = over.kind ?? "im-user";
  const principal: Attribution["principal"] =
    kind === "im-user" ? { kind: "im-user", channel: "wecom", id: "u1", display: "张三", verified: true, attestation: "platform-attested" }
    : kind === "local" ? { kind: "local", channel: "local", id: null, display: null, verified: false, attestation: "unverified" }
    : kind === "autonomous" ? { kind: "autonomous", channel: null, id: null, display: null, verified: false, attestation: "unverified" }
    : { kind: "unknown", channel: null, id: null, display: null, verified: false, attestation: "unverified" };
  return {
    change_id, system: "hermes", source: "in-band",
    author: { type: "agent", id: null, verified: false }, session_id: "s", origin: null,
    file: `skills/${change_id}.md`, op: "update", before_hash: null, after_hash: "sha256:x",
    reason: null, severity: "low", status: "observed", git_commit: null,
    prev_ticket_hash: "", created_at: new Date().toISOString(),
    attribution: { writer: "agent-runtime", principal, autonomy: kind === "im-user" ? "requested" : "unknown", turn_id: null, match: "none", ...over },
  };
}

function seedBoard(): string {
  const home = mktmp("ol-board-");
  const file = path.join(home, "ledger", "tickets.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows = [
    attrTicket("chg-1", { kind: "im-user" }),
    attrTicket("chg-2", { kind: "autonomous" }),
    attrTicket("chg-3", { kind: "local" }),
    // chg-4 has NO attribution at all → must count as unknown, never hidden
    { ...attrTicket("chg-4"), attribution: undefined } as Ticket,
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return home;
}

test("toCard carries attribution; principal filter selects by kind", () => {
  const home = seedBoard();
  // toCard preserves the principal/attribution verbatim (verified flag survives).
  assert.equal(toCard(attrTicket("chg-1", { kind: "im-user" })).attribution?.principal.verified, true);

  // principal filter (shared matchesFilters) selects by kind — checked via stats.
  assert.equal(buildAttributionStats(home, { date: "all", principal: "im-user" }).total, 1, "im-user → chg-1 only");
  // a ticket with NO attribution filters as unknown (never silently dropped).
  assert.equal(buildAttributionStats(home, { date: "all", principal: "unknown" }).total, 1, "un-attributed → unknown");
});

test("attribution --stats: un-attributed tickets counted as unknown (NO silent gaps)", () => {
  const home = seedBoard();
  const s = buildAttributionStats(home, { date: "all" });
  assert.equal(s.total, 4);
  assert.equal(s.byKind["im-user"], 1);
  assert.equal(s.byKind.autonomous, 1);
  assert.equal(s.byKind.local, 1);
  assert.equal(s.byKind.unknown, 1, "the un-attributed ticket is surfaced as unknown");
  assert.equal(s.verifiedAttested, 1, "only the attested im-user counts as verified");
  assert.equal(s.byChannel.wecom, 1);
  // conservation: the four buckets must sum to total — nothing hidden
  assert.equal(s.byKind["im-user"] + s.byKind.autonomous + s.byKind.local + s.byKind.unknown, s.total);
});
