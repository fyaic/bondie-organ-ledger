// GitSource scanner (Phase 1.6 provenance layer). Resolves the git identity of
// each organ folder: a target is NOT one repo — the parent repo governs some
// dirs, but embedded skill repos (each its own GitHub remote, not submodules)
// govern themselves and the parent can't see them. This maps them all.
//
// READ-ONLY on the target: only rev-parse / config / remote get-url / rev-list /
// status --porcelain / log are used. `--fetch` is the single networked exception
// (fetch --quiet, never merge). Resilient like detect.ts: a source that fails to
// parse yields null fields, never a crash.
import * as fs from "node:fs";
import * as path from "node:path";
import { gitSafe, nowIso, paths } from "../util.ts";
import type { Config, Target } from "../types.ts";

export interface GitSource {
  rel: string;                // prefix relative to target.home ("" = parent repo; "skills/eye-on" = nested)
  repo_root: string;          // absolute, `git rev-parse --show-toplevel`
  is_nested: boolean;         // repo_root deeper than target.home
  remote_name: string | null; // tracking remote of the current branch, else origin, else first remote
  remote_url: string | null;
  branch: string | null;      // null when detached HEAD
  head_commit: string | null; // 40-hex
  head_time: string | null;   // committer ISO time of HEAD
  head_subject: string | null;
  upstream: string | null;    // e.g. "origin/0514-hyperlink"; null when no tracking branch
  ahead: number | null;       // commits HEAD is ahead of upstream (null when no upstream)
  behind: number | null;      // commits HEAD is behind upstream
  ahead_behind_as_of: "last-fetch" | "fetched";
  dirty: boolean;             // `git status --porcelain` non-empty = local uncommitted drift
  covers_dirs: string[];      // organ subdirs (relative to target.home) this source governs
}

export interface ResolveOptions {
  fetch?: boolean; // fetch --quiet each source before reading ahead/behind (only networked op)
}

const HEX40 = /^[0-9a-f]{40}$/i;

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

// repo root of `dir`, or null if not inside a work tree.
function revParseToplevel(dir: string): string | null {
  const r = gitSafe(dir, ["rev-parse", "--show-toplevel"]);
  return r.ok && r.out.trim() ? norm(r.out.trim()) : null;
}

// Discover the parent repo (if target.home is a work tree) plus every embedded
// repo under the watched organ dirs. De-duped by repo root. Nested repos are
// found by descending one level into each watched dir (skills/<name>/.git); the
// watched dir itself is also probed (in case it is its own repo).
export function resolveSources(target: Target): GitSource[] {
  const homeAbs = norm(path.resolve(target.home));
  const parentRoot = revParseToplevel(homeAbs);

  // root -> covered organ dirs (relative to home)
  const roots = new Map<string, Set<string>>();
  const ensure = (root: string) => {
    if (!roots.has(root)) roots.set(root, new Set<string>());
    return roots.get(root)!;
  };
  if (parentRoot) ensure(parentRoot);

  // A dir is its OWN source only when its repo root equals the dir itself (a real
  // embedded repo). Otherwise it's governed by an ancestor repo — recorded under
  // that ancestor's top-level watched dir, not as a separate source. This is why
  // rev-parse (not "find a .git dir") is authoritative: a dead/empty `.git` dir
  // resolves upward to the parent, so it never becomes a phantom source.
  for (const w of target.watch) {
    const wAbs = norm(path.join(homeAbs, w));
    if (!fs.existsSync(wAbs)) continue;
    const wRoot = revParseToplevel(wAbs);
    // attribute the watched dir itself to its governing root (parent, or itself if it's a repo)
    if (wRoot === wAbs) ensure(wAbs).add(w);
    else if (wRoot && (wRoot === homeAbs || wRoot.startsWith(homeAbs + "/"))) ensure(wRoot).add(w);
    else if (parentRoot) ensure(parentRoot).add(w);

    let children: fs.Dirent[] = [];
    try {
      children = fs.readdirSync(wAbs, { withFileTypes: true });
    } catch {
      /* unreadable dir — skip */
    }
    for (const c of children) {
      if (!c.isDirectory()) continue;
      const childAbs = norm(path.join(wAbs, c.name));
      const childRoot = revParseToplevel(childAbs);
      // only a child that is its own repo root becomes a nested source; children
      // governed by the parent stay folded under the parent's watched dir `w`.
      if (childRoot === childAbs) ensure(childAbs).add(`${w}/${c.name}`);
    }
  }

  const sources: GitSource[] = [];
  for (const [root, covers] of roots) {
    const relRaw = norm(path.relative(homeAbs, root));
    const isNested = relRaw !== "" && !relRaw.startsWith("..");
    const rel = isNested ? relRaw : "";
    // parent source covers the top-level watched dirs it actually governs;
    // if nothing was explicitly attributed (parent == home, no nested split),
    // fall back to the whole watch list so the panel still shows coverage.
    const coversDirs = [...covers].sort();
    sources.push({
      rel,
      repo_root: root,
      is_nested: isNested,
      covers_dirs: coversDirs.length ? coversDirs : (isNested ? [rel] : target.watch.slice()),
      // identity fields filled by inspectSource
      remote_name: null, remote_url: null, branch: null,
      head_commit: null, head_time: null, head_subject: null,
      upstream: null, ahead: null, behind: null,
      ahead_behind_as_of: "last-fetch", dirty: false,
    });
  }
  // stable order: parent first, then nested by path
  sources.sort((a, b) => (a.is_nested === b.is_nested ? a.rel.localeCompare(b.rel) : a.is_nested ? 1 : -1));
  return sources;
}

// Fill the identity fields of one source (branch/remote/head/upstream/ahead-behind/dirty).
// `--fetch` refreshes ahead/behind against the true upstream (only networked op,
// fetch-only, never merges). Offline the counts are last-known and flagged so.
export function inspectSource(src: GitSource, opts: ResolveOptions = {}): GitSource {
  const root = src.repo_root;
  const out: GitSource = { ...src };

  if (opts.fetch) {
    // best-effort; a fetch failure (offline) must not crash — counts stay last-known
    gitSafe(root, ["fetch", "--quiet"]);
  }
  out.ahead_behind_as_of = opts.fetch ? "fetched" : "last-fetch";

  // branch (detached HEAD → null)
  const br = gitSafe(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  out.branch = br.ok && br.out.trim() && br.out.trim() !== "HEAD" ? br.out.trim() : null;

  // remote: prefer the current branch's tracking remote, else origin, else first remote
  out.remote_name = resolveRemoteName(root, out.branch);
  if (out.remote_name) {
    const url = gitSafe(root, ["remote", "get-url", out.remote_name]);
    out.remote_url = url.ok && url.out.trim() ? url.out.trim() : null;
  }

  // HEAD identity
  const head = gitSafe(root, ["rev-parse", "HEAD"]);
  out.head_commit = head.ok && HEX40.test(head.out.trim()) ? head.out.trim() : null;
  const meta = gitSafe(root, ["log", "-1", "--format=%cI%x1f%s"]);
  if (meta.ok && meta.out.includes("\x1f")) {
    const [t, s] = meta.out.split("\x1f");
    out.head_time = t.trim() || null;
    out.head_subject = (s ?? "").trim() || null;
  }

  // upstream tracking branch (null = no tracking, normal for local-only branches)
  const up = gitSafe(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  out.upstream = up.ok && up.out.trim() ? up.out.trim() : null;

  // ahead/behind vs upstream: `--left-right --count @{u}...HEAD` → "<behind>\t<ahead>"
  // (left = @{u} = behind, right = HEAD = ahead; validated on-site, see 99).
  if (out.upstream) {
    const counts = gitSafe(root, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
    if (counts.ok) {
      const nums = counts.out.trim().split(/\s+/).map((n) => parseInt(n, 10));
      if (nums.length === 2 && nums.every((n) => !Number.isNaN(n))) {
        out.behind = nums[0];
        out.ahead = nums[1];
      }
    }
  }

  // dirty = any uncommitted change in the work tree
  const status = gitSafe(root, ["status", "--porcelain"]);
  out.dirty = status.ok && status.out.trim().length > 0;

  return out;
}

function resolveRemoteName(root: string, branch: string | null): string | null {
  if (branch) {
    const cfg = gitSafe(root, ["config", "--get", `branch.${branch}.remote`]);
    if (cfg.ok && cfg.out.trim()) return cfg.out.trim();
  }
  const remotes = gitSafe(root, ["remote"]);
  if (!remotes.ok) return null;
  const list = remotes.out.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  if (list.includes("origin")) return "origin";
  return list[0] ?? null;
}

// Convenience: resolve + inspect every source in one call.
export function scanSources(target: Target, opts: ResolveOptions = {}): GitSource[] {
  return resolveSources(target).map((s) => inspectSource(s, opts));
}

// ---- provenance.json (the dashboard's read-only data source) ---------------
// The dashboard NEVER runs git — this command/doctor writes the source map to
// state/provenance.json and the board reads that file (architectural red line).

export interface ProvenanceTargetGroup {
  system: string;
  home: string;
  git: boolean;
  sources: GitSource[];
}

export interface ProvenanceReport {
  generated_at: string;
  fetched: boolean;            // did this run --fetch to refresh ahead/behind?
  targets: ProvenanceTargetGroup[];
}

// Scan every git target in the config. Non-git targets are listed empty (honest,
// not omitted). `--fetch` is the only networked path (fetch-only, per source).
export function buildProvenanceReport(cfg: Config, opts: ResolveOptions = {}): ProvenanceReport {
  const targets: ProvenanceTargetGroup[] = cfg.targets.map((t) => ({
    system: t.system,
    home: norm(path.resolve(t.home)),
    git: t.git,
    sources: t.git ? scanSources(t, opts) : [],
  }));
  return { generated_at: nowIso(), fetched: !!opts.fetch, targets };
}

// Persist to state/provenance.json (classified as recomputable state, not audit).
export function writeProvenanceReport(ledgerHome: string, report: ProvenanceReport): string {
  const out = paths(ledgerHome).provenance;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  return out;
}

// Human-readable table for the CLI and the doctor provenance section.
export function formatProvenanceTable(report: ProvenanceReport): string[] {
  const lines: string[] = [];
  const asOf = report.fetched ? "fetched" : "as of last fetch";
  for (const g of report.targets) {
    if (!g.git) {
      lines.push(`  ${g.system} (${g.home}): not a git repo — no sources`);
      continue;
    }
    lines.push(`  ${g.system} (${g.home}) — ${g.sources.length} source(s), ahead/behind ${asOf}:`);
    for (const s of g.sources) {
      const where = s.is_nested ? s.rel : "(parent)";
      const head = s.head_commit ? s.head_commit.slice(0, 7) : "???????";
      const ab = s.upstream
        ? `↓${s.behind ?? "?"} ↑${s.ahead ?? "?"}`
        : "no upstream";
      const dirty = s.dirty ? " ⚠dirty" : "";
      const url = s.remote_url ?? "(no remote)";
      lines.push(`    ${where}  @${s.branch ?? "detached"}  ${head}  ${ab}${dirty}  ${url}`);
    }
  }
  return lines;
}

// D-P10 (Phase 2 extension point — interface + note only, NOT wired here):
// the paths a future real-time watcher would observe to detect a pull/merge on
// each source (HEAD moves, fetch results, branch ref updates). Returned so the
// watcher can be added later without re-deriving repo layout. Not consumed yet.
export function refWatchTargets(sources: GitSource[]): { repo_root: string; paths: string[] }[] {
  return sources.map((s) => ({
    repo_root: s.repo_root,
    paths: [
      path.join(s.repo_root, ".git", "HEAD"),
      path.join(s.repo_root, ".git", "FETCH_HEAD"),
      ...(s.branch ? [path.join(s.repo_root, ".git", "refs", "heads", s.branch)] : []),
    ],
  }));
}
