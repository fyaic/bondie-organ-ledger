// Platform-agnostic helpers: hashing, canonical JSON, config, jsonl IO, paths.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Config } from "./types.ts";

export function sha256(data: string | Buffer): string {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

// Deterministic key-sorted JSON for hash-chain stability.
export function canonicalJson(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export function uuid(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

// ---- day buckets (single source of truth) --------------------------------
// CONVENTION: `created_at` stores the absolute instant as a UTC ISO string, but
// every "which day did this belong to" decision — change_id buckets, daily
// reports, and the dashboard "today"/explicit-day filters — is made in the
// operator's LOCAL calendar day. Route ALL day comparisons through localDay()
// so report and dashboard can never drift apart on a DST/timezone boundary.
// (The dashboard "recent" filter is deliberately a rolling absolute window, not
// a calendar bucket, so it stays timezone-agnostic.)
export function localDay(value: string | Date = new Date()): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    return typeof value === "string" ? value.slice(0, 10) : "";
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayStamp(d: Date = new Date()): string {
  // YYYYMMDD in local time (change_id day bucket) — same local calendar day as localDay().
  return localDay(d).replace(/-/g, "");
}

export function expandHome(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}

export function loadConfig(ledgerHome?: string): Config {
  const home = expandHome(ledgerHome || defaultLedgerHome());
  const cfgPath = path.join(home, "config.json");
  const raw = fs.readFileSync(cfgPath, "utf8");
  const cfg = JSON.parse(raw) as Config;
  cfg.ledger_home = expandHome(cfg.ledger_home || home);
  return cfg;
}

export function defaultLedgerHome(): string {
  return process.env.ORGANLEDGER_HOME || path.join(os.homedir(), ".organledger");
}

// ---- paths v2 (layout 2): config / audit / state / logs / cache partitions ----
// audit-class paths (tickets/held/reports/config) are UNCHANGED from v1 to keep
// the hash chain byte-identical. state/logs/cache are the new partitions.
export function paths(ledgerHome: string) {
  const h = expandHome(ledgerHome);
  return {
    home: h,
    // config
    config: path.join(h, "config.json"),
    version: path.join(h, "VERSION"),
    // audit (source of truth — unchanged locations)
    tickets: path.join(h, "ledger", "tickets.jsonl"),
    held: path.join(h, "ledger", "held"),
    reports: path.join(h, "reports", "audit"),
    // state (mutable; clearable when stopped) — moved under state/
    state: path.join(h, "state"),
    provenance: path.join(h, "state", "provenance.json"), // GitSource map for the dashboard (recomputable)
    heatmap: path.join(h, "state", "heatmap.json"),       // directory heat treemap for the dashboard (recomputable)
    inbox: path.join(h, "state", "events", "inbox.jsonl"),
    processed: path.join(h, "state", "events", "processed"),
    lock: path.join(h, "state", "daemon.lock"),
    // Phase 2 principal-turn stream (04.2 contract): IM entrypoints (WeCom bridge /
    // feishu hook — OUTSIDE this repo) append-only one turn record per external
    // message; the daemon's PrincipalIndex reads it to JOIN principals onto in-band
    // writes. State-class (rotatable, not an audit source of truth); missing/empty
    // stream ⇒ every write degrades to unknown/local, system still runs.
    principalTurns: path.join(h, "state", "principal", "turns.jsonl"),
    // logs (OrganLedger's own run logs — rotated, deletable)
    logs: path.join(h, "logs"),
    // cache (recomputable)
    cache: path.join(h, "cache"),
  };
}

export function ensureDirs(ledgerHome: string): void {
  const p = paths(ledgerHome);
  for (const d of [
    path.dirname(p.tickets), // ledger/
    p.held,
    p.reports,
    p.processed, // state/events/processed (also creates state/events)
    p.logs,
    p.cache,
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function isInitialized(ledgerHome: string): boolean {
  return fs.existsSync(paths(ledgerHome).config);
}

// Non-throwing config load: returns null when uninitialized (no config.json),
// so the CLI can guide the user to `init` instead of crashing (12.2).
export function loadConfigSafe(ledgerHome?: string): Config | null {
  const home = expandHome(ledgerHome || defaultLedgerHome());
  if (!fs.existsSync(path.join(home, "config.json"))) return null;
  return loadConfig(home);
}

export interface VersionStamp {
  layout: number;
  schema: number;
  organledger_version: string;
  initialized_at: string;
}

export function readVersion(ledgerHome: string): VersionStamp | null {
  const vp = paths(ledgerHome).version;
  if (!fs.existsSync(vp)) return null;
  try {
    return JSON.parse(fs.readFileSync(vp, "utf8")) as VersionStamp;
  } catch {
    return null;
  }
}

// ---- jsonl IO ----
export function appendLine(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // O_APPEND: atomic append across processes/languages.
  fs.appendFileSync(file, JSON.stringify(obj) + "\n", { flag: "a" });
}

export function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const txt = fs.readFileSync(file, "utf8");
  const out: T[] = [];
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      // tolerate a torn last line; skip it.
    }
  }
  return out;
}

// ---- git helpers (only the daemon/committer should mutate; reads are safe anywhere) ----
export function git(home: string, args: string[]): string {
  return execFileSync("git", ["-C", home, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // capture stderr instead of leaking it to the console (clean detect/doctor)
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function gitSafe(home: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: git(home, args) };
  } catch (e) {
    return { ok: false, out: (e as Error).message };
  }
}

// content of a file at HEAD (for before_hash of out-of-band writes), or null.
export function gitShowHead(home: string, relPath: string): string | null {
  const r = gitSafe(home, ["show", `HEAD:${relPath.replace(/\\/g, "/")}`]);
  return r.ok ? r.out : null;
}

export function fileSha(abs: string): string | null {
  try {
    return sha256(fs.readFileSync(abs));
  } catch {
    return null;
  }
}

export function countLines(s: string | null): number {
  if (!s) return 0;
  return s.split(/\r?\n/).length;
}
