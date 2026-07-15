// event → change ticket. Fills hashes, allocates change_id, records (unverified)
// author. before_hash/text comes from the git HEAD version for out-of-band writes.
import * as path from "node:path";
import * as fs from "node:fs";
import { gitShowHead, sha256, fileSha, nowIso } from "../util.ts";
import type { Ledger } from "./ledger.ts";
import type { PrincipalIndex } from "./principal-index.ts";
import type {
  OrganEvent, Target, Ticket, TicketAuthor, EventCtx,
  Attribution, Principal, AttributionMatch,
} from "../types.ts";

// Phase 2 extension point. Phase 1 ALWAYS returns verified:false — the honest
// boundary (08 §8.5). Do not promote to true here. (Attribution — the who-caused-it
// dimension — is a SEPARATE additive field with its own verified semantics; see
// resolveAttribution below. TicketAuthor.verified stays literal false forever.)
export function resolveAuthor(ctx: EventCtx): TicketAuthor {
  const type = ctx.author_hint ?? "unknown";
  return { type, id: null, verified: false };
}

// ---- Phase 2: three-axis attribution (04.3 / D1-D6) ------------------------
// Honesty clamp (defense in depth): even if a turn record claims verified:true,
// the invariant is enforced HERE — verified may survive ONLY for a platform IM
// channel with attestation:"platform-attested". Anything else is forced to false.
// This makes the head red line hold regardless of what an out-of-repo entrypoint
// wrote into the stream.
function clampPrincipal(p: Principal): Principal {
  const isAttestedIm =
    p.kind === "im-user" &&
    (p.channel === "wecom" || p.channel === "feishu") &&
    p.attestation === "platform-attested";
  if (p.verified && isAttestedIm) return p; // legitimately verified
  // strip any unearned verified/attestation
  return {
    kind: p.kind,
    channel: p.channel,
    id: p.id,
    display: p.display,
    verified: false,
    attestation: p.attestation === "platform-attested" ? "unverified" : p.attestation,
  };
}

function localPrincipal(): Principal {
  // Local writes are NEVER disambiguated into you / Claude Code / autonomous agent
  // (user decision). One honest bucket: local, unverified.
  return { kind: "local", channel: "local", id: null, display: null, verified: false, attestation: "unverified" };
}

function autonomousPrincipal(): Principal {
  return { kind: "autonomous", channel: null, id: null, display: null, verified: false, attestation: "unverified" };
}

function unknownPrincipal(): Principal {
  return { kind: "unknown", channel: null, id: null, display: null, verified: false, attestation: "unverified" };
}

// Resolve the three-axis attribution for one organ event. Pure over (evt, index):
//   in-band  → writer=agent-runtime; JOIN principal-turn by turn-id → session →
//              time-window; a hit ⇒ requested (faithfulness UNPROVEN); a known
//              session/turn with no principal ⇒ autonomous/self; no context ⇒ unknown.
//   out-of-band → writer=local; principal=local, verified:false (never guessed).
// The git/upstream case is carried by the 1.6 provenance dimension on backfilled
// tickets (those never flow through normalize), so it needs no branch here.
export function resolveAttribution(
  evt: OrganEvent,
  index: PrincipalIndex | null
): Attribution {
  if (evt.source === "in-band") {
    let rec = null as ReturnType<PrincipalIndex["byTurn"]>;
    let match: AttributionMatch = "none";
    if (index) {
      const byT = index.byTurn(evt.ctx.turn_id ?? null);
      if (byT) {
        rec = byT; match = "turn-id";
      } else {
        const byS = index.bySession(evt.ctx.session_id);
        if (byS) {
          rec = byS; match = "session";
        } else {
          const near = index.nearestInSession(evt.ctx.session_id, evt.ts);
          if (near) { rec = near; match = "time-window"; } // weak
        }
      }
    }
    if (rec) {
      return {
        writer: "agent-runtime",
        principal: clampPrincipal(rec.principal),
        autonomy: "requested",     // a principal message existed THIS turn — NOT a faithfulness proof
        turn_id: rec.turn_id,
        match,
      };
    }
    // in-band, no principal correlated:
    //   has a turn/session context ⇒ agent acted on its own (autonomous/self)
    //   no context at all           ⇒ honestly unknown (don't claim autonomous)
    const hasContext = Boolean(evt.ctx.turn_id) || Boolean(evt.ctx.session_id);
    return hasContext
      ? { writer: "agent-runtime", principal: autonomousPrincipal(), autonomy: "self", turn_id: evt.ctx.turn_id ?? null, match: "none" }
      : { writer: "agent-runtime", principal: unknownPrincipal(), autonomy: "unknown", turn_id: null, match: "none" };
  }
  // out-of-band file write (chokidar): no session/turn → local, unverified.
  return { writer: "local", principal: localPrincipal(), autonomy: "unknown", turn_id: null, match: "none" };
}

export interface NormalizeOutput {
  ticket: Ticket;          // status/git_commit still to be set by gate/committer
  beforeText: string | null;
  afterText: string | null;
}

export function normalize(
  evt: OrganEvent,
  target: Target,
  ledger: Ledger,
  principalIndex: PrincipalIndex | null = null
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
    // Phase 2: who-caused-it. Additive; carries its own verified semantics.
    attribution: resolveAttribution(evt, principalIndex),
  };

  return { ticket, beforeText, afterText };
}
