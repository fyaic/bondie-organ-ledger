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
}

// ledger/tickets.jsonl — hash-chained change tickets (source of truth).
export interface Ticket {
  change_id: string;             // chg-<YYYYMMDD>-<seq>
  system: OrganSystem;
  source: Source;
  author: TicketAuthor;
  session_id: string | null;
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
}

export interface TicketAuthor {
  type: AuthorType;
  id: string | null;
  verified: false;               // ← literal false; Phase 1 must never be true
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
}
