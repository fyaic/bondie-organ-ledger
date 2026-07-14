// `organledger init` — zero-hand-written-JSON onboarding. Detect → config →
// dirs → migrate → first-scan → doctor → finish. Idempotent & non-destructive.
import * as fs from "node:fs";
import * as path from "node:path";
import { paths, ensureDirs, loadConfigSafe, expandHome, nowIso } from "../util.ts";
import { detectEnvironment, type Detection, type DetectedTarget } from "./detect.ts";
import { migrateLayout, writeVersion, ORGANLEDGER_VERSION } from "./migrate.ts";
import { getLogger } from "./logger.ts";
import { gitSafe } from "../util.ts";
import { Ledger } from "../core/ledger.ts";
import { backfillFromGitHistory } from "./backfill.ts";
import type { Config, Target, SeverityRule } from "../types.ts";

// Runtime-churn exclusions converged in Phase 1 (D-005). Single source shared by
// config.ignore and the target .gitignore.
export const DEFAULT_IGNORE = [
  "**/node_modules/**", "**/__pycache__/**", "**/.venv/**", "**/venv/**",
  "**/*.pyc", "**/*.tmp", "**/*.lock", "**/*.bak", "**/*.bak-*", "**/.git/**",
  "agents/main/**", "agents/*/sessions/**", "agents/*/agent/**",
  "**/.usage-cost-cache.json",
  "memory/_dump.md", "memory/*.sqlite-shm", "memory/*.sqlite-wal",
  "logs/**", "**/*.log", "**/outputs/**", "cron/runs/**",
  "flows/*.sqlite", "flows/*.sqlite-shm", "flows/*.sqlite-wal",
  "tasks/*.sqlite", "tasks/*.sqlite-shm", "tasks/*.sqlite-wal",
];

const DEFAULT_SEVERITY_RULES: SeverityRule[] = [
  { glob: "skills/**", severity: "high", delete_gate: "held" },
  { glob: "agents/**", severity: "high", rewrite_ratio_critical: 0.5 },
  { glob: "cron/**", severity: "high" },
  { glob: "flows/**", severity: "high" },
  { glob: "memory/**", severity: "medium" },
  { glob: "tasks/**", severity: "low" },
];

export interface InitOptions {
  home: string;
  yes?: boolean;
  openclaw?: string;
  hermes?: string;
  noSnapshot?: boolean;
  noBackfill?: boolean;   // skip historical git-history backfill
  fullHistory?: boolean;  // backfill ALL history (default: last 90 days)
  // live-print each line as it's produced (so an interactive prompt lands AFTER
  // the preceding steps are shown). Lines are still returned in the result too.
  emit?: (line: string) => void;
  // interactive gate for the first-scan snapshot: return true to snapshot. Only
  // consulted when neither --yes nor --no-snapshot is set. Absent → skip.
  confirmSnapshot?: () => boolean;
}

export interface InitResult {
  lines: string[];
  configPath: string;
}

function targetFromDetected(d: DetectedTarget): Target {
  return {
    system: d.system,
    home: d.home.replace(/\\/g, "/"),
    watch: d.organDirs.length ? d.organDirs : (d.system === "openclaw"
      ? ["skills", "agents", "cron", "tasks", "flows", "memory"]
      : ["skills", "memories", "cron"]),
    git: d.isGitRepo,
    ...(d.system === "openclaw" ? { memory_sqlite: "memory/main.sqlite" } : {}),
    ignore: DEFAULT_IGNORE.slice(),
  };
}

export function buildConfig(home: string, det: Detection, existing?: Config | null): Config {
  const usable = det.targets.filter((t) => t.usable);
  const targets = usable.map(targetFromDetected);
  const merged: Config = {
    layout_version: 2,
    ledger_home: expandHome(home).replace(/\\/g, "/"),
    log_level: existing?.log_level ?? "info",
    log_retention_days: existing?.log_retention_days ?? 14,
    processed_retention_days: existing?.processed_retention_days ?? 7,
    // merge: keep existing user-tuned targets, add newly detected ones by system+home
    targets: mergeTargets(existing?.targets ?? [], targets),
    severity_rules: existing?.severity_rules ?? DEFAULT_SEVERITY_RULES,
    rewrite_ratio_critical: existing?.rewrite_ratio_critical ?? 0.5,
    debounce_ms: existing?.debounce_ms ?? 3000,
    session_squash_ms: existing?.session_squash_ms ?? 15000,
    gate: existing?.gate ?? { default: "observe", held_on: ["critical", "delete"] },
  };
  return merged;
}

function mergeTargets(existing: Target[], detected: Target[]): Target[] {
  const out = existing.slice();
  for (const d of detected) {
    if (!out.some((e) => e.system === d.system && e.home === d.home)) out.push(d);
  }
  return out;
}

// Append missing runtime-exclusion patterns to the target's .gitignore (non-destructive).
export function ensureTargetGitignore(targetHome: string): { wrote: boolean; added: number } {
  const gi = path.join(targetHome, ".gitignore");
  let existing = "";
  try {
    existing = fs.readFileSync(gi, "utf8");
  } catch {
    /* none yet */
  }
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const wanted = gitignorePatterns();
  const missing = wanted.filter((p) => !have.has(p));
  if (missing.length === 0) return { wrote: false, added: 0 };
  const header = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(
    gi,
    header + "\n# --- OrganLedger: runtime state (not organ definitions) ---\n" + missing.join("\n") + "\n"
  );
  return { wrote: true, added: missing.length };
}

// gitignore-friendly forms of the runtime exclusions.
function gitignorePatterns(): string[] {
  return [
    "node_modules/", "__pycache__/", ".venv/", "venv/",
    "*.pyc", "*.tmp", "*.lock",
    "agents/main/", "agents/*/sessions/", "agents/*/agent/",
    ".usage-cost-cache.json",
    "memory/_dump.md", "memory/*.sqlite-shm", "memory/*.sqlite-wal",
    "logs/", "*.log", "outputs/", "cron/runs/",
    "flows/*.sqlite", "flows/*.sqlite-shm", "flows/*.sqlite-wal",
    "tasks/*.sqlite", "tasks/*.sqlite-shm", "tasks/*.sqlite-wal",
    // memory sqlite is git-ignored (binary); its git-diffable projection is memory/_dump.md.
    // NOTE: this is git's exclusion — the watcher still watches main.sqlite (config.ignore
    // does NOT list it) so a change triggers the dump.
    "memory/*.sqlite",
  ];
}

// Scoped, non-destructive first-scan snapshot of a git target (reuses Phase-1
// D-001 scoping: only organ definitions; exclude gitlinks, >5MB binaries).
export function firstScanSnapshot(t: Target): string[] {
  const out: string[] = [];
  const home = t.home;
  if (!t.git) {
    out.push(`  ${t.system}: not a git repo — skipping snapshot (git init deferred to Phase 2)`);
    return out;
  }
  const gi = ensureTargetGitignore(home);
  out.push(`  ${t.system}: .gitignore ${gi.wrote ? `+${gi.added} runtime patterns` : "already complete"}`);

  // stage only the watched organ dirs (git respects the .gitignore just written)
  const add = gitSafe(home, ["add", "--", ...t.watch]);
  if (!add.ok) {
    out.push(`  ${t.system}: git add note — ${add.out.split("\n")[0]}`);
    return out;
  }
  // drop gitlinks (embedded repos) and oversized binaries from the snapshot
  const staged = gitSafe(home, ["diff", "--cached", "--name-only"]).out.split(/\r?\n/).filter(Boolean);
  let dropped = 0;
  for (const f of staged) {
    const mode = gitSafe(home, ["ls-files", "--stage", "--", f]).out.split(/\s+/)[0];
    let big = false;
    try {
      big = fs.statSync(path.join(home, f)).size > 5_000_000;
    } catch {
      /* deleted */
    }
    // drop: embedded-repo gitlinks, >5MB binaries, and memory sqlite (projected via dump)
    const isMemSqlite = /(^|\/)memory\/[^/]*\.sqlite(-shm|-wal)?$/.test(f.replace(/\\/g, "/"));
    if (mode === "160000" || big || isMemSqlite) {
      gitSafe(home, ["reset", "-q", "--", f]);
      dropped++;
    }
  }
  const finalStaged = gitSafe(home, ["diff", "--cached", "--name-only"]).out.split(/\r?\n/).filter(Boolean);
  if (finalStaged.length === 0) {
    out.push(`  ${t.system}: nothing new to snapshot (already at water line)`);
    return out;
  }
  const commit = gitSafe(home, [
    "commit", "-m",
    "chore(organledger): first-scan snapshot (scoped organ definitions)",
  ]);
  if (commit.ok) {
    const short = gitSafe(home, ["rev-parse", "--short", "HEAD"]).out;
    out.push(`  ${t.system}: snapshot ${short} (${finalStaged.length} files${dropped ? `, ${dropped} runtime/binary dropped` : ""})`);
  } else {
    out.push(`  ${t.system}: snapshot note — ${commit.out.split("\n")[0]}`);
  }
  return out;
}

export function runInit(opts: InitOptions): InitResult {
  const home = expandHome(opts.home);
  const lines: string[] = [];
  const push = (...ls: string[]) => {
    for (const l of ls) {
      lines.push(l);
      opts.emit?.(l);
    }
  };
  push("OrganLedger init");
  push("================");

  // Step 1: detect
  const det = detectEnvironment({ openclaw: opts.openclaw, hermes: opts.hermes });
  push(`\n[1/7] Environment`);
  push(`  node ${det.nodeVersion} ${det.nodeOk ? "✓" : "✗ (need ≥24)"}  |  git ${det.gitVersion ?? "MISSING"}`);
  for (const t of det.targets) push(`  ${t.system}: ${t.note}`);

  // Step 2: config (generate or merge)
  const existing = loadConfigSafe(home);
  const cfg = buildConfig(home, det, existing);
  push(`\n[2/7] Config`);
  push(`  ${existing ? "merged with existing" : "generated"} config.json — ${cfg.targets.length} target(s): ${cfg.targets.map((t) => t.system).join(", ") || "(none usable yet)"}`);

  // Step 3: dirs + migrate + version
  ensureDirs(home);
  push(`\n[3/7] Layout`);
  const mig = migrateLayout(home);
  push(mig.migrated
    ? `  migrated v1→v2 (tickets ${mig.ticketsBefore}→${mig.ticketsAfter}, backup ${mig.backup})`
    : `  layout v2 ready (${mig.reason})`);
  writeVersion(home);
  // write config AFTER migrate (so it lands in the final layout)
  fs.writeFileSync(paths(home).config, JSON.stringify(cfg, null, 2));

  // Step 4: historical backfill — replay target git history into the ledger so the
  // dashboard shows organ evolution instead of a blank slate. Read-only on target;
  // idempotent (skips commits already recorded). author.verified stays false.
  push(`\n[4/7] History backfill`);
  if (opts.noBackfill) {
    push(`  skipped (--no-backfill)`);
  } else {
    const ledger = new Ledger(home);
    for (const t of cfg.targets) {
      if (!t.git) {
        push(`  ${t.system}: not a git repo — no history to backfill`);
        continue;
      }
      const r = backfillFromGitHistory(t, ledger, cfg, { fullHistory: opts.fullHistory });
      const span = r.earliest && r.latest ? `  [${r.earliest.slice(0, 10)} → ${r.latest.slice(0, 10)}]` : "";
      push(`  ${t.system}: ${r.note}${span}`);
    }
    // RED LINE: backfill must not break the hash chain
    const v = new Ledger(home).verify();
    push(`  chain: ${v.ok ? "intact ✓" : "BROKEN@" + v.brokenIndex + " ✗"} (${v.detail})`);
  }

  // Step 5: first-scan water line. Writes ONE scoped commit per git target, so it
  // is gated: --yes snapshots non-interactively, --no-snapshot skips, otherwise
  // confirmSnapshot() (an interactive y/N) decides. No callback → skip (safe default).
  push(`\n[5/7] First-scan water line`);
  const doSnapshot =
    opts.noSnapshot ? false
    : opts.yes ? true
    : opts.confirmSnapshot ? opts.confirmSnapshot()
    : false;
  if (opts.noSnapshot) {
    push(`  skipped (--no-snapshot)`);
  } else if (doSnapshot) {
    for (const t of cfg.targets) push(...firstScanSnapshot(t));
  } else {
    push(`  skipped — no snapshot taken. Re-run 'organledger init' and answer y, or pass --yes.`);
  }

  // Step 6: self-check (lightweight; full report via `doctor`)
  push(`\n[6/7] Self-check`);
  const log = getLogger(home, cfg.log_level ?? "info");
  log.info("init", `initialized layout v2, ${cfg.targets.length} target(s)`);
  push(`  logs → ${paths(home).logs}  |  run 'organledger doctor' for full health report`);

  // Step 7: finish
  push(`\n[7/7] Done ✅  organledger v${ORGANLEDGER_VERSION}`);
  push(`  Next: 'organledger daemon' to start governing.`);
  push(`  'organledger paths' shows where everything lives.`);

  return { lines, configPath: paths(home).config };
}
