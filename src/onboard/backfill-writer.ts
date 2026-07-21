// backfill-writer — retroactively attribute the WRITER of HISTORICAL out-of-band
// tickets by JOINing them against local host logs (Claude Code / Codex / Kimi), the
// same (absPath, ±window) C-tier match the live daemon does — but over all history.
//
// WHY A SIDECAR (not in the ticket): a ticket's canonicalJson (which the hash chain
// signs) covers the WHOLE ticket including `attribution`. Mutating a sealed ticket's
// attribution would change its hash and break every downstream prev_ticket_hash — a
// full chain rewrite, destroying the ledger's tamper-evidence. A weak, recomputable
// path+time inference does NOT belong inside the immutable chain anyway. So backfill
// writes a SEPARATE, recomputable overlay (state/writer-backfill.jsonl) that the
// dashboard/CLI layer ON TOP at read time. The ledger bytes are never touched.
//
// READ-ONLY over the ledger and over host logs. The only file written is the sidecar.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { paths, readJsonl, canonPath } from "../util.ts";
import { WriterIndex } from "../core/writer-index.ts";
import type { Config, Ticket, WriterEvidence } from "../types.ts";

// One overlay row per historically-attributed ticket. change_id is the JOIN key back
// to the (untouched) ledger ticket; the rest mirrors the live attribution writer axis.
export interface WriterBackfillRow {
  change_id: string;
  match: "dev-log" | "agent-log" | "elimination" | "ambiguous";
  writer: "local" | "agent-runtime";
  local_writer?: "dev";
  evidence: WriterEvidence; // always carries backfilled:true
}

export interface BackfillWriterResult {
  scanned: number;      // eligible out-of-band tickets considered (git-backfilled EXCLUDED)
  refined: number;      // tickets that got a match (written to the sidecar)
  byMatch: Record<string, number>;
  indexed: number;      // host-log write records loaded
  skippedGitBackfill: number; // tickets skipped because created_at is a COMMIT time, not a write time
  sidecar: string;
  windowMs: number;
}

// Build a WriterIndex that scans ALL host-log history (maxAgeMs unbounded), unlike the
// live daemon's 3-day bound — a 3-month-old ticket needs 3-month-old logs.
function buildFullHistoryIndex(cfg: Config): WriterIndex {
  const wi = cfg.writer_index;
  const home = os.homedir();
  return new WriterIndex({
    roots: {
      claudeProjects: wi?.roots?.claudeProjects ?? path.join(home, ".claude", "projects"),
      codex: wi?.roots?.codex ?? path.join(home, ".codex"),
      kimiSessions: wi?.roots?.kimiSessions ?? path.join(home, ".kimi-code", "sessions"),
    },
    organRoots: cfg.targets.map((t) => ({ system: t.system, home: t.home })),
    windowMs: wi?.window_ms,
    eliminationOn: wi?.elimination,
    wdActorMap: wi?.wd_actor_map,
    maxAgeMs: undefined, // ← scan everything (this is the point of backfill)
  });
}

export function backfillWriterAttribution(cfg: Config): BackfillWriterResult {
  const p = paths(cfg.ledger_home);
  const index = buildFullHistoryIndex(cfg);
  index.refresh(); // one big scan of all host logs

  const homeBySystem = new Map(cfg.targets.map((t) => [t.system, t.home]));
  const tickets = readJsonl<Ticket>(p.tickets);
  const rows: WriterBackfillRow[] = [];
  const byMatch: Record<string, number> = {};
  let scanned = 0;
  let skippedGitBackfill = 0;

  for (const t of tickets) {
    if (!t?.change_id) continue;
    // Only bare out-of-band writes with no live writer refinement are candidates.
    // (in-band / already dev-log|agent-log|elimination|ambiguous are left as-is.)
    if (t.source !== "out-of-band") continue;
    const live = t.attribution?.match;
    if (live && live !== "none" && live !== "time-window" && live !== "session" && live !== "turn-id") continue;
    // HONESTY GATE — the crux of correct historical attribution: a git-backfilled
    // ticket (provenance set) carries created_at = the COMMIT timestamp, NOT the moment
    // a tool wrote the file. A (path, ±window) JOIN against tool logs is therefore
    // MEANINGLESS for it — it would misfire almost everything into "elimination" (a
    // false "the agent wrote it"). Only LIVE-captured out-of-band writes (no provenance,
    // created_at ≈ real write instant) can be honestly attributed. Skip the rest.
    if (t.provenance) { skippedGitBackfill++; continue; }
    const organHome = homeBySystem.get(t.system);
    if (!organHome) continue;
    scanned++;
    const absPath = path.join(organHome, t.file);
    const at = Date.parse(t.created_at);
    if (Number.isNaN(at)) continue;
    const r = index.matchOutOfBand(absPath, at);
    if (r.match === "none" || !r.evidence) continue;
    byMatch[r.match] = (byMatch[r.match] ?? 0) + 1;
    rows.push({
      change_id: t.change_id,
      match: r.match,
      writer: r.writer === "agent-runtime" ? "agent-runtime" : "local",
      ...(r.match === "dev-log" ? { local_writer: "dev" as const } : {}),
      evidence: { ...r.evidence, backfilled: true },
    });
  }

  // overwrite the sidecar (recomputable; not an audit source of truth)
  fs.mkdirSync(path.dirname(p.writerBackfill), { recursive: true });
  fs.writeFileSync(p.writerBackfill, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));

  return {
    scanned,
    refined: rows.length,
    byMatch,
    indexed: index.size(),
    skippedGitBackfill,
    sidecar: p.writerBackfill,
    windowMs: (cfg.writer_index?.window_ms ?? 90_000),
  };
}

// Read side: the dashboard/CLI overlay. Returns change_id → row. Missing/torn file →
// empty map (degrade, never crash — same contract as the rest of the read layer).
export function loadWriterBackfill(ledgerHome: string): Map<string, WriterBackfillRow> {
  const file = paths(ledgerHome).writerBackfill;
  const out = new Map<string, WriterBackfillRow>();
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const row = JSON.parse(s) as WriterBackfillRow;
      if (row?.change_id && row.match) out.set(row.change_id, row);
    } catch { /* torn line — skip */ }
  }
  return out;
}

// exported for tests: the canonical absPath a ticket JOINs on.
export function ticketAbsPath(organHome: string, file: string): string {
  return canonPath(path.join(organHome, file));
}
