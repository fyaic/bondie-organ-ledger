// event → change ticket. Fills hashes, allocates change_id, records (unverified)
// author. before_hash/text comes from the git HEAD version for out-of-band writes.
import * as path from "node:path";
import * as fs from "node:fs";
import { gitShowHead, sha256, fileSha, nowIso } from "../util.ts";
import type { Ledger } from "./ledger.ts";
import type { OrganEvent, Target, Ticket, TicketAuthor, EventCtx } from "../types.ts";

// Phase 2 extension point. Phase 1 ALWAYS returns verified:false — the honest
// boundary (08 §8.5). Do not promote to true here.
export function resolveAuthor(ctx: EventCtx): TicketAuthor {
  const type = ctx.author_hint ?? "unknown";
  return { type, id: null, verified: false };
}

export interface NormalizeOutput {
  ticket: Ticket;          // status/git_commit still to be set by gate/committer
  beforeText: string | null;
  afterText: string | null;
}

export function normalize(
  evt: OrganEvent,
  target: Target,
  ledger: Ledger
): NormalizeOutput {
  const rel = evt.path.replace(/\\/g, "/");
  const abs = path.join(target.home, rel);

  // before: prefer git HEAD content (the version prior to this out-of-band write)
  const beforeText = evt.op === "create" ? null : gitShowHead(target.home, rel);
  const before_hash =
    evt.before_hash ?? (beforeText != null ? sha256(beforeText) : null);

  // after: recompute from disk unless it's a delete
  let afterText: string | null = null;
  let after_hash: string | null = evt.after_hash ?? null;
  if (evt.op !== "delete") {
    after_hash = fileSha(abs) ?? evt.after_hash ?? null;
    try {
      afterText = fs.readFileSync(abs, "utf8");
    } catch {
      afterText = null;
    }
  }

  const ticket: Ticket = {
    change_id: ledger.nextChangeId(),
    system: evt.system,
    source: evt.source,
    author: resolveAuthor(evt.ctx),
    session_id: evt.ctx.session_id,
    origin: evt.ctx.origin,
    file: rel,
    op: evt.op,
    before_hash,
    after_hash,
    reason: evt.ctx.reason,
    severity: "low",           // set by classifier
    status: "observed",        // set by gate
    git_commit: null,          // set by committer
    prev_ticket_hash: "",      // set by ledger.append
    created_at: nowIso(),
  };

  return { ticket, beforeText, afterText };
}
