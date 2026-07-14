// Non-destructive layout migration v1 (flat) → v2 (partitioned). See 04.6.
// RED LINE: tickets.jsonl is never touched; verify-ledger must pass after, else
// we roll back to the pre-migration backup. audit-class paths are unchanged.
import * as fs from "node:fs";
import * as path from "node:path";
import { paths, readVersion, nowIso, expandHome } from "../util.ts";
import { Ledger } from "../core/ledger.ts";

export const LAYOUT_VERSION = 2;
export const SCHEMA_VERSION = 1;
export const ORGANLEDGER_VERSION = "0.2.0";

export interface MigrateResult {
  migrated: boolean;
  reason: string;
  backup?: string;
  ticketsBefore?: number;
  ticketsAfter?: number;
}

function countTickets(home: string): number {
  const f = paths(home).tickets;
  if (!fs.existsSync(f)) return 0;
  return fs.readFileSync(f, "utf8").split(/\r?\n/).filter((l) => l.trim()).length;
}

// v1 = no VERSION file AND legacy flat artifacts present (root events/ or root daemon.lock)
export function needsMigration(ledgerHome: string): boolean {
  const home = expandHome(ledgerHome);
  const v = readVersion(home);
  if (v && v.layout >= LAYOUT_VERSION) return false;
  const legacyEvents = fs.existsSync(path.join(home, "events"));
  const legacyLock = fs.existsSync(path.join(home, "daemon.lock"));
  const hasLedger = fs.existsSync(paths(home).tickets);
  // migrate if any legacy flat artifact exists, or a ledger exists without a VERSION
  return legacyEvents || legacyLock || (hasLedger && !v);
}

export function backupHome(ledgerHome: string): string {
  const home = expandHome(ledgerHome);
  const dst = `${home}.bak-${nowIso().replace(/[:.]/g, "-")}`;
  fs.cpSync(home, dst, { recursive: true });
  return dst;
}

// Write the version stamp (also used by init on a fresh home).
export function writeVersion(ledgerHome: string, initializedAt?: string): void {
  const home = expandHome(ledgerHome);
  const existing = readVersion(home);
  const stamp = {
    layout: LAYOUT_VERSION,
    schema: SCHEMA_VERSION,
    organledger_version: ORGANLEDGER_VERSION,
    initialized_at: existing?.initialized_at || initializedAt || nowIso(),
  };
  fs.writeFileSync(paths(home).version, JSON.stringify(stamp, null, 2));
}

export function migrateLayout(
  ledgerHome: string,
  opts: { backup?: boolean } = {}
): MigrateResult {
  const home = expandHome(ledgerHome);
  if (!needsMigration(home)) {
    // fresh or already v2 — just ensure the stamp exists
    if (fs.existsSync(paths(home).tickets) || fs.existsSync(paths(home).config)) writeVersion(home);
    return { migrated: false, reason: readVersion(home) ? "already layout>=2" : "nothing to migrate" };
  }

  const ticketsBefore = countTickets(home);
  const backup = opts.backup === false ? undefined : backupHome(home);

  try {
    const p = paths(home);
    fs.mkdirSync(p.state, { recursive: true });
    fs.mkdirSync(path.join(p.state, "events"), { recursive: true });

    // move events/ → state/events/
    const legacyEvents = path.join(home, "events");
    if (fs.existsSync(legacyEvents)) {
      const legacyInbox = path.join(legacyEvents, "inbox.jsonl");
      const legacyProcessed = path.join(legacyEvents, "processed");
      if (fs.existsSync(legacyInbox)) moveInto(legacyInbox, p.inbox);
      if (fs.existsSync(legacyProcessed)) moveInto(legacyProcessed, p.processed);
      // remove now-empty legacy events dir (best effort)
      tryRmdir(legacyEvents);
    }

    // move daemon.lock → state/daemon.lock
    const legacyLock = path.join(home, "daemon.lock");
    if (fs.existsSync(legacyLock)) moveInto(legacyLock, p.lock);

    // new partitions
    fs.mkdirSync(p.logs, { recursive: true });
    fs.mkdirSync(p.cache, { recursive: true });

    writeVersion(home);

    // RED LINE verification
    const v = new Ledger(home).verify();
    const ticketsAfter = countTickets(home);
    if (!v.ok || ticketsAfter !== ticketsBefore) {
      throw new Error(
        `post-migration check failed: chain ok=${v.ok} (${v.detail}); tickets ${ticketsBefore}→${ticketsAfter}`
      );
    }
    return { migrated: true, reason: "v1→v2", backup, ticketsBefore, ticketsAfter };
  } catch (e) {
    // rollback: restore from backup
    if (backup) {
      fs.rmSync(home, { recursive: true, force: true });
      fs.cpSync(backup, home, { recursive: true });
    }
    throw new Error(`migration rolled back to ${backup ?? "(no backup)"}: ${(e as Error).message}`);
  }
}

function moveInto(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst)) {
    // merge: move children (dst already has content from a partial run)
    if (fs.statSync(src).isDirectory()) {
      for (const name of fs.readdirSync(src)) moveInto(path.join(src, name), path.join(dst, name));
      tryRmdir(src);
      return;
    }
    fs.rmSync(dst, { force: true });
  }
  try {
    fs.renameSync(src, dst);
  } catch {
    // cross-device or locked → copy then remove
    fs.cpSync(src, dst, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

function tryRmdir(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch {
    /* not empty / in use — leave it */
  }
}
