// Run logs for OrganLedger ITSELF (daemon up/down, drain errors, watch EPERM).
// This is NOT the audit trail (that's tickets/git/organ-audit) — run logs expire
// and are deletable (04.1). Tees to console + logs/daemon-YYYY-MM-DD.log; errors
// also to .err.log. Self-rotated by day, old files pruned. No rotation library
// (no_new_heavy_deps). NEVER log file contents or secrets (04.4).
import * as fs from "node:fs";
import * as path from "node:path";
import { paths, nowIso } from "../util.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  private logsDir: string;
  private level: LogLevel;
  private echo: boolean;

  constructor(ledgerHome: string, level: LogLevel = "info", echo = true) {
    this.logsDir = paths(ledgerHome).logs;
    this.level = level;
    this.echo = echo;
    fs.mkdirSync(this.logsDir, { recursive: true });
  }

  private dayFile(err = false): string {
    const day = nowIso().slice(0, 10); // YYYY-MM-DD (UTC)
    return path.join(this.logsDir, `daemon-${day}${err ? ".err" : ""}.log`);
  }

  private write(level: LogLevel, component: string, msg: string): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const line = `[${nowIso()}] [${level.toUpperCase()}] [${component}] ${msg}`;
    try {
      fs.appendFileSync(this.dayFile(false), line + "\n");
      if (level === "error" || level === "warn") fs.appendFileSync(this.dayFile(true), line + "\n");
    } catch {
      /* logging must never crash the daemon */
    }
    if (this.echo) {
      if (level === "error") console.error(line);
      else console.log(line);
    }
  }

  debug(component: string, msg: string): void {
    this.write("debug", component, msg);
  }
  info(component: string, msg: string): void {
    this.write("info", component, msg);
  }
  warn(component: string, msg: string): void {
    this.write("warn", component, msg);
  }
  error(component: string, msg: string): void {
    this.write("error", component, msg);
  }

  // delete daemon-*.log(.err) older than retentionDays (by filename date).
  pruneOld(retentionDays: number): number {
    let removed = 0;
    const cutoff = Date.now() - retentionDays * 86400_000;
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.logsDir);
    } catch {
      return 0;
    }
    for (const f of files) {
      const m = f.match(/^daemon-(\d{4}-\d{2}-\d{2})(\.err)?\.log$/);
      if (!m) continue;
      const t = Date.parse(m[1] + "T00:00:00Z");
      if (!Number.isNaN(t) && t < cutoff) {
        try {
          fs.rmSync(path.join(this.logsDir, f));
          removed++;
        } catch {
          /* ignore */
        }
      }
    }
    return removed;
  }
}

let _singleton: Logger | null = null;

// Process-wide singleton keyed to a ledger home. First call wins the config.
export function getLogger(ledgerHome: string, level: LogLevel = "info"): Logger {
  if (!_singleton) _singleton = new Logger(ledgerHome, level);
  return _singleton;
}

export function resetLoggerForTest(): void {
  _singleton = null;
}
