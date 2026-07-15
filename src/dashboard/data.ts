import type { Attribution, Op, OrganSystem, Provenance, Severity, Status, Ticket } from "../types.ts";
import { defaultLedgerHome, localDay, paths, readJsonl } from "../util.ts";

export type BoardDateFilter = "today" | "recent" | "all" | string;
const RECENT_DAYS = 7;
export type BoardSystemFilter = "all" | OrganSystem;
export type BoardSeverityFilter = "all" | Severity;
// source filter: upstream = came from a git pull/merge/clone; agent = everything
// else (an agent/user edited a file, or plain content history — no upstream event).
export type BoardProvenanceFilter = "all" | "upstream" | "agent";
const UPSTREAM_KINDS = new Set(["pull", "merge", "clone"]);
// principal (who-caused-it) filter — by attribution.principal.kind. "im-user"
// spans both channels; a card with no attribution counts as "unknown".
export type BoardPrincipalFilter = "all" | "im-user" | "autonomous" | "local" | "unknown";

export interface BoardFilters {
  date?: BoardDateFilter;
  system?: BoardSystemFilter;
  severity?: BoardSeverityFilter;
  provenance?: BoardProvenanceFilter;
  principal?: BoardPrincipalFilter;
  q?: string;
}

export interface DashboardCard {
  change_id: string;
  file: string;
  op: Op;
  severity: Severity;
  status: Status;
  system: OrganSystem;
  session_id: string | null;
  origin: string | null;
  author_verified: boolean;
  reason: string | null;
  before_hash: string | null;
  after_hash: string | null;
  git_commit: string | null;
  created_at: string;
  provenance: Provenance | null;   // source dimension (where this change came from); null = untagged
  attribution: Attribution | null; // principal dimension (who caused it); null = untagged (treated as unknown)
}


// ---- attribution stats (`organledger attribution --stats`) ----------------
// Honest distribution over the principal axis. Un-attributed tickets are counted
// as "unknown" (NEVER hidden — no silent gaps), and the verified/attested share
// is reported separately so it's clear how much is only-attested vs local/unknown.
export interface AttributionStats {
  total: number;
  byKind: Record<BoardPrincipalFilter, number>; // im-user / autonomous / local / unknown
  byChannel: Record<string, number>;            // wecom / feishu / … (im-user only)
  byMatch: Record<string, number>;              // turn-id / session / time-window / none
  verifiedAttested: number;                     // im-user + platform-attested (the only true-verified bucket)
  requested: number;                            // autonomy:"requested" (faithfulness UNPROVEN)
  date: BoardDateFilter;
}

export function buildAttributionStats(
  ledgerHome = defaultLedgerHome(),
  filters: BoardFilters = {}
): AttributionStats {
  const p = paths(ledgerHome);
  const cards = readJsonl<Ticket>(p.tickets)
    .filter((t) => t?.change_id)
    .map(toCard)
    .filter((card) => matchesFilters(card, filters));

  const byKind: Record<BoardPrincipalFilter, number> = { "all": 0, "im-user": 0, autonomous: 0, local: 0, unknown: 0 };
  const byChannel: Record<string, number> = {};
  const byMatch: Record<string, number> = {};
  let verifiedAttested = 0;
  let requested = 0;

  for (const card of cards) {
    const kind = principalKindOf(card);
    byKind[kind]++;
    const a = card.attribution;
    const match = a?.match ?? "none";
    byMatch[match] = (byMatch[match] ?? 0) + 1;
    if (a?.principal.kind === "im-user") {
      const ch = a.principal.channel ?? "unknown";
      byChannel[ch] = (byChannel[ch] ?? 0) + 1;
    }
    if (a?.principal.verified === true && a.principal.attestation === "platform-attested") verifiedAttested++;
    if (a?.autonomy === "requested") requested++;
  }
  delete (byKind as Record<string, number>)["all"];
  return { total: cards.length, byKind, byChannel, byMatch, verifiedAttested, requested, date: filters.date || "all" };
}

export function toCard(ticket: Ticket): DashboardCard {
  return {
    change_id: ticket.change_id,
    file: ticket.file,
    op: ticket.op,
    severity: ticket.severity,
    status: ticket.status,
    system: ticket.system,
    session_id: ticket.session_id,
    origin: ticket.origin ?? null,
    author_verified: !!ticket.author?.verified,
    reason: ticket.reason,
    before_hash: ticket.before_hash,
    after_hash: ticket.after_hash,
    git_commit: ticket.git_commit,
    created_at: ticket.created_at,
    provenance: ticket.provenance ?? null,
    attribution: ticket.attribution ?? null,
  };
}

// principal kind of a card, treating an un-attributed card as "unknown".
function principalKindOf(card: DashboardCard): BoardPrincipalFilter {
  const k = card.attribution?.principal.kind;
  if (k === "im-user" || k === "autonomous" || k === "local") return k;
  return "unknown";
}

function matchesFilters(card: DashboardCard, filters: BoardFilters): boolean {
  const date = filters.date || "recent";
  const system = filters.system || "all";
  const severity = filters.severity || "all";
  const provenance = filters.provenance || "all";
  const principal = filters.principal || "all";
  const q = (filters.q || "").trim().toLowerCase();

  if (!matchesDate(card.created_at, date)) return false;
  if (system !== "all" && card.system !== system) return false;
  if (severity !== "all" && card.severity !== severity) return false;
  if (provenance !== "all") {
    const isUpstream = !!card.provenance && UPSTREAM_KINDS.has(card.provenance.kind);
    if (provenance === "upstream" && !isUpstream) return false;
    if (provenance === "agent" && isUpstream) return false;
  }
  if (principal !== "all" && principalKindOf(card) !== principal) return false;
  if (q && !card.file.toLowerCase().includes(q) && !card.change_id.toLowerCase().includes(q)) return false;
  return true;
}

// date filter: "all" | "today" | "recent"(last 7 days) | explicit YYYY-MM-DD.
// Calendar-day comparisons ("today" / explicit) go through the shared localDay()
// so the board and the daily report bucket identically. "recent" is a rolling
// absolute window by design (timezone-agnostic), not a calendar bucket.
function matchesDate(createdAt: string, date: BoardDateFilter): boolean {
  if (date === "all") return true;
  if (date === "today") return localDay(createdAt) === localDay();
  if (date === "recent") {
    const t = Date.parse(createdAt);
    if (Number.isNaN(t)) return false;
    return t >= Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000;
  }
  return localDay(createdAt) === date; // explicit day
}
