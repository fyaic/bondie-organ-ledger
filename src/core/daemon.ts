// Single-instance consumer daemon. File lock = the physical guarantee of the
// "one and only committer". Serial drain of the inbox → pipeline.
import * as fs from "node:fs";
import { paths, loadConfig } from "../util.ts";
import { Inbox } from "./inbox.ts";
import { Ledger } from "./ledger.ts";
import { Committer } from "./committer.ts";
import { Pipeline } from "./pipeline.ts";
import { getLogger, type Logger } from "../onboard/logger.ts";
import type { Config } from "../types.ts";

export class Daemon {
  cfg: Config;
  inbox: Inbox;
  ledger: Ledger;
  committer: Committer;
  pipeline: Pipeline;
  log: Logger;
  private lockPath: string;
  private draining = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(cfg?: Config) {
    this.cfg = cfg ?? loadConfig();
    const home = this.cfg.ledger_home;
    this.lockPath = paths(home).lock;
    this.log = getLogger(home, this.cfg.log_level ?? "info");
    this.inbox = new Inbox(home);
    this.ledger = new Ledger(home);
    this.committer = new Committer(this.cfg, this.ledger, this.log);
    this.pipeline = new Pipeline(this.cfg, this.ledger, this.committer);
  }

  // acquire single-instance lock; returns false if another live daemon holds it.
  acquireLock(): boolean {
    try {
      const fd = fs.openSync(this.lockPath, "wx"); // exclusive create
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch {
      // lock exists — check if the owning process is alive
      const pid = parseInt(fs.readFileSync(this.lockPath, "utf8").trim(), 10);
      if (pid && isAlive(pid)) return false;
      // stale lock → reclaim
      fs.writeFileSync(this.lockPath, String(process.pid));
      return true;
    }
  }

  releaseLock(): void {
    try {
      const pid = parseInt(fs.readFileSync(this.lockPath, "utf8").trim(), 10);
      if (pid === process.pid) fs.rmSync(this.lockPath);
    } catch {
      /* ignore */
    }
  }

  async drainOnce(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    try {
      return await this.inbox.drain((evt) => this.pipeline.process(evt));
    } finally {
      this.draining = false;
    }
  }

  // process everything currently queued and flush pending commits (test-friendly)
  async runToIdle(): Promise<void> {
    await this.drainOnce();
    await this.committer.flushNow();
  }

  start(pollMs = 200): void {
    // prune expired run logs on startup (self-rotation, no library)
    const removed = this.log.pruneOld(this.cfg.log_retention_days ?? 14);
    if (removed) this.log.info("logger", `pruned ${removed} expired run-log file(s)`);
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.drainOnce();
      } catch (e) {
        this.log.error("daemon", `drain error: ${(e as Error).message}`);
      }
      this.pollTimer = setTimeout(tick, pollMs);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    await this.committer.flushNow();
    this.releaseLock();
    this.log.info("daemon", "stopped; lock released");
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours
  }
}

// A live daemon is the single writer of git + ledger. Mutating CLI commands
// (approve/reject/rollback) MUST NOT run concurrently, or independent in-memory
// hash chains corrupt the ledger. Returns the owning pid, or 0 if none live.
export function liveDaemonPid(lockPath: string): number {
  try {
    const pid = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    if (pid && isAlive(pid)) return pid;
  } catch {
    /* no lock */
  }
  return 0;
}
