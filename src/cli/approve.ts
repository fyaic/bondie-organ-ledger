// held closure: approve replays the change into a commit; reject discards it.
import * as fs from "node:fs";
import * as path from "node:path";
import { gitSafe, nowIso, paths } from "../util.ts";
import { commitMessage } from "../core/committer.ts";
import { Ledger } from "../core/ledger.ts";
import type { Config, Ticket } from "../types.ts";

function heldPath(cfg: Config, id: string): string {
  return path.join(paths(cfg.ledger_home).held, `${id}.json`);
}

export function approve(cfg: Config, id: string): string[] {
  const out: string[] = [];
  const hp = heldPath(cfg, id);
  if (!fs.existsSync(hp)) return [`held change not found: ${id}`];
  const t = JSON.parse(fs.readFileSync(hp, "utf8")) as Ticket;
  const target = cfg.targets.find((x) => x.system === t.system);
  if (!target) return [`no target for ${t.system}`];

  // replay: stage the specific file (add handles delete/create/update) and commit
  const add = gitSafe(target.home, ["add", "--", t.file]);
  if (!add.ok) out.push(`git add note: ${add.out}`);
  t.status = "approved";
  const commit = gitSafe(target.home, ["commit", "-m", commitMessage([t])]);
  let short: string | null = null;
  if (commit.ok) {
    const rev = gitSafe(target.home, ["rev-parse", "--short", "HEAD"]);
    short = rev.ok ? rev.out : null;
  } else {
    out.push(`commit note: ${commit.out}`);
  }
  t.git_commit = short;
  t.prev_ticket_hash = "";
  t.created_at = nowIso();
  new Ledger(cfg.ledger_home).append(t);
  fs.rmSync(hp);
  out.push(`approved ${id} → commit ${short ?? "(none)"}; held file removed; ledger updated`);
  return out;
}

export function reject(cfg: Config, id: string): string[] {
  const hp = heldPath(cfg, id);
  if (!fs.existsSync(hp)) return [`held change not found: ${id}`];
  const t = JSON.parse(fs.readFileSync(hp, "utf8")) as Ticket;
  t.status = "rejected";
  t.git_commit = null;
  t.prev_ticket_hash = "";
  t.created_at = nowIso();
  new Ledger(cfg.ledger_home).append(t);
  fs.rmSync(hp);
  return [`rejected ${id}; held file removed; ledger recorded rejection (no git change)`];
}
