// Five-step serial pipeline: normalize → classify → gate → (held | committer) → ledger.
import * as fs from "node:fs";
import * as path from "node:path";
import { paths } from "../util.ts";
import { normalize } from "./normalizer.ts";
import { classify } from "./classifier.ts";
import { gate } from "./gate.ts";
import type { Ledger } from "./ledger.ts";
import type { Committer } from "./committer.ts";
import type { Config, OrganEvent, Target } from "../types.ts";

export class Pipeline {
  private cfg: Config;
  private ledger: Ledger;
  private committer: Committer;

  constructor(cfg: Config, ledger: Ledger, committer: Committer) {
    this.cfg = cfg;
    this.ledger = ledger;
    this.committer = committer;
  }

  private targetFor(evt: OrganEvent): Target | undefined {
    return this.cfg.targets.find((t) => t.system === evt.system);
  }

  async process(evt: OrganEvent): Promise<void> {
    const target = this.targetFor(evt);
    if (!target) return; // unknown system → ignore (kept in archive)

    // 1. normalize
    const { ticket, beforeText, afterText } = normalize(evt, target, this.ledger);

    // idempotent replay guard (crash mid-drain)
    if (this.ledger.hasChangeId(ticket.change_id)) return;

    // 2. classify
    const cls = classify(
      { path: ticket.file, op: ticket.op, beforeText, afterText },
      this.cfg
    );
    ticket.severity = cls.severity;

    // 3. gate
    const g = gate(ticket.severity, ticket.op, this.cfg);
    ticket.status = g.status;

    if (g.status === "held") {
      // 4a. held — write pending, append to ledger, DO NOT commit
      ticket.git_commit = null;
      const heldFile = path.join(paths(this.cfg.ledger_home).held, `${ticket.change_id}.json`);
      fs.mkdirSync(path.dirname(heldFile), { recursive: true });
      fs.writeFileSync(heldFile, JSON.stringify(ticket, null, 2));
      this.ledger.append(ticket);
      return;
    }

    // 4b. observed — hand to the single committer (debounce + session squash → ledger)
    this.committer.enqueue(ticket, target);
  }
}
