// Shared type contracts. Authoritative field names: 12-数据契约速查表.md / 08 §8.4-8.5.
// Phase 1 honesty boundary: author.verified is ALWAYS false here.

export type OrganSystem = "openclaw" | "hermes";
export type Source = "in-band" | "out-of-band";
export type Op = "create" | "update" | "delete";
export type Severity = "low" | "medium" | "high" | "critical";
export type Status = "observed" | "held" | "approved" | "rejected" | "rolled_back";
export type AuthorType = "agent" | "user" | "cron" | "unknown";

// events/inbox.jsonl — one per line. Adapters append; consumer reads + archives.
export interface OrganEvent {
  event_id: string;              // evt-<uuid>
  ts: string;                    // ISO8601 UTC
  system: OrganSystem;
  source: Source;
  path: string;                  // relative to organ home
  op: Op;
  before_hash: string | null;    // sha256:... | null
  after_hash: string | null;     // sha256:... | null
  ctx: EventCtx;
}

export interface EventCtx {
  session_id: string | null;
  origin: string | null;         // foreground|background_review|cron|user|null
  author_hint: AuthorType | null;
  reason: string | null;
  pid: number | null;
  argv: string[] | null;
  // Phase 2 (identity/principal). OPTIONAL + additive: in-band writers that can
  // read the current turn set it so normalizer can JOIN the principal-turn record;
  // out-of-band writes and shims that can't resolve a turn leave it undefined →
  // the write honestly degrades to unknown/local (never a guessed principal).
  turn_id?: string | null;
}

// ledger/tickets.jsonl — hash-chained change tickets (source of truth).
export interface Ticket {
  change_id: string;             // chg-<YYYYMMDD>-<seq>
  system: OrganSystem;
  source: Source;
  author: TicketAuthor;
  session_id: string | null;
  origin: string | null;         // foreground|background_review|cron|user|null (from the event ctx)
  file: string;
  op: Op;
  before_hash: string | null;
  after_hash: string | null;
  reason: string | null;
  severity: Severity;
  status: Status;
  git_commit: string | null;
  prev_ticket_hash: string;      // sha256 of previous ticket's canonical JSON
  created_at: string;
  // Phase 1.6 provenance (source) dimension. OPTIONAL + additive: old tickets have
  // no such key → canonicalJson omits undefined keys → their bytes (and the hash
  // chain) are unchanged. Only backfilled/source-tagged tickets carry it.
  provenance?: Provenance;
  // Phase 2 attribution (principal/who-caused-it) dimension. OPTIONAL + additive,
  // same byte-safety guarantee as provenance. Carries its OWN verified semantics
  // (Attribution.principal.verified), independent of TicketAuthor (still false).
  attribution?: Attribution;
}

// Provenance = the source (where this change came from), a dimension SEPARATE
// from identity (who). `verified: true` here is a literal: it may ONLY hold
// content-addressable / config-provable facts (commit SHA, remote URL, branch).
// It must NEVER carry unprovable "who did it / intent" info — identity stays on
// TicketAuthor{verified:false}. This split (source verifiable / identity not) is
// the core concept of Phase 1.6.
export type ProvenanceKind =
  | "content"                     // file-level history from a specific commit (content backfill)
  | "pull" | "merge" | "clone"    // reflog upstream-update events
  | "local-commit" | "history-move"; // reflog non-upstream HEAD moves

export interface Provenance {
  kind: ProvenanceKind;
  repo_root: string;
  remote_url: string | null;
  branch: string | null;
  from_commit: string | null;    // update event's old HEAD (null for content tickets)
  to_commit: string | null;      // update event's new HEAD / content ticket's own commit
  verified: true;                // ← literal true: content-addressable/config-provable only
}

export interface TicketAuthor {
  type: AuthorType;
  id: string | null;
  verified: false;               // ← literal false; Phase 1 must never be true
}

// ---- Phase 2: three-axis attribution (writer / principal / autonomy) --------
// The core Phase 2 concept: the WRITER (whose process wrote the bytes) is NOT the
// PRINCIPAL (whose request caused it). An agent writing on behalf of an external
// IM user has writer=agent-runtime but principal=that-IM-user. Intent cannot be
// reconstructed from the filesystem after the fact — it must be captured in-band
// at write time (turn record) and JOIN-ed here. Attribution is an OPTIONAL,
// additive ticket field with its OWN verified semantics, kept strictly separate
// from provenance (source) and TicketAuthor (still literal false).
//
// HONESTY BOUNDARY (the head red line — locked by tests in attribution.test.ts):
//   * principal.verified may be true ONLY for kind:"im-user" with a platform
//     channel AND attestation:"platform-attested". Everything else is false.
//   * LOCAL writes are ALWAYS kind:"local", verified:false — we never guess
//     whether it was you, Claude Code, or the agent acting autonomously.
//   * autonomy:"requested" proves a principal's message existed THIS turn; it does
//     NOT prove the write faithfully reflects that request (faithfulness unproven).
//   * attestation:"platform-attested" = platform-authenticated IM identity +
//     agent runtime self-report. A compromised runtime can forge it → this is NOT
//     cryptographic non-repudiation. Never render it as "proven".
export type WriterKind = "agent-runtime" | "local" | "git" | "unknown";
export type PrincipalKind = "im-user" | "local" | "autonomous" | "unknown";
export type Channel = "wecom" | "feishu" | "local" | "cron" | "git" | null;
export type Autonomy = "requested" | "self" | "unknown";
export type Attestation = "platform-attested" | "unverified" | null;
// JOIN strength between the write event and the principal-turn record (honest):
// "turn-id" exact > "session" > "time-window" (weak, nearest-in-session) > "none".
// Phase 2.1 (host-log writer attribution, additive): the out-of-band branch JOINs a
// bare file write against local coding/agent transcripts by (absPath, ±time window).
// ALL of these are WEAK (path+time collision ≠ proof) and carry verified:false:
//   "dev-log"     a DEV coding tool (Claude Code/Codex/Kimi) logged this write
//   "agent-log"   an AGENT runtime (Hermes via Kimi) logged this write
//   "elimination" NO tool log claimed it AND it landed inside an agent organ root
//                 → weakly inferred agent (assumes human edits go through tool logs)
//   "ambiguous"   both a DEV and an AGENT log matched → never guess, stay local
export type AttributionMatch =
  | "turn-id" | "session" | "time-window" | "none"        // Phase 2 (principal line)
  | "dev-log" | "agent-log" | "elimination" | "ambiguous"; // Phase 2.1 (writer line, all weak)

export interface Principal {
  kind: PrincipalKind;
  channel: Channel;
  id: string | null;          // platform user id: wecom userid / feishu open_id; local/autonomous = null
  display: string | null;     // best-effort display name
  verified: boolean;          // ONLY im-user + platform-attested may be true; local/autonomous/unknown = false
  attestation: Attestation;   // verified:true ⇒ "platform-attested"; else "unverified"|null
}

export interface Attribution {
  writer: WriterKind;
  principal: Principal;
  autonomy: Autonomy;         // "requested" ≠ faithful (best-effort; faithfulness unproven)
  turn_id: string | null;     // the joined turn; null = not correlated
  match: AttributionMatch;    // JOIN strength (honestly labelled; time-window is weak)
  // ---- Phase 2.1 host-log writer attribution (OPTIONAL + additive) ----------
  // Same byte-safety guarantee as provenance/attribution: undefined ⇒ canonicalJson
  // omits the key ⇒ old ticket bytes + the hash chain are unchanged. Populated ONLY
  // on out-of-band writes when a WriterIndex is wired; all are WEAK (path+time) and
  // NEVER promote principal.verified. See writer-index.ts / normalizer.ts.
  local_writer?: "dev" | null;      // writer:"local" refinement: a local coding tool wrote it
  writer_evidence?: WriterEvidence; // the C-tier (path+time) hit that backs match:dev-log/agent-log/elimination/ambiguous
}

// The weak (C-tier) evidence that backs a Phase 2.1 host-log writer match. It records
// WHICH host log matched by (absolute path, ±time window) — never the log/file content
// (dashboard privacy red line). matched_by is always "path+time" so UI/CLI must render
// it as weak: a path+time collision is NOT proof the write came from that tool.
export interface WriterEvidence {
  source: "claude-code" | "codex" | "kimi-code" | "hermes" | "openclaw";
  actor_class: "dev" | "agent";
  ref: string;             // back-reference for auditing: <logFile>#<id|line>, or organ-root:<system> for elimination
  matched_by: "path+time"; // literal — the honest, weak join key (never render as proven)
  delta_ms?: number;       // |ticket.tsMs − log.tsMs| for the winning candidate. OMITTED for elimination —
                           // there was NO positive log match, so a delta would be a lie (not 0 = perfect).
  note?: string;           // elimination/ambiguous premise ("no tool log claimed it; assumes human edits go through tool logs")
  rivals?: Array<{ source: string; actor_class: "dev" | "agent"; delta_ms: number }>; // ambiguous: the losing side's candidate(s)
}

// A single file-write observed in a host log (Claude Code / Codex / Kimi / Hermes).
// The normalized, JOIN-ready shape every host-log parser emits. absPath is already
// canonPath()-normalized so the WriterIndex can bucket by it directly.
export interface HostWriteRecord {
  source: WriterEvidence["source"];
  actor_class: "dev" | "agent";
  absPath: string;   // canonPath()-normalized absolute path (the JOIN key)
  tsMs: number;      // epoch ms
  ref: string;       // <logFile>#<id|line>
}

// principal-turn contract (04.2). Written by IM entrypoints OUTSIDE this repo
// (WeCom bridge / feishu hook) — append-only, one record per external message,
// BEFORE the agent processes it. Read by the daemon's PrincipalIndex, JOIN-ed
// onto in-band organ writes by turn_id (exact) → session_id → time-window (weak).
// The contract is stable: fields never removed; a missing stream or missing field
// degrades to principal=unknown (never a crash, never a guessed principal).
export interface TurnRecord {
  turn_id: string;            // globally unique; convention <channel>:<msgid>
  session_id: string | null;  // the agent session this turn maps to (JOIN fallback)
  ts_start: string;           // ISO8601 UTC — when the entrypoint received the message
  principal: Principal;       // im-user + platform-attested for real IM channels
}

export interface SeverityRule {
  glob: string;
  severity: Severity;
  delete_gate?: "held";
  rewrite_ratio_critical?: number;
}

export interface Target {
  system: OrganSystem;
  home: string;
  watch: string[];
  git: boolean;
  memory_sqlite?: string;
  ignore: string[];
}

export interface Config {
  ledger_home: string;
  targets: Target[];
  severity_rules: SeverityRule[];
  rewrite_ratio_critical: number;
  debounce_ms: number;
  session_squash_ms: number;
  gate: { default: "observe"; held_on: string[] };
  // v2 (optional; consumed with defaults so v1 config still loads)
  layout_version?: number;
  log_level?: "debug" | "info" | "warn" | "error";
  log_retention_days?: number;
  processed_retention_days?: number;
  // Phase 2.1 host-log writer attribution (all OPTIONAL with defaults; a v1 config
  // with no such key still loads and behaves exactly as before — see loadConfig).
  writer_index?: WriterIndexConfig;
}

export interface WriterIndexConfig {
  enabled?: boolean;                          // default true; false ⇒ out-of-band branch behaves exactly as Phase 2 (pure bypass)
  window_ms?: number;                         // default 90000 (±90s); the (absPath, ±window) join half-width
  elimination?: boolean;                      // default true; false ⇒ never weak-infer agent from "landed in organ root"
  wd_actor_map?: Record<string, "dev" | "agent">; // Kimi workDir slug prefix → actor_class override (e.g. {"wd_hermes_":"agent"})
  // Host-log roots. Defaulted from os.homedir() at construction; override ONLY for
  // non-standard installs. Never hardcode an absolute user path in config-less runs.
  roots?: { claudeProjects?: string; codex?: string; kimiSessions?: string };
}
