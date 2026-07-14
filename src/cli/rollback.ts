// Rollback CLI. NON-DESTRUCTIVE IRON RULE: always create a safety branch first;
// never reset --hard user work. Every rollback appends a rolled_back ticket so
// the append-only ledger stays auditable.
import { git, gitSafe, nowIso, readJsonl, paths } from "../util.ts";
import { Ledger } from "../core/ledger.ts";
import type { Config, Ticket } from "../types.ts";

export interface RollbackArgs {
  change?: string;
  session?: string;
  before?: string;
  confirm?: boolean;
}

export function rollback(cfg: Config, args: RollbackArgs): string[] {
  const out: string[] = [];
  const ledger = new Ledger(cfg.ledger_home);
  const tickets = ledger.all();

  if (args.change) {
    const t = tickets.find((x) => x.change_id === args.change);
    if (!t) return [`change not found: ${args.change}`];
    if (!t.git_commit) return [`change ${args.change} has no git_commit (held/rejected?)`];
    const target = targetFor(cfg, t);
    if (!target) return [`no target for system ${t.system}`];
    safetyBranch(target.home, out);
    const r = gitSafe(target.home, ["revert", "--no-edit", t.git_commit]);
    out.push(r.ok ? `reverted ${t.git_commit} (${t.file})` : `revert failed: ${r.out}`);
    if (r.ok) appendRolledBack(ledger, cfg, t, out);
    return out;
  }

  if (args.session) {
    const grp = tickets.filter((x) => (x.session_id ?? "none") === args.session && x.git_commit);
    if (grp.length === 0) return [`no committed changes for session ${args.session}`];
    const target = targetFor(cfg, grp[0])!;
    safetyBranch(target.home, out);
    // revert newest-first to avoid conflicts
    for (const t of grp.reverse()) {
      const r = gitSafe(target.home, ["revert", "--no-edit", t.git_commit!]);
      out.push(r.ok ? `reverted ${t.git_commit} (${t.file})` : `revert failed ${t.git_commit}: ${r.out}`);
      if (r.ok) appendRolledBack(ledger, cfg, t, out);
    }
    return out;
  }

  if (args.before) {
    if (!args.confirm) {
      return [
        `--before is destructive-adjacent; re-run with --confirm.`,
        `It will create a safety branch at the current HEAD and a new branch reset to before ${args.before}. main is NOT touched.`,
      ];
    }
    for (const target of cfg.targets) {
      if (!target.git) continue;
      safetyBranch(target.home, out);
      const branch = `organledger-rollback/${stamp()}`;
      // find first commit at/after the timestamp, branch to its parent
      const rev = gitSafe(target.home, ["rev-list", "-1", `--before=${args.before}`, "HEAD"]);
      if (rev.ok && rev.out) {
        const b = gitSafe(target.home, ["branch", branch, rev.out]);
        out.push(b.ok ? `created ${branch} at ${rev.out} (main untouched)` : `branch failed: ${b.out}`);
      } else {
        out.push(`no commit before ${args.before} in ${target.home}`);
      }
    }
    return out;
  }

  return ["specify one of --change <id> | --session <id> | --before <ts> [--confirm]"];
}

function safetyBranch(home: string, out: string[]): void {
  const branch = `organledger-safety/${stamp()}`;
  const r = gitSafe(home, ["branch", branch]);
  out.push(r.ok ? `safety branch: ${branch}` : `safety branch note: ${r.out}`);
}

function appendRolledBack(ledger: Ledger, cfg: Config, orig: Ticket, out: string[]): void {
  const home = targetFor(cfg, orig)?.home ?? ".";
  const head = gitSafe(home, ["rev-parse", "--short", "HEAD"]);
  const t: Ticket = {
    ...orig,
    change_id: ledger.nextChangeId(),
    status: "rolled_back",
    git_commit: head.ok ? head.out : null,
    reason: `rollback of ${orig.change_id}`,
    prev_ticket_hash: "",
    created_at: nowIso(),
  };
  ledger.append(t);
  out.push(`ledger: appended rolled_back ticket ${t.change_id}`);
}

function targetFor(cfg: Config, t: Ticket) {
  return cfg.targets.find((x) => x.system === t.system);
}

function stamp(): string {
  return nowIso().replace(/[:.]/g, "-");
}
