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
import type { Config, Op, Target, Ticket } from "../types.ts";

export interface BackfillOptions {
  fullHistory?: boolean; // default false → only --since sinceDays
  sinceDays?: number;    // default 90
  maxCommits?: number;   // safety cap (most-recent N), default 2000
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

  const maxCommits = opts.maxCommits ?? 2000;
  const sinceDays = opts.sinceDays ?? 90;

  const logArgs = [
    "log",
    "--reverse",
    "--date-order",
    "--no-renames",
    "--raw",
    "--abbrev=40",
    `--max-count=${maxCommits}`,
    `--format=${REC}commit${UNIT}%H${UNIT}%aI${UNIT}%an${UNIT}%ae${UNIT}%s`,
  ];
  if (!opts.fullHistory) logArgs.push(`--since=${sinceDays} days ago`);
  logArgs.push("--", ...t.watch);

  const res = gitSafe(t.home, logArgs);
  if (!res.ok) return { ...base, note: `git log failed: ${res.out.split("\n")[0]}` };

  // commits already in the ledger (idempotency + incremental top-up)
  const seenCommits = new Set(
    ledger.all().map((x) => x.git_commit).filter((c): c is string => !!c)
  );

  // ignore matcher: reuse the target's runtime-churn ignore globs (D-005)
  const ignoreRes = t.ignore.map(globToRegExp);

  const chunks = res.out.split(REC + "commit" + UNIT).slice(1);
  base.scannedCommits = chunks.length;
  base.truncated = chunks.length >= maxCommits;

  const seqByDay = new Map<string, number>();
  let earliest: string | null = null;
  let latest: string | null = null;

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
    if (seenCommits.has(sha)) {
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
      const rel = line.slice(tab + 1).trim().replace(/\\/g, "/");
      if (!rel) continue;

      // drop runtime churn (ignore globs) + memory binary sqlite (E1)
      if (isMemSqlite(rel) || ignoreRes.some((re) => re.test(rel))) {
        base.droppedFiles++;
        continue;
      }

      const op = statusToOp(status);
      // severity from path only — historical before/after text isn't loaded, so
      // large-rewrite escalation is skipped (backfill tickets are 'observed',
      // never gated/held, so this changes no outcome).
      const severity = classify({ path: rel, op }, cfg).severity;

      // allocate chg-<historical day>-<seq>, guarding against ledger collisions
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
      };
      ledger.append(ticket);
      base.tickets++;
      if (!earliest || ticket.created_at < earliest) earliest = ticket.created_at;
      if (!latest || ticket.created_at > latest) latest = ticket.created_at;
    }
  }

  base.earliest = earliest;
  base.latest = latest;
  const window = opts.fullHistory ? "full history" : `last ${sinceDays}d`;
  base.note =
    base.tickets === 0 && base.skippedCommits === 0
      ? `no organ-definition history in ${window}`
      : `${window}: ${base.tickets} tickets from ${base.scannedCommits - base.skippedCommits} new commit(s)` +
        (base.skippedCommits ? `, ${base.skippedCommits} already recorded` : "") +
        (base.droppedFiles ? `, ${base.droppedFiles} runtime/binary dropped` : "") +
        (base.truncated ? ` (truncated at ${maxCommits} commits — older history not scanned)` : "");
  return base;
}
