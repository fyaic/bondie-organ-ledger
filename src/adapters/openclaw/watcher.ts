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
import { globToRegExp } from "../../core/classifier.ts";
import type { Logger } from "../../onboard/logger.ts";
import type { Config, Target, OrganEvent, Op } from "../../types.ts";

export class OpenClawWatcher {
  private cfg: Config;
  private target: Target;
  private inbox: Inbox;
  private audit: OrganAudit;
  private watcher: import("chokidar").FSWatcher | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private ignoreGlobs: RegExp[];
  private log: Logger | null;

  constructor(cfg: Config, target: Target, log: Logger | null = null) {
    this.cfg = cfg;
    this.target = target;
    this.log = log;
    this.inbox = new Inbox(cfg.ledger_home);
    this.audit = new OrganAudit(target.home);
    // Authoritative ignore filter: config globs matched against the RELATIVE,
    // forward-slash organ path. Deterministic regardless of chokidar's path form.
    this.ignoreGlobs = target.ignore.map(globToRegExp);
  }

  // single source of truth for "is this runtime junk, not an organ definition?"
  private shouldIgnore(norm: string): boolean {
    return this.ignoreGlobs.some((r) => r.test(norm));
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
        const rel = String(e.path ?? "?");
        this.audit.skip(rel, `watch-error: ${e.code ?? ""} ${e.message ?? e}`);
        // run log (path + code only — never file contents/secrets)
        this.log?.warn("watcher", `${e.code ?? "watch-error"} ${rel} — skipped, continuing`);
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
      /\.(tmp|lock|pyc|log)$/,
      /\.usage-cost-cache\.json/,
      // runtime state — NOT organ definitions (flooding source; see 99 D-005).
      // Governance scope = jobs.json / flow defs / SKILL.md / AGENTS.md, not run logs.
      /[\\/]cron[\\/]runs[\\/]/,             // cron execution history jsonl
      /[\\/]flows[\\/][^\\/]*\.sqlite/,      // flow registry sqlite (+ -shm/-wal)
      /[\\/]tasks[\\/][^\\/]*\.sqlite/,      // task runs sqlite (+ -shm/-wal)
      /[\\/]outputs[\\/]/,                   // skill run outputs
      // memory main.sqlite stays watched (drives dump-to-md); ignore only its WAL sidecars
      /memory[\\/].*\.sqlite-(shm|wal)$/,
      /memory[\\/]_dump\.md$/,
      /logs([\\/]|$)/,
      /logs[\\/]organ-audit\.jsonl$/,
    ];
  }

  private onFsEvent(rel: string, op: Op): void {
    const norm = rel.replace(/\\/g, "/");

    // authoritative runtime-junk filter (deterministic, relative-path based).
    // memory/main.sqlite is intentionally NOT in ignore → still drives dump-to-md.
    if (this.shouldIgnore(norm)) return;

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
