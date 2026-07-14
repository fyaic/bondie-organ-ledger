// OpenClaw out-of-band adapter: chokidar watches the organ dirs, debounces, and
// appends normalized events to the inbox. Zero git access here (only the daemon
// commits). Ignores self-writes, runtime junk, and symlink escapes.
import * as fs from "node:fs";
import * as path from "node:path";
import chokidar from "chokidar";
import { Inbox } from "../../core/inbox.ts";
import { fileSha, uuid, nowIso } from "../../util.ts";
import { OrganAudit } from "./organ-audit.ts";
import { dumpSqliteToMarkdown } from "./sqlite-dump.ts";
import type { Config, Target, OrganEvent, Op } from "../../types.ts";

export class OpenClawWatcher {
  private cfg: Config;
  private target: Target;
  private inbox: Inbox;
  private audit: OrganAudit;
  private watcher: import("chokidar").FSWatcher | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(cfg: Config, target: Target) {
    this.cfg = cfg;
    this.target = target;
    this.inbox = new Inbox(cfg.ledger_home);
    this.audit = new OrganAudit(target.home);
  }

  start(): void {
    const watchPaths = this.target.watch.map((w) => path.join(this.target.home, w));
    this.watcher = chokidar.watch(watchPaths, {
      cwd: this.target.home,
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      ignored: this.buildIgnores(),
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    this.watcher
      .on("add", (p) => this.onFsEvent(p, "create"))
      .on("change", (p) => this.onFsEvent(p, "update"))
      .on("unlink", (p) => this.onFsEvent(p, "delete"))
      // per-path watch errors (EPERM on locked temp dirs, races on deletes) must
      // NOT crash the single daemon — log to audit and keep watching everything else.
      .on("error", (err: unknown) => {
        const e = err as NodeJS.ErrnoException;
        this.audit.skip(String(e.path ?? "?"), `watch-error: ${e.code ?? ""} ${e.message ?? e}`);
      });
  }

  private buildIgnores(): (string | RegExp)[] {
    // chokidar accepts globs/regex/functions; we pass the config globs plus a
    // function that hard-rejects the ledger's own dump/audit self-writes.
    const globs = this.target.ignore.slice();
    return [
      ...globs,
      /(^|[\\/])\.git([\\/]|$)/,
      /(^|[\\/])\.pytest-tmp([\\/]|$)/,
      /(^|[\\/])\.tmp[\\/]/,
      /(^|[\\/])node_modules([\\/]|$)/,
      /(^|[\\/])__pycache__([\\/]|$)/,
      /(^|[\\/])\.venv([\\/]|$)/,
      // heavy OpenClaw runtime (see 99 D-001): 476MB agents/main + session state
      /[\\/]agents[\\/]main[\\/]/,
      /[\\/]agents[\\/][^\\/]+[\\/]sessions[\\/]/,
      /[\\/]agents[\\/][^\\/]+[\\/]agent[\\/]/,
      /\.(tmp|lock|pyc)$/,
      /\.usage-cost-cache\.json/,
      /memory[\\/]_dump\.md$/,
      /memory[\\/].*\.sqlite-(shm|wal)$/,
      /logs([\\/]|$)/,
      /memory[\\/]_dump\.md$/,
      /logs[\\/]organ-audit\.jsonl$/,
    ];
  }

  private onFsEvent(rel: string, op: Op): void {
    const norm = rel.replace(/\\/g, "/");

    // symlink escape guard: if the real path leaves the organ home, skip + audit.
    const abs = path.join(this.target.home, rel);
    if (this.escapesHome(abs)) {
      this.audit.skip(norm, "symlink-escape: resolved path outside organ home");
      return;
    }

    // debounce per path
    const prev = this.debounceTimers.get(norm);
    if (prev) clearTimeout(prev);
    this.debounceTimers.set(
      norm,
      setTimeout(() => {
        this.debounceTimers.delete(norm);
        this.emit(norm, op, abs);
      }, this.cfg.debounce_ms)
    );
  }

  private escapesHome(abs: string): boolean {
    try {
      const real = fs.realpathSync(abs);
      const homeReal = fs.realpathSync(this.target.home);
      const relToHome = path.relative(homeReal, real);
      return relToHome.startsWith("..") || path.isAbsolute(relToHome);
    } catch {
      return false; // deleted files can't be realpath'd; treat as in-home
    }
  }

  private emit(norm: string, op: Op, abs: string): void {
    const after_hash = op === "delete" ? null : fileSha(abs);

    // memory SQLite change → refresh the git-diffable markdown projection.
    // We govern _dump.md (not the binary sqlite). _dump.md is in the ignore list,
    // so it won't re-trigger the watcher; we emit its event explicitly.
    const memSqlite = this.target.memory_sqlite;
    if (memSqlite && norm === memSqlite.replace(/\\/g, "/")) {
      const dumpRel = "memory/_dump.md";
      const outAbs = path.join(this.target.home, dumpRel);
      const existedBefore = fs.existsSync(outAbs);
      const res = dumpSqliteToMarkdown(abs, outAbs);
      this.audit.write({
        path: norm,
        op,
        event: "organ.write",
        nextHash: after_hash,
        note: res.ok ? res.note : "dump-degraded: " + res.note,
      });
      if (res.ok) {
        this.appendEvent(dumpRel, existedBefore ? "update" : "create", fileSha(outAbs));
      } else {
        // degrade (05.4): emit a hash-only event on the sqlite itself so the
        // change is still audited even without a content dump.
        this.appendEvent(norm, op, after_hash);
      }
      return;
    }

    // coarse provenance seed for Phase 2 (write-only)
    this.audit.write({ path: norm, op, event: "organ.write", nextHash: after_hash });
    this.appendEvent(norm, op, after_hash);
  }

  private appendEvent(norm: string, op: Op, after_hash: string | null): void {
    const evt: OrganEvent = {
      event_id: "evt-" + uuid(),
      ts: nowIso(),
      system: this.target.system,
      source: "out-of-band",
      path: norm,
      op,
      before_hash: null, // normalizer fills from git HEAD
      after_hash,
      ctx: {
        session_id: null, // out-of-band: no session (Phase 2 correlates)
        origin: null,
        author_hint: null,
        reason: null,
        pid: process.pid, // watcher pid, not the true writer (noted for Phase 2)
        argv: null,
      },
    };
    this.inbox.appendEvent(evt);
  }

  async stop(): Promise<void> {
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    if (this.watcher) await this.watcher.close();
  }
}
