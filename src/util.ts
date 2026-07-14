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

export function todayStamp(d: Date = new Date()): string {
  // YYYYMMDD in local time (change_id day bucket)
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
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

// ---- paths under ledger_home ----
export function paths(ledgerHome: string) {
  const h = expandHome(ledgerHome);
  return {
    home: h,
    config: path.join(h, "config.json"),
    inbox: path.join(h, "events", "inbox.jsonl"),
    processed: path.join(h, "events", "processed"),
    tickets: path.join(h, "ledger", "tickets.jsonl"),
    held: path.join(h, "ledger", "held"),
    reports: path.join(h, "reports", "audit"),
    lock: path.join(h, "daemon.lock"),
  };
}

export function ensureDirs(ledgerHome: string): void {
  const p = paths(ledgerHome);
  for (const d of [
    path.dirname(p.inbox),
    p.processed,
    path.dirname(p.tickets),
    p.held,
    p.reports,
  ]) {
    fs.mkdirSync(d, { recursive: true });
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
