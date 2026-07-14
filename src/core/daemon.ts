// Single-instance consumer daemon. File lock = the physical guarantee of the
// "one and only committer". Serial drain of the inbox → pipeline.
import * as fs from "node:fs";
import { paths, loadConfig } from "../util.ts";
import { Inbox } from "./inbox.ts";
import { Ledger } from "./ledger.ts";
import { Committer } from "./committer.ts";
import { Pipeline } from "./pipeline.ts";
import type { Config } from "../types.ts";

export class Daemon {
  cfg: Config;
  inbox: Inbox;
  ledger: Ledger;
  committer: Committer;
  pipeline: Pipeline;
  private lockPath: string;
  private draining = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(cfg?: Config) {
    this.cfg = cfg ?? loadConfig();
    const home = this.cfg.ledger_home;
    this.lockPath = paths(home).lock;
    this.inbox = new Inbox(home);
    this.ledger = new Ledger(home);
    this.committer = new Committer(this.cfg, this.ledger);
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
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.drainOnce();
      } catch (e) {
        console.error("[organledger] drain error:", (e as Error).message);
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
