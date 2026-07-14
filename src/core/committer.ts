// The ONLY git writer. Debounce (same file within debounce_ms → last state) +
// session squash (same session within session_squash_ms → one logical commit).
// Non-destructive: only `git add <specific files>` — never -A / checkout / reset.
import { git, gitSafe, paths } from "../util.ts";
import type { Ledger } from "./ledger.ts";
import type { Logger } from "../onboard/logger.ts";
import type { Config, Target, Ticket } from "../types.ts";

interface Pending {
  ticket: Ticket;
  target: Target;
}

export class Committer {
  private cfg: Config;
  private ledger: Ledger;
  private pending: Map<string, Pending> = new Map(); // key: home::file (debounce)
  private timer: NodeJS.Timeout | null = null;
  private batchStart = 0;
  private flushing: Promise<void> = Promise.resolve();
  private log: Logger | null;

  constructor(cfg: Config, ledger: Ledger, log: Logger | null = null) {
    this.cfg = cfg;
    this.ledger = ledger;
    this.log = log;
  }

  // schedule an observed ticket for commit
  enqueue(ticket: Ticket, target: Target): void {
    const key = `${target.home}::${ticket.file}`;
    this.pending.set(key, { ticket, target }); // debounce: latest state wins
    if (this.batchStart === 0) this.batchStart = Date.now();
    this.arm();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    const elapsed = Date.now() - this.batchStart;
    const wait = Math.max(
      0,
      Math.min(this.cfg.debounce_ms, this.cfg.session_squash_ms - elapsed)
    );
    this.timer = setTimeout(() => void this.flushNow(), wait);
  }

  // flush immediately; serialized so ledger appends & commits never interleave.
  flushNow(): Promise<void> {
    this.flushing = this.flushing.then(() => this.doFlush());
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = [...this.pending.values()];
    this.pending.clear();
    this.batchStart = 0;
    if (batch.length === 0) return;

    // group by target repo + session (out-of-band null session → group by system)
    const groups = new Map<string, Pending[]>();
    for (const p of batch) {
      const sess = p.ticket.session_id ?? `sys:${p.ticket.system}`;
      const key = `${p.target.home}::${sess}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
    }

    for (const group of groups.values()) {
      await this.commitGroup(group);
    }
  }

  private async commitGroup(group: Pending[]): Promise<void> {
    const home = group[0].target.home;
    // idempotent replay guard: drop tickets already in the ledger
    const fresh = group.filter((p) => !this.ledger.hasChangeId(p.ticket.change_id));
    if (fresh.length === 0) return;

    const files = [...new Set(fresh.map((p) => p.ticket.file))];
    // stage ONLY these files (add handles create/update/delete of the path)
    const add = gitSafe(home, ["add", "--", ...files]);
    if (!add.ok) {
      // record tickets with no commit rather than dropping the audit trail
      this.log?.error("committer", `git add failed (${files.length} file[s]) — tickets recorded with null commit`);
      for (const p of fresh) {
        p.ticket.git_commit = null;
        this.ledger.append(p.ticket);
      }
      return;
    }

    // nothing actually staged (e.g. self-write no-op) → seal ticket at current HEAD
    const staged = gitSafe(home, ["diff", "--cached", "--name-only"]).out.trim();
    if (staged === "") {
      const head = gitSafe(home, ["rev-parse", "--short", "HEAD"]);
      for (const p of fresh) {
        p.ticket.git_commit = head.ok ? head.out : null;
        this.ledger.append(p.ticket);
      }
      return;
    }

    const msg = commitMessage(fresh.map((p) => p.ticket));
    const commit = gitSafe(home, ["commit", "-m", msg]);
    let short: string | null = null;
    if (commit.ok) {
      const rev = gitSafe(home, ["rev-parse", "--short", "HEAD"]);
      short = rev.ok ? rev.out : null;
    }
    for (const p of fresh) {
      p.ticket.git_commit = short;
      this.ledger.append(p.ticket);
    }
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }
}

// 12.4 commit message format.
export function commitMessage(tickets: Ticket[]): string {
  if (tickets.length === 1) {
    const t = tickets[0];
    const sess = t.session_id ?? "none";
    const origin = "none";
    const title = `[${t.change_id}][${t.system}][session:${sess}][origin:${origin}] ${t.op} ${t.file}`;
    const body =
      `reason: ${t.reason ?? "(none)"}\n` +
      `severity: ${t.severity}  status: ${t.status}  author: ${t.author.type}(unverified)`;
    return `${title}\n\n${body}`;
  }
  const first = tickets[0];
  const sess = first.session_id ?? "none";
  const title = `[${first.change_id}..][${first.system}][session:${sess}] ${tickets.length} changes in session ${sess}`;
  const lines = tickets
    .map((t) => `- [${t.change_id}] ${t.op} ${t.file} (severity:${t.severity})`)
    .join("\n");
  return `${title}\n\n${lines}\nauthor: ${first.author.type}(unverified)`;
}
