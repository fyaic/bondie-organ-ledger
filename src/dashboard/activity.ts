// Activity log aggregation (Phase 1.7 feature A). Turns the engineering ticket
// stream into a per-day, plain-language "what changed today" narrative for
// NON-engineers. Pure server-side aggregation of ALREADY-LOADED tickets — no fs
// traversal, no git (the dashboard read-only red line is untouched).
//
// PRIVACY (A posture): the log MAY show path / op / source-remote / commit
// subject (`reason`) — these are metadata / the operator's own commit message,
// the core of "readability". It MUST NOT show file CONTENT or diff. See D3.
import type { Op, OrganSystem, Ticket } from "../types.ts";
import { defaultLedgerHome, localDay, paths, readJsonl } from "../util.ts";
import type { DashboardCard } from "./data.ts";
import { toCard } from "./data.ts";

// upstream = a change that arrived via a git pull/merge/clone (mirrors data.ts).
const UPSTREAM_KINDS = new Set(["pull", "merge", "clone"]);

export interface ActivityFolderRollup {
  key: string;            // top-level folder or skill name, e.g. "skills/eye-on" or "agents"
  created: number;
  updated: number;
  deleted: number;
  upstream: number;       // tickets under this key with provenance.kind ∈ {pull,merge,clone}
  remote_short: string | null; // short remote name if a single upstream source, else null
}

export interface ActivityDay {
  date: string;           // local calendar day YYYY-MM-DD (util.localDay, Pacific on-site)
  total: number;
  created: number;
  updated: number;
  deleted: number;
  upstream_events: number;
  systems: OrganSystem[];
  rollups: ActivityFolderRollup[];
  summary: string[];      // 3–6 Chinese plain-language bullets (D9 template)
}

export interface ActivityResponse {
  days: ActivityDay[];    // newest day first
  window: string;         // "all" | "Nd"
  generated_at: string;
}

// rollup key = first two path segments: "skills/<name>" for a skill, else the
// top-level folder ("agents"/"cron"/…). Tolerates a trailing slash (some tickets
// carry directory-level `file` values ending in "/", confirmed on-site P-1).
export function rollupKey(file: string): string {
  const segs = file.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segs.length === 0) return "(root)";
  if (segs[0] === "skills" && segs.length >= 2) return `skills/${segs[1]}`;
  return segs[0];
}

// Short, human name for a remote URL: last path segment minus ".git".
// e.g. https://github.com/fyaic/bondie-eye-on.git → "bondie-eye-on".
export function remoteShort(url: string | null): string | null {
  if (!url) return null;
  const cleaned = url.replace(/\.git$/i, "").replace(/[/\\]+$/, "");
  const seg = cleaned.split(/[/\\]/).filter(Boolean).pop();
  return seg || null;
}

// A friendly display label for a rollup key in the summary line.
function rollupLabel(key: string): string {
  if (key.startsWith("skills/")) return `${key.slice("skills/".length)} 技能`;
  return key;
}

const OP_NOUN: Record<Op, string> = { create: "新增", update: "更新", delete: "删除" };

// window: "all" (default) or "Nd" rolling absolute window (like the board's
// "recent"). Returns the ticket-passing predicate. Timezone-agnostic on purpose.
function windowFilter(window: string): (t: Ticket) => boolean {
  const m = /^(\d+)d$/.exec(window);
  if (!m) return () => true;
  const cutoff = Date.now() - Number(m[1]) * 24 * 60 * 60 * 1000;
  return (t) => {
    const ms = Date.parse(t.created_at);
    return Number.isNaN(ms) ? false : ms >= cutoff;
  };
}

// Build the per-day activity log from the ledger tickets. Server-side only.
export function loadActivity(window = "all", ledgerHome = defaultLedgerHome()): ActivityResponse {
  const p = paths(ledgerHome);
  const tickets = readJsonl<Ticket>(p.tickets).filter(windowFilter(window));

  // group tickets by local calendar day
  const byDay = new Map<string, Ticket[]>();
  for (const t of tickets) {
    if (!t?.created_at) continue;
    const day = localDay(t.created_at);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(t);
  }

  const days: ActivityDay[] = [];
  for (const [date, dayTickets] of byDay) {
    days.push(buildDay(date, dayTickets));
  }
  days.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // newest first

  return { days, window: window || "all", generated_at: new Date().toISOString() };
}

function buildDay(date: string, tickets: Ticket[]): ActivityDay {
  let created = 0, updated = 0, deleted = 0, upstreamEvents = 0;
  const systems = new Set<OrganSystem>();
  const rollupMap = new Map<string, ActivityFolderRollup>();
  const rollupRemotes = new Map<string, Set<string>>(); // key → distinct remote shorts (upstream)

  for (const t of tickets) {
    if (t.op === "create") created++;
    else if (t.op === "update") updated++;
    else if (t.op === "delete") deleted++;
    if (t.system) systems.add(t.system);

    const isUpstream = !!t.provenance && UPSTREAM_KINDS.has(t.provenance.kind);
    if (isUpstream) upstreamEvents++;

    const key = rollupKey(t.file || "");
    if (!rollupMap.has(key)) {
      rollupMap.set(key, { key, created: 0, updated: 0, deleted: 0, upstream: 0, remote_short: null });
      rollupRemotes.set(key, new Set());
    }
    const r = rollupMap.get(key)!;
    if (t.op === "create") r.created++;
    else if (t.op === "update") r.updated++;
    else if (t.op === "delete") r.deleted++;
    if (isUpstream) {
      r.upstream++;
      const short = remoteShort(t.provenance!.remote_url);
      if (short) rollupRemotes.get(key)!.add(short);
    }
  }

  // finalize remote_short: only when the rollup came from a SINGLE upstream source
  for (const [key, r] of rollupMap) {
    const remotes = rollupRemotes.get(key)!;
    r.remote_short = remotes.size === 1 ? [...remotes][0] : null;
  }

  const rollups = [...rollupMap.values()].sort(
    (a, b) => rollupTotal(b) - rollupTotal(a) || a.key.localeCompare(b.key),
  );

  return {
    date,
    total: tickets.length,
    created,
    updated,
    deleted,
    upstream_events: upstreamEvents,
    systems: [...systems].sort(),
    rollups,
    summary: buildSummary(rollups),
  };
}

function rollupTotal(r: ActivityFolderRollup): number {
  return r.created + r.updated + r.deleted;
}

// D9 plain-language summary: one clause per top rollup ("<label><op> N 处/文件")
// plus upstream clauses ("从 <remote> 拉取 N 次"). Capped at 6 lines so a busy
// day stays scannable by a non-engineer. NEVER contains file content/diff.
function buildSummary(rollups: ActivityFolderRollup[]): string[] {
  const lines: string[] = [];

  for (const r of rollups) {
    if (lines.length >= 4) break;
    const total = rollupTotal(r);
    if (total === 0) continue;
    // pick the dominant op for a clean verb
    const dom: Op = r.deleted >= r.created && r.deleted >= r.updated
      ? "delete"
      : r.created >= r.updated
        ? "create"
        : "update";
    const noun = dom === "update" ? "处" : "文件";
    lines.push(`${rollupLabel(r.key)}${OP_NOUN[dom]} ${total} ${noun}`);
  }

  // upstream clauses, aggregated by remote short name
  const upstreamByRemote = new Map<string, number>();
  for (const r of rollups) {
    if (r.upstream > 0 && r.remote_short) {
      upstreamByRemote.set(r.remote_short, (upstreamByRemote.get(r.remote_short) || 0) + r.upstream);
    }
  }
  for (const [remote, n] of [...upstreamByRemote.entries()].sort((a, b) => b[1] - a[1])) {
    if (lines.length >= 6) break;
    lines.push(`从 ${remote} 拉取更新 ${n} 次`);
  }

  if (lines.length === 0) lines.push("当天无器官改动");
  return lines;
}

//逐条明细 for one local day — reuses the board card model (NO file content).
// Returns cards sorted newest-first, matching the drawer's existing shape.
export function loadActivityDay(date: string, ledgerHome = defaultLedgerHome()): {
  date: string;
  items: DashboardCard[];
} {
  const p = paths(ledgerHome);
  const tickets = readJsonl<Ticket>(p.tickets);
  const items = tickets
    .filter((t) => t?.created_at && localDay(t.created_at) === date)
    .map(toCard)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return { date, items };
}
