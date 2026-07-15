// WeCom principal-turn emitter — the WRITE side of the 04.2 contract (D7).
//
// ┌── REPOSITORY BOUNDARY ────────────────────────────────────────────────────┐
// │ This module is the REFERENCE IMPLEMENTATION of the contract writer. The    │
// │ ACTUAL call site is the self-built WeCom bridge, which lives OUTSIDE this   │
// │ repo at  ~/.cache/bondie-temp/extensions/wecom/src/monitor.ts              │
// │ (handleWecomMessage, just before dispatchReplyWithBufferedBlockDispatcher). │
// │ The bridge inlines the same logic (it cannot import across packages); this  │
// │ file is where the canonical mapping is version-controlled and unit-tested.  │
// └────────────────────────────────────────────────────────────────────────────┘
//
// It appends ONE TurnRecord per inbound external message to
// state/principal/turns.jsonl BEFORE the agent processes it, so a later in-band
// organ write can be JOIN-ed back to the WeCom user who requested it.
//
// Honesty: verified:true here means "platform-authenticated WeCom identity +
// runtime self-report" (attestation:"platform-attested") — NOT cryptographic
// proof. The daemon re-clamps this on read (normalizer.clampPrincipal), so a
// bug here can never manufacture an un-earned verified downstream.
import * as fs from "node:fs";
import * as path from "node:path";
import { paths } from "../../util.ts";
import type { Principal, TurnRecord } from "../../types.ts";

// The fields the WeCom bridge already has in hand at handleWecomMessage:
//   senderId   = wecom userid           (event sender)      → principal.id
//   senderLabel= display name           (best-effort)       → principal.display
//   sessionKey = `wecom-<acct>-<chat>`  (agent session)     → session_id (JOIN key)
//   messageSid = `wecom-<ts>-<senderId>`(unique per message)→ turn_id source
export interface WecomInbound {
  senderId: string;
  senderLabel?: string | null;
  sessionKey: string;
  messageSid: string;
  ts?: string; // ISO8601; caller stamps its own clock
}

// Build the TurnRecord from an inbound WeCom message. Pure — no IO — so it is
// trivially unit-testable and the bridge can call it before appending.
export function wecomTurnRecord(msg: WecomInbound, ts: string): TurnRecord {
  const principal: Principal = {
    kind: "im-user",
    channel: "wecom",
    id: msg.senderId,
    display: msg.senderLabel ?? null,
    verified: true,                       // platform-authenticated WeCom identity…
    attestation: "platform-attested",     // …via agent runtime self-report (NOT crypto proof)
  };
  return {
    turn_id: `wecom:${msg.messageSid}`,   // <channel>:<msgid> convention (globally unique)
    session_id: msg.sessionKey,           // == agent session_id → the JOIN fallback key
    ts_start: ts,
    principal,
  };
}

// Append a TurnRecord to the principal-turn stream under `ledgerHome`. Append-only,
// atomic (O_APPEND), best-effort: a failure to record a turn must NEVER break the
// bridge's message handling — the write just degrades to unknown attribution.
export function appendTurnRecord(ledgerHome: string, rec: TurnRecord): void {
  const file = paths(ledgerHome).principalTurns;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + "\n", { flag: "a" });
}

// Convenience used by the bridge: map + stamp + append in one call. Swallows
// errors on purpose (bridge resilience). Returns the record (or null on failure).
export function emitWecomTurn(
  ledgerHome: string,
  msg: WecomInbound
): TurnRecord | null {
  try {
    const rec = wecomTurnRecord(msg, msg.ts ?? new Date().toISOString());
    appendTurnRecord(ledgerHome, rec);
    return rec;
  } catch {
    return null; // never throw into the bridge's inbound path
  }
}
