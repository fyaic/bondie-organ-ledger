// WriterIndex — the read side of Phase 2.1 host-log writer attribution (04 §4.4).
//
// Reads the LOCAL, append-only coding/agent transcripts (Claude Code / Codex /
// Kimi-code — Kimi's wd_hermes_* bucket doubles as the Hermes AGENT runtime) and lets
// the normalizer JOIN a bare out-of-band organ write against them by (absolute path,
// ±time window). It is the DEV-positive-anchor side of the attribution: a DEV log
// claiming a write is stronger evidence than guessing an agent did it.
//
// ALL matches are C-tier WEAK (path+time collision ≠ proof) — this index NEVER sets
// principal.verified; that stays the exclusive right of platform-attested im-user.
//
// Honesty / resilience contract (mirrors PrincipalIndex):
//   * A missing root, unreadable file, or torn/garbage line NEVER crashes — that
//     source stays empty and its JOINs return nothing (degrade, don't crash).
//   * Append-only tail per file: refresh() reads only bytes appended since last read,
//     so the long-running daemon doesn't re-parse whole transcripts. A shrunk/rotated
//     file is detected (size < offset) and that file's tail state rebuilt.
//   * Codex needs the session cwd (first line) to resolve relative patch paths; that
//     cwd is carried in per-file state so it survives across incremental refreshes.
//
// READ-ONLY: this index opens host logs for reading only. It never writes, deletes,
// or mutates them, and never runs git (dashboard architectural red line).
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { canonPath } from "../util.ts";
import { claudeRecordsFromLine } from "../adapters/hostlogs/claude.ts";
import { codexRecordsFromLine, type CodexState } from "../adapters/hostlogs/codex.ts";
import { kimiRecordsFromLine, classifyKimiWd, kimiSource } from "../adapters/hostlogs/kimi.ts";
import type { Autonomy, Config, HostWriteRecord, OrganSystem, WriterEvidence, WriterKind } from "../types.ts";

// Default max age of a host-log file we bother to (re)scan. A write older than this
// can't fall within the ±window of a freshly-observed organ change (the daemon's
// real-time case), so skipping stale files bounds the per-refresh directory walk.
// Historical backfill (out of scope this round) would widen or drop this.
const DEFAULT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

export const DEFAULT_WRITER_WINDOW_MS = 90_000; // ±90s (03 §4). Standardized in P-2 backfill.

export interface WriterIndexOptions {
  roots: {
    claudeProjects: string; // ~/.claude/projects
    codex: string;          // ~/.codex   (sessions/ + archived_sessions/)
    kimiSessions: string;   // ~/.kimi-code/sessions
  };
  organRoots: { system: OrganSystem; home: string }[]; // for elimination ownership
  windowMs?: number;        // default 90_000
  eliminationOn?: boolean;  // default true
  wdActorMap?: Record<string, "dev" | "agent">;
  // Bound the directory walk: only files modified within this many ms of the last
  // seen write are (re)scanned. undefined ⇒ no bound (scan everything — tests use this).
  maxAgeMs?: number;
}

interface FileState {
  offset: number;     // bytes consumed (append-only tail)
  partial: string;    // trailing partial line carried across reads
  lineNo: number;     // running line counter for ref anchors on id-less lines
  codex?: CodexState; // codex-only: session cwd carried across refreshes
}

export interface MatchResult {
  match: "dev-log" | "agent-log" | "elimination" | "ambiguous" | "none";
  writer: WriterKind;
  principalKind: "local" | "autonomous";
  autonomy: Autonomy;
  evidence?: WriterEvidence;
}

export class WriterIndex {
  private opts: WriterIndexOptions;
  private windowMs: number;
  private eliminationOn: boolean;
  private byPath = new Map<string, HostWriteRecord[]>(); // canonPath → records
  private files = new Map<string, FileState>();          // logFile → tail state
  private organRoots: { system: OrganSystem; canonHome: string }[];

  constructor(opts: WriterIndexOptions) {
    this.opts = opts;
    this.windowMs = opts.windowMs ?? DEFAULT_WRITER_WINDOW_MS;
    this.eliminationOn = opts.eliminationOn ?? true;
    this.organRoots = opts.organRoots.map((r) => ({ system: r.system, canonHome: canonPath(r.home) }));
  }

  // Discover + tail-read all three sources. Safe to call repeatedly; incremental.
  refresh(): void {
    this.scanClaude();
    this.scanCodex();
    this.scanKimi();
  }

  // ---- source scanners -----------------------------------------------------
  private scanClaude(): void {
    // ~/.claude/projects/<enc-cwd>/*.jsonl
    for (const f of this.walk(this.opts.roots.claudeProjects, (n) => n.endsWith(".jsonl"))) {
      this.tail(f, (line, st) => claudeRecordsFromLine(line, path.basename(f), st.lineNo));
    }
  }

  private scanCodex(): void {
    // ~/.codex/sessions/** + ~/.codex/archived_sessions/rollout-*.jsonl
    const roots = [path.join(this.opts.roots.codex, "sessions"), path.join(this.opts.roots.codex, "archived_sessions")];
    for (const root of roots) {
      for (const f of this.walk(root, (n) => n.endsWith(".jsonl"))) {
        this.tail(f, (line, st) => {
          if (!st.codex) st.codex = { cwd: null };
          return codexRecordsFromLine(line, path.basename(f), st.lineNo, st.codex);
        });
      }
    }
  }

  private scanKimi(): void {
    // ~/.kimi-code/sessions/wd_<slug>/<session>/agents/<name>/wire.jsonl (ALL agents,
    // not only main — sub-agents inherit the parent wd bucket's actor_class).
    const root = this.opts.roots.kimiSessions;
    for (const f of this.walk(root, (n) => n === "wire.jsonl")) {
      const slug = this.kimiWdSlug(f, root);
      const actor = classifyKimiWd(slug, this.opts.wdActorMap);
      const source = kimiSource(actor, slug); // honest label: hermes vs openclaw vs kimi-code
      this.tail(f, (line, st) => kimiRecordsFromLine(line, path.basename(path.dirname(path.dirname(f))) + "/wire.jsonl", st.lineNo, actor, source));
    }
  }

  // the wd_<slug> directory name directly under the kimiSessions root.
  private kimiWdSlug(file: string, root: string): string {
    const rel = path.relative(root, file);
    const first = rel.split(/[\\/]/)[0];
    return first || "";
  }

  // ---- append-only tail (per file) -----------------------------------------
  private tail(file: string, toRecords: (line: string, st: FileState) => HostWriteRecord[]): void {
    let size: number;
    try { size = fs.statSync(file).size; } catch { return; } // vanished → skip
    let st = this.files.get(file);
    if (!st) { st = { offset: 0, partial: "", lineNo: 0 }; this.files.set(file, st); }
    if (size < st.offset) { st.offset = 0; st.partial = ""; st.lineNo = 0; if (st.codex) st.codex = { cwd: null }; } // rotated/truncated → rebuild this file
    if (size === st.offset) return; // nothing new

    let chunk = "";
    try {
      const fd = fs.openSync(file, "r");
      try {
        const len = size - st.offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.offset);
        chunk = buf.toString("utf8");
      } finally { fs.closeSync(fd); }
    } catch { return; } // transient read error → retry next refresh
    st.offset = size;

    const text = st.partial + chunk;
    const lines = text.split(/\r?\n/);
    st.partial = lines.pop() ?? ""; // last is "" (clean) or a torn partial line
    for (const line of lines) {
      st.lineNo++;
      if (!line.trim()) continue;
      for (const rec of toRecords(line, st)) this.insert(rec);
    }
  }

  private insert(rec: HostWriteRecord): void {
    const arr = this.byPath.get(rec.absPath);
    if (arr) arr.push(rec);
    else this.byPath.set(rec.absPath, [rec]);
  }

  // bounded, defensive directory walk. Missing/unreadable dirs yield nothing.
  private *walk(dir: string, keep: (name: string) => boolean): Generator<string> {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { yield* this.walk(p, keep); continue; }
      if (!keep(e.name)) continue;
      if (this.opts.maxAgeMs != null) {
        try {
          const m = fs.statSync(p).mtimeMs;
          if (m < Date.now() - this.opts.maxAgeMs) continue; // too old to match a fresh ticket
        } catch { continue; }
      }
      yield p;
    }
  }

  // ---- the core JOIN (03 module 1 / 04 §4.4) --------------------------------
  matchOutOfBand(absPathRaw: string, tsMs: number): MatchResult {
    const key = canonPath(absPathRaw);
    const recs = this.byPath.get(key) ?? [];
    let dev: { rec: HostWriteRecord; delta: number } | null = null;
    let agent: { rec: HostWriteRecord; delta: number } | null = null;
    for (const rec of recs) {
      const delta = Math.abs(tsMs - rec.tsMs);
      if (delta > this.windowMs) continue;
      if (rec.actor_class === "dev") { if (!dev || delta < dev.delta) dev = { rec, delta }; }
      else { if (!agent || delta < agent.delta) agent = { rec, delta }; }
    }

    if (dev && agent) {
      // both sides matched in-window → NEVER guess "closer = it". C-tier has no
      // content proof to break the tie;制造假精度 is worse than退回 local. (03 §打破平手)
      return {
        match: "ambiguous", writer: "local", principalKind: "local", autonomy: "unknown",
        evidence: {
          source: dev.rec.source, actor_class: "dev", ref: dev.rec.ref, matched_by: "path+time", delta_ms: dev.delta,
          note: "multi-source contention: both a DEV and an AGENT log matched (path+time) — not disambiguated (no content proof)",
          rivals: [
            { source: dev.rec.source, actor_class: "dev", delta_ms: dev.delta },
            { source: agent.rec.source, actor_class: "agent", delta_ms: agent.delta },
          ],
        },
      };
    }
    if (dev) {
      return {
        match: "dev-log", writer: "local", principalKind: "local", autonomy: "unknown",
        evidence: { source: dev.rec.source, actor_class: "dev", ref: dev.rec.ref, matched_by: "path+time", delta_ms: dev.delta },
      };
    }
    if (agent) {
      return {
        match: "agent-log", writer: "agent-runtime", principalKind: "autonomous", autonomy: "self",
        evidence: { source: agent.rec.source, actor_class: "agent", ref: agent.rec.ref, matched_by: "path+time", delta_ms: agent.delta },
      };
    }
    // no positive log match → try elimination (weakest, opt-out-able)
    if (this.eliminationOn) {
      const owner = this.organOwner(key);
      if (owner) {
        return {
          match: "elimination", writer: "agent-runtime", principalKind: "autonomous", autonomy: "unknown",
          evidence: {
            source: owner === "hermes" ? "hermes" : "openclaw",
            actor_class: "agent", ref: `organ-root:${owner}`, matched_by: "path+time",
            // delta_ms deliberately OMITTED — there was no positive match, a delta would be a lie.
            note: "no coding-tool log claimed this write and it landed inside the " + owner + " organ root; weak inference — assumes human edits go through a tool log",
          },
        };
      }
    }
    return { match: "none", writer: "local", principalKind: "local", autonomy: "unknown" };
  }

  // which organ system's root contains this canonical path (prefix match), or null.
  private organOwner(canonKey: string): OrganSystem | null {
    for (const r of this.organRoots) {
      if (canonKey === r.canonHome || canonKey.startsWith(r.canonHome + "/")) return r.system;
    }
    return null;
  }

  // diagnostics (tests / stats): how many write records currently indexed.
  size(): number {
    let n = 0;
    for (const arr of this.byPath.values()) n += arr.length;
    return n;
  }
}

// Build a WriterIndex from live config + os.homedir()-derived host-log roots.
// Returns null when writer_index.enabled === false (pure bypass — the out-of-band
// branch then behaves exactly as Phase 2). Roots are homedir-derived so Win/Mac both
// resolve to $HOME/.claude etc. (never a hardcoded C:\Users\...); a non-standard
// install can override individual roots via config.writer_index.roots.
export function buildWriterIndexFromConfig(cfg: Config): WriterIndex | null {
  const wi = cfg.writer_index;
  if (wi?.enabled === false) return null;
  const home = os.homedir();
  const roots = {
    claudeProjects: wi?.roots?.claudeProjects ?? path.join(home, ".claude", "projects"),
    codex: wi?.roots?.codex ?? path.join(home, ".codex"),
    kimiSessions: wi?.roots?.kimiSessions ?? path.join(home, ".kimi-code", "sessions"),
  };
  const organRoots = cfg.targets.map((t) => ({ system: t.system, home: t.home }));
  return new WriterIndex({
    roots,
    organRoots,
    windowMs: wi?.window_ms,
    eliminationOn: wi?.elimination,
    wdActorMap: wi?.wd_actor_map,
    maxAgeMs: DEFAULT_MAX_AGE_MS,
  });
}
