// Privacy-preserving directory heatmap (Phase 1.7 feature B). Maps each target's
// directory tree to a treemap where COLOR = change frequency. The head red line
// (equal to 1.6's author.verified): this exposes ONLY structure + heat. It NEVER
// exposes file content / diff / hashes / commit text / secrets. Sensitive paths
// are redacted (name hidden, heat kept). See D1/D2/D5/D6 + 04.2 field whitelist.
//
// READ-ONLY on the target: the ONLY fs op against the target is readdirSync
// (names + entry type). There is NO readFileSync of any target file — we never
// look inside. Frequency comes purely from the ledger (already content-free and
// churn/secret-filtered), so the derived heat is privacy-safe by construction.
import * as fs from "node:fs";
import * as path from "node:path";

import type { Config, OrganSystem, Ticket } from "../types.ts";
import { localDay, nowIso, paths, readJsonl } from "../util.ts";

// ---- 04.2 data contract: the ONLY fields a HeatNode may ever carry ----------
export type HeatType = "dir" | "file";

export interface HeatNode {
  name: string;           // display name; "•••" when redacted
  rel_path: string;       // target-relative path (forward slashes) for OS reveal;
                          // "" for the root, folded-aggregate, and redacted nodes
  type: HeatType;
  change_count: number;   // this node (leaf) or its descendants (dir), within window
  last_change: string | null; // most recent change day YYYY-MM-DD (null if none)
  depth: number;
  redacted: boolean;      // matched a sensitive glob → name hidden, heat KEPT
  truncated?: boolean;    // this dir's children were collapsed/capped (D6)
  children?: HeatNode[];  // dir only
}

export interface HeatmapLimits {
  max_nodes: number;
  max_depth: number;
  max_children: number;
  node_count: number;
  truncated: boolean;
}

export interface HeatmapTarget {
  system: string;
  home: string;
  exists: boolean; // whether the target home dir is present on disk (for the UI's
                   // "configured but not present yet" empty state — e.g. hermes)
  root: HeatNode;
}

export interface HeatmapReport {
  generated_at: string;
  window: "all" | string;
  full_tree: boolean;
  limits: HeatmapLimits;
  targets: HeatmapTarget[];
}

export interface HeatmapOptions {
  window?: string;      // "all" | "Nd"
  changedOnly?: boolean; // default false → full organ tree (D1); true = 1.7's changed-only
  redactOn?: boolean;    // default false → real names for local navigation (D2);
                         // true = redact sensitive globs (name→•••, rel_path→"")
  redact?: string[];     // extra sensitive globs appended to the default set (implies redactOn)
}

// ---- bounds (D6) — never let node_modules / embedded .git blow up or hang ----
const MAX_NODES = 5000;
const MAX_DEPTH = 6;
const MAX_CHILDREN = 200;

// hard exclusions for the full-tree fs walk (in addition to config.ignore).
const HARD_EXCLUDE = new Set([".git", "node_modules", ".venv", "venv", "__pycache__"]);

// default sensitive globs (D2): name hidden, heat kept. --redact appends more.
// NOTE: agents/main is matched at ANY depth (**/agents/main/**), not just root —
// on-site the demo ledger holds nested embedded-repo secrets like
// skills/<x>/agents/main/sessions/sessions.json & auth-profiles.json (P-1 finding).
// The plan's root-anchored glob was an assumption; privacy is the head red line,
// so we redact the sensitive filenames wherever they appear. Recorded in 99.
const DEFAULT_REDACT = [
  "**/agents/main/**",
  "**/credentials/**",
  "**/.env*",
  "**/*.key",
  "**/*.pem",
  "**/*device-auth*",
  "**/auth-profiles*",
  "memory/*.sqlite*",
  "**/secrets/**",
];

// ---- glob → regex (supports ** across separators, * within a segment) -------
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" → optional path prefix; bare "**" → anything incl. separators
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (".+?^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

function matchAny(relPath: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(relPath));
}

// A node is redacted if its path matches a sensitive glob, OR it is the directory
// prefix of a "…/**" glob (so `agents/main` itself is hidden, not just its
// children). Redaction also propagates to descendants (once under a secret dir,
// every name stays hidden) — heat is always preserved.
function buildRedactMatchers(redact: string[]): RegExp[] {
  const all = [...DEFAULT_REDACT, ...redact];
  const globs = all.map(globToRegExp);
  // for each "…/**" glob, also redact the directory itself (so `agents/main` is
  // hidden, not only its children). Works at any depth because the prefix keeps
  // its own leading "**/".
  for (const g of all) {
    if (g.endsWith("/**")) globs.push(globToRegExp(g.slice(0, -3)));
  }
  return globs;
}

// ---- internal mutable build tree --------------------------------------------
interface BuildNode {
  name: string;
  children: Map<string, BuildNode>;
  direct: number;        // tickets whose `file` ends exactly at this node
  last: string | null;   // max local day over this node's direct tickets
  ticketDir: boolean;    // a ticket path ended here with a trailing "/"
  capped: boolean;       // a deeper path was folded here at the MAX_DEPTH bound
}

function newBuild(name: string): BuildNode {
  return { name, children: new Map(), direct: 0, last: null, ticketDir: false, capped: false };
}

function descend(root: BuildNode, segs: string[]): BuildNode {
  let cur = root;
  for (const seg of segs) {
    let child = cur.children.get(seg);
    if (!child) {
      child = newBuild(seg);
      cur.children.set(seg, child);
    }
    cur = child;
  }
  return cur;
}

function windowPredicate(window: string): (t: Ticket) => boolean {
  const m = /^(\d+)d$/.exec(window);
  if (!m) return () => true;
  const cutoff = Date.now() - Number(m[1]) * 24 * 60 * 60 * 1000;
  return (t) => {
    const ms = Date.parse(t.created_at);
    return Number.isNaN(ms) ? false : ms >= cutoff;
  };
}

// Build the changed-only tree for one system from the ledger tickets. Structure
// is the union of paths that ACTUALLY changed — it cannot leak anything the
// ledger doesn't already hold.
function buildChangedTree(root: BuildNode, tickets: Ticket[], system: OrganSystem): void {
  for (const t of tickets) {
    if (t.system !== system) continue;
    const file = (t.file || "").replace(/\\/g, "/");
    const endedSlash = /\/\s*$/.test(file);
    const allSegs = file.split("/").filter(Boolean);
    if (allSegs.length === 0) continue;
    // depth bound (D6): a pathologically deep path (real ledgers contain malformed
    // `file` values, seen on-site: one was 73 segments) folds its heat into its
    // MAX_DEPTH-th ancestor, marked capped — never explodes the tree.
    const overDeep = allSegs.length > MAX_DEPTH;
    const segs = overDeep ? allSegs.slice(0, MAX_DEPTH) : allSegs;
    const node = descend(root, segs);
    node.direct++;
    if (endedSlash || overDeep) node.ticketDir = true;
    if (overDeep) node.capped = true;
    const day = localDay(t.created_at);
    if (day && (!node.last || day > node.last)) node.last = day;
  }
}

// full-tree: add existence-only (count 0) nodes by reading directory entries.
// NEVER reads file contents. Bounded by config.ignore + hard excludes + depth +
// a build-node budget so node_modules / embedded .git can never blow up.
function walkFsInto(
  root: BuildNode,
  homeAbs: string,
  ignore: RegExp[],
  budget: { added: number; truncated: boolean },
): void {
  const walk = (dirAbs: string, node: BuildNode, relBase: string, depth: number): void => {
    if (depth >= MAX_DEPTH) return; // depth cap (D6): stop descending, keep node as-is
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, never crash
    }
    for (const e of entries) {
      if (budget.added >= MAX_NODES) {
        budget.truncated = true;
        return;
      }
      const name = e.name;
      if (HARD_EXCLUDE.has(name)) continue;
      const rel = relBase ? `${relBase}/${name}` : name;
      if (matchAny(rel, ignore)) continue;
      let child = node.children.get(name);
      if (!child) {
        child = newBuild(name);
        node.children.set(name, child);
        budget.added++;
      }
      if (e.isDirectory()) {
        child.ticketDir = true; // real directory on disk
        walk(path.join(dirAbs, name), child, rel, depth + 1);
      }
    }
  };
  walk(homeAbs, root, "", 0);
}

// ---- convert build tree → HeatNode (aggregation + redaction + caps) ----------
interface ConvertCtx {
  count: number;
  truncated: boolean;
  redactGlobs: RegExp[];
  // `redacted` (sensitivity) is ALWAYS computed so the dashboard can offer a
  // client-side "mask for screenshot" toggle. Names/paths are only physically
  // masked in the JSON when redactOn (CLI --redact), for a sanitizable artifact.
  redactOn: boolean;
}

function isRedacted(relPath: string, ctx: ConvertCtx): boolean {
  return matchAny(relPath, ctx.redactGlobs);
}

// D4: file-explorer ordering — directories before files, each name ascending.
// (The folded-tail aggregate is appended by the caller AFTER this sort so it
// always lands last regardless of its name.)
function sortTree(nodes: HeatNode[]): void {
  nodes.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
  );
}

// Recursively fold a BuildNode into a HeatNode. change_count = direct + Σ
// children; last_change = max(direct, children). Applies redaction (name hidden,
// heat kept) and D6 child cap (top MAX_CHILDREN kept, the rest collapsed into a
// "… (N items)" node marked truncated). Honors the global MAX_NODES budget.
function convert(
  node: BuildNode,
  relPath: string,
  depth: number,
  parentRedacted: boolean,
  ctx: ConvertCtx,
): HeatNode {
  ctx.count++;
  // `sensitive` = matches a secret glob (or lives under one). Always computed;
  // whether it actually masks the name/path depends on ctx.redactOn.
  const sensitive = parentRedacted || (relPath !== "" && isRedacted(relPath, ctx));

  const childBuilds = [...node.children.values()];
  let heatChildren: HeatNode[] | undefined;
  let truncatedHere = false;
  let childSum = 0;
  let childLast: string | null = null;

  if (childBuilds.length > 0) {
    // fold every child first (so we can rank by aggregated heat), respecting budget
    const folded: HeatNode[] = [];
    for (const cb of childBuilds) {
      if (ctx.count >= MAX_NODES) {
        ctx.truncated = true;
        truncatedHere = true;
        break;
      }
      const childRel = relPath ? `${relPath}/${cb.name}` : cb.name;
      folded.push(convert(cb, childRel, depth + 1, sensitive, ctx));
    }

    // D6 child cap: rank by heat to keep the hottest MAX_CHILDREN, collapse the
    // COLD tail into one aggregate node (so capping never hides the busy files).
    let display: HeatNode[];
    if (folded.length > MAX_CHILDREN) {
      const byHeat = [...folded].sort(
        (a, b) => b.change_count - a.change_count || a.name.localeCompare(b.name),
      );
      const kept = byHeat.slice(0, MAX_CHILDREN);
      const rest = byHeat.slice(MAX_CHILDREN);
      const restCount = rest.reduce((n, c) => n + c.change_count, 0);
      const restLast = rest.reduce<string | null>(
        (acc, c) => (c.last_change && (!acc || c.last_change > acc) ? c.last_change : acc),
        null,
      );
      sortTree(kept); // D4: display dir-first, name asc…
      kept.push({    // …then the folded-tail aggregate always sits last
        name: `… (已折叠 ${rest.length} 项)`,
        rel_path: "",
        type: "dir",
        change_count: restCount,
        last_change: restLast,
        depth: depth + 1,
        redacted: false,
        truncated: true,
      });
      display = kept;
      truncatedHere = true;
      ctx.truncated = true;
    } else {
      sortTree(folded); // D4: file-explorer order — dir-first, name asc
      display = folded;
    }
    heatChildren = display;

    for (const c of heatChildren) {
      childSum += c.change_count;
      if (c.last_change && (!childLast || c.last_change > childLast)) childLast = c.last_change;
    }
  }

  const isDir = childBuilds.length > 0 || node.ticketDir;
  const lastChange = [node.last, childLast]
    .filter((d): d is string => !!d)
    .reduce<string | null>((acc, d) => (!acc || d > acc ? d : acc), null);

  // physical masking only in redactOn (share) mode; otherwise real names/paths
  // are emitted for local navigation and `redacted` is just an advisory flag.
  const masked = ctx.redactOn && sensitive && relPath !== "";
  const heat: HeatNode = {
    name: masked ? "•••" : node.name,
    // rel_path drives OS reveal; suppressed for the root and (in share mode) for
    // sensitive nodes so a masked node never leaks its true path (D2/D-Reveal).
    rel_path: (ctx.redactOn && sensitive) || relPath === "" ? "" : relPath,
    type: isDir ? "dir" : "file",
    change_count: node.direct + childSum,
    last_change: lastChange,
    depth,
    redacted: sensitive,
  };
  if (isDir) heat.children = heatChildren ?? [];
  if (truncatedHere || node.capped) heat.truncated = true;
  return heat;
}

// ---- public entry: build the whole report -----------------------------------
export function buildHeatmap(cfg: Config, opts: HeatmapOptions = {}): HeatmapReport {
  const window = opts.window || "all";
  // D1: default scope is the full organ tree (looks like a file explorer);
  // --changed-only restores 1.7's changed-paths-only view.
  const fullTree = !opts.changedOnly;
  // D2: sensitivity is ALWAYS computed (so the dashboard can mask on demand), but
  // names/paths are only physically masked when redactOn (CLI --redact). Off by
  // default: local navigation needs real names.
  const redactOn = !!opts.redactOn || (opts.redact?.length ?? 0) > 0;
  const redactGlobs = buildRedactMatchers(opts.redact || []);

  const tickets = readJsonl<Ticket>(paths(cfg.ledger_home).tickets).filter(windowPredicate(window));

  const ctx: ConvertCtx = { count: 0, truncated: false, redactGlobs, redactOn };
  const budget = { added: 0, truncated: false };

  const targets: HeatmapTarget[] = cfg.targets.map((t) => {
    const homeAbs = path.resolve(t.home);
    const exists = fs.existsSync(homeAbs);
    const root = newBuild(t.system);
    root.ticketDir = true;
    buildChangedTree(root, tickets, t.system);

    if (fullTree && exists) {
      const ignore = (t.ignore || []).map(globToRegExp);
      walkFsInto(root, homeAbs, ignore, budget);
    }

    const heatRoot = convert(root, "", 0, false, ctx);
    return { system: t.system, home: homeAbs.replace(/\\/g, "/"), exists, root: heatRoot };
  });

  return {
    generated_at: nowIso(),
    window,
    full_tree: fullTree,
    limits: {
      max_nodes: MAX_NODES,
      max_depth: MAX_DEPTH,
      max_children: MAX_CHILDREN,
      node_count: ctx.count,
      truncated: ctx.truncated || budget.truncated,
    },
    targets,
  };
}

// Persist to state/heatmap.json (recomputable state, mirrors provenance.json).
export function writeHeatmapReport(ledgerHome: string, report: HeatmapReport): string {
  const out = paths(ledgerHome).heatmap;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  return out;
}

// Human-readable one-line summary for the CLI / doctor.
export function formatHeatmapSummary(report: HeatmapReport): string {
  const total = report.targets.reduce((n, t) => n + t.root.change_count, 0);
  const mode = report.full_tree ? "full-tree" : "changed-only";
  const trunc = report.limits.truncated ? " ⚠truncated(已折叠)" : "";
  return `heatmap: ${report.targets.length} target(s) · ${report.limits.node_count} nodes · ${total} changes · window=${report.window} · ${mode}${trunc}`;
}
