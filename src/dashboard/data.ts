import fs from "node:fs";
import path from "node:path";

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

export interface BoardResponse {
  kpi: {
    date: string;
    total: number;
    held: number;
    severity: Record<Severity, number>;
    files: number;
    systems: Record<OrganSystem, number>;
    reports: string[];
  };
  columns: Record<Status, DashboardCard[]>;
  generated_at: string;
}

const STATUSES: Status[] = ["held", "observed", "approved", "rejected", "rolled_back"];
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
const SYSTEMS: OrganSystem[] = ["openclaw", "hermes"];

export function loadBoard(filters: BoardFilters = {}, ledgerHome = defaultLedgerHome()): BoardResponse {
  const p = paths(ledgerHome);
  const tickets = readJsonl<Ticket>(p.tickets);
  const heldTickets = readHeldTickets(p.held);
  const byId = new Map<string, Ticket>();

  for (const ticket of [...tickets, ...heldTickets]) {
    if (!ticket?.change_id) continue;
    byId.set(ticket.change_id, ticket);
  }

  // Filter FIRST, then sort by recency, then cap — the 500-cap must bound the most
  // recent MATCHING tickets. (A backfilled ledger's file order isn't chronological,
  // so .slice(-500) on raw order could drop the newest tickets and leave the default
  // "recent" KPI empty even when recent data exists.)
  const cards = Array.from(byId.values())
    .map(toCard)
    .filter((card) => matchesFilters(card, filters))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, 500);

  return {
    kpi: buildKpi(cards, filters, p.reports),
    columns: buildColumns(cards),
    generated_at: new Date().toISOString(),
  };
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

function readHeldTickets(heldDir: string): Ticket[] {
  if (!fs.existsSync(heldDir)) return [];
  const files = fs.readdirSync(heldDir).filter((name) => name.endsWith(".json"));
  const tickets: Ticket[] = [];

  for (const file of files) {
    const fullPath = path.join(heldDir, file);
    try {
      const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8")) as Ticket | { ticket?: Ticket };
      const ticket = "ticket" in parsed && parsed.ticket ? parsed.ticket : (parsed as Ticket);
      if (ticket?.change_id) tickets.push({ ...ticket, status: "held" });
    } catch {
      // Ignore malformed held files; the dashboard should stay available.
    }
  }

  return tickets;
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

// Load the GitSource map written by `organledger provenance` / `doctor`. The
// dashboard NEVER runs git — it only reads this file (architectural red line).
// Returns { missing:true } when the file isn't there yet so the UI can prompt.
export function loadProvenance(ledgerHome = defaultLedgerHome()): { missing: boolean; report: unknown } {
  const file = paths(ledgerHome).provenance;
  if (!fs.existsSync(file)) return { missing: true, report: null };
  try {
    return { missing: false, report: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return { missing: true, report: null };
  }
}

function buildColumns(cards: DashboardCard[]): Record<Status, DashboardCard[]> {
  const columns: Record<Status, DashboardCard[]> = {
    held: [],
    observed: [],
    approved: [],
    rejected: [],
    rolled_back: [],
  };
  for (const card of cards) columns[card.status].push(card);
  return columns;
}

function buildKpi(cards: DashboardCard[], filters: BoardFilters, reportsDir: string): BoardResponse["kpi"] {
  const severity = Object.fromEntries(SEVERITIES.map((key) => [key, 0])) as Record<Severity, number>;
  const systems = Object.fromEntries(SYSTEMS.map((key) => [key, 0])) as Record<OrganSystem, number>;
  const files = new Set<string>();

  for (const card of cards) {
    severity[card.severity]++;
    systems[card.system]++;
    files.add(card.file);
  }

  return {
    date: filters.date || "recent",
    total: cards.length,
    held: cards.filter((card) => card.status === "held").length,
    severity,
    files: files.size,
    systems,
    reports: listReports(reportsDir),
  };
}

function listReports(reportsDir: string): string[] {
  if (!fs.existsSync(reportsDir)) return [];
  return fs.readdirSync(reportsDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .slice(-7);
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
