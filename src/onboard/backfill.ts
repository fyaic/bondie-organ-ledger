// Historical backfill: replay a target's git history into the ledger as
// retroactive tickets, so a freshly-installed dashboard shows organ evolution
// instead of a blank slate. Read-only on the target (git log/show only — never
// writes the target). Honesty boundary preserved: author.verified stays false;
// git author is stored as an UNVERIFIED hint, not proof of who changed the organ.
//
// Idempotent + incremental: commits already represented in the ledger (matched
// by git_commit SHA) are skipped, so re-running only tops up new history.
import { classify, globToRegExp } from "../core/classifier.ts";
import { Ledger } from "../core/ledger.ts";
import { gitSafe } from "../util.ts";
import { scanSources, type GitSource } from "./provenance.ts";
import type { Config, Op, Provenance, Target, Ticket } from "../types.ts";

export interface BackfillOptions {
  fullHistory?: boolean; // default false → only --since sinceDays
  sinceDays?: number;    // default 90
  maxCommits?: number;   // safety cap (most-recent N), default 2000
  noProvenance?: boolean; // skip provenance injection (debug / legacy behavior)
  reflog?: boolean;       // also backfill reflog upstream-update events (pull/merge/clone)
  includeNonUpstream?: boolean; // reflog: also emit local-commit/history-move events (default false)
}

export interface BackfillResult {
  system: string;
  scannedCommits: number;
  tickets: number;
  droppedFiles: number; // runtime/binary/ignored files skipped
  skippedCommits: number; // already-in-ledger (idempotent) commits
  truncated: boolean;   // hit maxCommits — older history not scanned
  earliest: string | null;
  latest: string | null;
  note: string;
}

// NUL-family delimiters keep parsing robust against paths/commit-subject content.
const REC = "\x1e"; // record sep (per-commit)
const UNIT = "\x1f"; // unit sep (header fields)
const ZERO_SHA = /^0+$/;

function isMemSqlite(rel: string): boolean {
  // memory binary sqlite is projected via memory/_dump.md, never a git-diffable
  // organ definition — drop it from history too (same rule as first-scan, E1).
  return /(^|\/)memory\/[^/]*\.sqlite(-shm|-wal)?$/.test(rel);
}

function statusToOp(status: string): Op {
  const s = status[0];
  if (s === "A") return "create";
  if (s === "D") return "delete";
  return "update"; // M, T, C, and anything else → update
}

function dayStampFromIso(iso: string): string {
  // YYYY-MM-DDT... → YYYYMMDD (uses the commit's own date, not today)
  const d = iso.slice(0, 10).replace(/-/g, "");
  return /^\d{8}$/.test(d) ? d : "00000000";
}

// Shared, mutable accumulators threaded across all GitSources of one target so
// change_id day-seq and idempotency stay coherent repo-to-repo.
interface Accum {
  seenCommits: Set<string>;   // git_commit SHAs already in the ledger (idempotent)
  seqByDay: Map<string, number>;
  ignoreRes: RegExp[];        // target-level runtime-churn ignore globs (D-005)
  earliest: string | null;
  latest: string | null;
}

export function backfillFromGitHistory(
  t: Target,
  ledger: Ledger,
  cfg: Config,
  opts: BackfillOptions = {}
): BackfillResult {
  const base: BackfillResult = {
    system: t.system,
    scannedCommits: 0,
    tickets: 0,
    droppedFiles: 0,
    skippedCommits: 0,
    truncated: false,
    earliest: null,
    latest: null,
    note: "",
  };
  if (!t.git) return { ...base, note: "not a git repo — no history to backfill" };

  // A target is NOT one repo (D-P1): the parent repo governs some dirs, but each
  // embedded skill repo is its own GitHub repo the parent can't see. Walk EVERY
  // source so those embedded repos finally get history + provenance.
  const sources = scanSources(t);
  if (sources.length === 0) return { ...base, note: "no git source found under target" };

  const acc: Accum = {
    seenCommits: new Set(ledger.all().map((x) => x.git_commit).filter((c): c is string => !!c)),
    seqByDay: new Map<string, number>(),
    ignoreRes: t.ignore.map(globToRegExp),
    earliest: null,
    latest: null,
  };

  let nested = 0;
  for (const source of sources) {
    if (source.is_nested) nested++;
    backfillOneSource(source, t, ledger, cfg, opts, acc, base);
  }

  base.earliest = acc.earliest;
  base.latest = acc.latest;
  const window = opts.fullHistory ? "full history" : `last ${opts.sinceDays ?? 90}d`;
  const srcNote = `${sources.length} source(s)${nested ? ` incl. ${nested} embedded repo(s)` : ""}`;
  base.note =
    base.tickets === 0 && base.skippedCommits === 0
      ? `no organ-definition history in ${window} across ${srcNote}`
      : `${window}, ${srcNote}: ${base.tickets} tickets from ${base.scannedCommits - base.skippedCommits} new commit(s)` +
        (base.skippedCommits ? `, ${base.skippedCommits} already recorded` : "") +
        (base.droppedFiles ? `, ${base.droppedFiles} runtime/binary dropped` : "") +
        (base.truncated ? ` (truncated at ${opts.maxCommits ?? 2000} commits — older history not scanned)` : "");
  return base;
}

// Replay ONE GitSource's file history into the ledger, prefixing paths to the
// target-relative full path (so the board's path口径 is uniform, D-P7) and
// injecting verified content provenance on each ticket.
function backfillOneSource(
  source: GitSource,
  t: Target,
  ledger: Ledger,
  cfg: Config,
  opts: BackfillOptions,
  acc: Accum,
  base: BackfillResult
): void {
  const maxCommits = opts.maxCommits ?? 2000;
  const sinceDays = opts.sinceDays ?? 90;

  // parent source scopes to the organ dirs it governs; an embedded repo replays
  // its whole tree (".") since ALL of it is that one organ.
  const pathFilter = source.is_nested
    ? ["."]
    : (source.covers_dirs.length ? source.covers_dirs : t.watch);
  // full path prefix relative to target.home (embedded repo → "skills/eye-on/")
  const filePrefix = source.is_nested ? source.rel.replace(/\/+$/, "") + "/" : "";

  // constant per source: verified content provenance (SHA/repo are provable facts)
  const provBase: Omit<Provenance, "to_commit"> | null = opts.noProvenance
    ? null
    : {
        kind: "content",
        repo_root: source.repo_root,
        remote_url: source.remote_url,
        branch: source.branch,
        from_commit: null,
        verified: true,
      };

  const logArgs = [
    "log", "--reverse", "--date-order", "--no-renames", "--raw", "--abbrev=40",
    `--max-count=${maxCommits}`,
    `--format=${REC}commit${UNIT}%H${UNIT}%aI${UNIT}%an${UNIT}%ae${UNIT}%s`,
  ];
  if (!opts.fullHistory) logArgs.push(`--since=${sinceDays} days ago`);
  logArgs.push("--", ...pathFilter);

  const res = gitSafe(source.repo_root, logArgs);
  if (!res.ok) return; // this source's log failed — skip it, keep others (resilient)

  const chunks = res.out.split(REC + "commit" + UNIT).slice(1);
  base.scannedCommits += chunks.length;
  if (chunks.length >= maxCommits) base.truncated = true;

  for (const chunk of chunks) {
    const nl = chunk.indexOf("\n");
    const header = nl === -1 ? chunk : chunk.slice(0, nl);
    const body = nl === -1 ? "" : chunk.slice(nl + 1);
    const parts = header.split(UNIT);
    const sha = parts[0];
    const authorIso = parts[1] || "";
    const authorName = parts[2] || "";
    const authorEmail = parts[3] || "";
    const subject = parts.slice(4).join(UNIT).trim();
    if (!sha) continue;
    if (acc.seenCommits.has(sha)) {
      base.skippedCommits++;
      continue;
    }

    const day = dayStampFromIso(authorIso);
    for (const line of body.split("\n")) {
      if (!line.startsWith(":")) continue;
      const tab = line.indexOf("\t");
      if (tab === -1) continue;
      const meta = line.slice(1, tab).split(/\s+/); // drop leading ':'
      const oldSha = meta[2] || "";
      const newSha = meta[3] || "";
      const status = meta[4] || "M";
      const repoRel = line.slice(tab + 1).trim().replace(/\\/g, "/");
      if (!repoRel) continue;
      const rel = filePrefix + repoRel; // target.home-relative full path

      // drop runtime churn (ignore globs) + memory binary sqlite (E1)
      if (isMemSqlite(rel) || acc.ignoreRes.some((re) => re.test(rel))) {
        base.droppedFiles++;
        continue;
      }

      const op = statusToOp(status);
      // severity from path only — historical before/after text isn't loaded, so
      // large-rewrite escalation is skipped (backfill tickets are 'observed').
      const severity = classify({ path: rel, op }, cfg).severity;

      // allocate chg-<historical day>-<seq>, guarding against ledger collisions
      let seq = (acc.seqByDay.get(day) || 0) + 1;
      let changeId = `chg-${day}-${String(seq).padStart(3, "0")}`;
      while (ledger.hasChangeId(changeId)) {
        seq++;
        changeId = `chg-${day}-${String(seq).padStart(3, "0")}`;
      }
      acc.seqByDay.set(day, seq);

      const ticket: Ticket = {
        change_id: changeId,
        system: t.system,
        source: "out-of-band",
        // honesty boundary: identity unproven. git author is a hint only.
        author: {
          type: "unknown",
          id: authorName ? `git:${authorName} <${authorEmail}>` : null,
          verified: false,
        },
        session_id: `git:${sha.slice(0, 12)}`, // one commit → one squash group
        origin: null,                          // historical commit — no origin signal
        file: rel,
        op,
        before_hash: op === "create" || ZERO_SHA.test(oldSha) ? null : `git:${oldSha}`,
        after_hash: op === "delete" || ZERO_SHA.test(newSha) ? null : `git:${newSha}`,
        reason: subject ? `git: ${subject}` : null,
        severity,
        status: "observed",
        git_commit: sha,
        prev_ticket_hash: "", // sealed by ledger.append
        created_at: authorIso || new Date(0).toISOString(),
        ...(provBase ? { provenance: { ...provBase, to_commit: sha } } : {}),
      };
      ledger.append(ticket);
      base.tickets++;
      if (!acc.earliest || ticket.created_at < acc.earliest) acc.earliest = ticket.created_at;
      if (!acc.latest || ticket.created_at > acc.latest) acc.latest = ticket.created_at;
    }
  }
}

// ---- reflog update-event backfill (D-P2 / D-P8) ----------------------------
// The reflog records HEAD moves per repo. We turn "upstream update" moves
// (pull/merge/clone) into repo-level tickets so the board can show "this organ
// changed because we pulled from upstream" (vs an agent editing a file).
//
// HONEST LIMITS (no silent caps):
//  - git's reflog is pruned (default gc.reflogExpire ≈ 90d) — pulls older than
//    that are unrecoverable. We report the entries scanned; from now on it's complete.
//  - Many repos' reflogs are mostly commit/checkout (no pulls). Zero upstream
//    events is a TRUE result, not a failure — content+provenance carry the value.

export interface ReflogResult {
  system: string;
  scannedEntries: number;
  events: number;              // upstream-update tickets emitted this run
  sourcesWithReflog: number;
  truncated: boolean;          // hit the entry cap on some source
  note: string;
}

const UPSTREAM_KINDS = new Set<Provenance["kind"]>(["pull", "merge", "clone"]);

function reflogKind(subject: string): Provenance["kind"] {
  const s = subject.trim().toLowerCase();
  if (s.startsWith("pull")) return "pull";
  if (s.startsWith("merge")) return "merge";
  if (s.startsWith("clone")) return "clone";
  if (s.startsWith("commit")) return "local-commit";
  return "history-move"; // checkout / reset / rebase / etc.
}

function reflogTime(gd: string): string | null {
  // %gd with --date=iso-strict → "HEAD@{2026-05-14T11:26:11+08:00}"
  const m = gd.match(/\{(.+)\}/);
  return m ? m[1] : null;
}

export function backfillReflog(
  t: Target,
  ledger: Ledger,
  cfg: Config,
  opts: BackfillOptions = {}
): ReflogResult {
  const result: ReflogResult = {
    system: t.system, scannedEntries: 0, events: 0, sourcesWithReflog: 0, truncated: false, note: "",
  };
  if (!t.git) return { ...result, note: "not a git repo — no reflog to backfill" };

  const sources = scanSources(t);
  // idempotency: fingerprints of update-events already recorded
  const seen = new Set<string>();
  for (const x of ledger.all()) {
    const p = x.provenance;
    if (p && UPSTREAM_KINDS.has(p.kind)) seen.add(`${p.repo_root}:${p.from_commit}:${p.to_commit}`);
  }
  const seqByDay = new Map<string, number>();
  const maxEntries = opts.maxCommits ?? 2000;

  for (const source of sources) {
    const entries = readReflog(source.repo_root, maxEntries);
    if (entries.length === 0) continue;
    result.sourcesWithReflog++;
    result.scannedEntries += entries.length;
    if (entries.length >= maxEntries) result.truncated = true;

    for (let i = 0; i < entries.length; i++) {
      const kind = reflogKind(entries[i].subject);
      const isUpstream = UPSTREAM_KINDS.has(kind);
      if (!isUpstream && !opts.includeNonUpstream) continue;

      const to = entries[i].sha;
      const from = entries[i + 1]?.sha ?? null; // older neighbor = value before this move
      const fp = `${source.repo_root}:${from}:${to}`;
      if (seen.has(fp)) continue;
      seen.add(fp);

      const when = reflogTime(entries[i].gd) || new Date(0).toISOString();
      const rel = source.rel || "."; // repo-level event; parent repo → "."
      const day = dayStampFromIso(when);
      let seq = (seqByDay.get(day) || 0) + 1;
      let changeId = `chg-${day}-${String(seq).padStart(3, "0")}`;
      while (ledger.hasChangeId(changeId)) {
        seq++;
        changeId = `chg-${day}-${String(seq).padStart(3, "0")}`;
      }
      seqByDay.set(day, seq);

      const ticket: Ticket = {
        change_id: changeId,
        system: t.system,
        source: "out-of-band",
        author: { type: "unknown", id: null, verified: false }, // who pulled = unproven
        session_id: `reflog:${to.slice(0, 12)}`,
        origin: null,
        file: rel,
        op: "update",
        before_hash: from ? `git:${from}` : null,
        after_hash: `git:${to}`,
        reason: `git ${kind}: ${entries[i].subject.trim()}`,
        severity: classify({ path: rel, op: "update" }, cfg).severity,
        status: "observed",
        git_commit: to,
        prev_ticket_hash: "",
        created_at: when,
        ...(opts.noProvenance ? {} : {
          provenance: {
            kind,
            repo_root: source.repo_root,
            remote_url: source.remote_url,
            branch: source.branch,
            from_commit: from,
            to_commit: to,
            verified: true,
          } satisfies Provenance,
        }),
      };
      ledger.append(ticket);
      result.events++;
    }
  }

  const scope = opts.includeNonUpstream ? "all HEAD moves" : "upstream updates (pull/merge/clone)";
  result.note =
    result.events === 0
      ? `no ${scope} in reflog (${result.scannedEntries} entr${result.scannedEntries === 1 ? "y" : "ies"} scanned across ${result.sourcesWithReflog} source(s); reflog is gc-pruned ≈90d, older history unrecoverable)`
      : `${result.events} ${scope} ticket(s) from ${result.scannedEntries} reflog entr${result.scannedEntries === 1 ? "y" : "ies"} across ${result.sourcesWithReflog} source(s)` +
        (result.truncated ? ` (truncated at ${maxEntries} entries/source)` : "");
  return result;
}

interface ReflogEntry { sha: string; subject: string; gd: string; }

function readReflog(repoRoot: string, maxEntries: number): ReflogEntry[] {
  // `log -g` walks the reflog; --date=iso-strict makes %gd carry the entry time.
  const res = gitSafe(repoRoot, [
    "log", "-g", "--date=iso-strict", `--format=%H${UNIT}%gs${UNIT}%gd`, "-n", String(maxEntries),
  ]);
  if (!res.ok || !res.out.trim()) return [];
  const out: ReflogEntry[] = [];
  for (const line of res.out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [sha, subject, gd] = line.split(UNIT);
    if (!sha) continue;
    out.push({ sha, subject: subject ?? "", gd: gd ?? "" });
  }
  return out;
}
