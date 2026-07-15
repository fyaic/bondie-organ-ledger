# principal-turn contract (OrganLedger Phase 2)

The **write side** of OrganLedger's identity/principal layer. IM entrypoints
(WeCom bridge, feishu hook, …) — which live **outside this repo** — append one
turn record per inbound external message. OrganLedger's daemon reads the stream
and JOINs the principal onto in-band organ writes. This file is the stable
contract those out-of-repo entrypoints implement.

> Honesty boundary (non-negotiable): `verified:true` means *platform-authenticated
> IM identity + agent-runtime self-report* (`attestation:"platform-attested"`) —
> **not** cryptographic proof. A compromised runtime can forge it. The daemon
> re-clamps every record on read (`normalizer.clampPrincipal`), so a buggy or
> malicious entrypoint can never manufacture an unearned `verified` downstream.

## Stream location & semantics

- File: `<ORGANLEDGER_HOME>/state/principal/turns.jsonl` (default home `~/.organledger`).
- **Append-only**, one JSON object per line. Never rewrite; never touch the ledger.
- **State-class** (rotatable, recomputable) — NOT an audit source of truth.
- Contract-first: if the stream is missing / empty / partially torn, OrganLedger
  degrades every write to `principal=unknown` (or `local` for out-of-band) and
  keeps running. Entrypoints are therefore optional — attribution just improves
  as more of them are wired.

## Record shape

```jsonc
{
  "turn_id": "wecom:wecom-1699999999-wm_zhang", // globally unique; convention <channel>:<msgid>
  "session_id": "wecom-acct1-chatX",             // the agent session this turn maps to (JOIN fallback)
  "ts_start": "2026-07-14T10:00:00.000Z",        // ISO8601 UTC, when the entrypoint received the message
  "principal": {
    "kind": "im-user",                           // im-user | local | autonomous | unknown
    "channel": "wecom",                          // wecom | feishu | local | cron | git | null
    "id": "wm_zhang",                            // wecom userid / feishu open_id; null for local/autonomous
    "display": "张三",                            // best-effort display name
    "verified": true,                            // ONLY im-user + platform-attested may be true
    "attestation": "platform-attested"           // verified:true ⇒ this exact value
  }
}
```

## JOIN algorithm (read side, `normalizer.resolveAttribution`)

For an **in-band** organ write, `writer = "agent-runtime"` and the principal is
resolved in descending strength (the ticket records which via `match`):

1. `byTurn(ctx.turn_id)` — exact. `match:"turn-id"`.
2. `bySession(ctx.session_id)` — only if the session has ONE unambiguous
   principal. `match:"session"`.
3. `nearestInSession(ctx.session_id, ts, ±5min)` — weak, shown as a weak
   correlation. `match:"time-window"`.
4. none → `principal=autonomous, autonomy:"self"` (agent acted on its own) if a
   turn/session context exists, else `principal=unknown, autonomy:"unknown"`.

`autonomy:"requested"` proves a principal's message existed **this turn** — it
does **NOT** prove the write faithfully reflects the request (faithfulness is not
provable here; shown on the board as "忠实性未证").

**out-of-band** writes (chokidar file watcher) have no session/turn →
`writer:"local", principal:{kind:"local", verified:false}`. Local changes are
never disambiguated into you / Claude Code / autonomous agent (user decision).

---

## Entrypoint A — WeCom bridge (self-built, REAL instrumentation ✅)

Reference implementation: `src/adapters/wecom/principal-turn.ts` (unit-tested).
Live call site (out-of-repo): `~/.cache/bondie-temp/extensions/wecom/src/monitor.ts`
→ `handleWecomMessage()`, right before `dispatchReplyWithBufferedBlockDispatcher`.
The fields are already in scope there:

| bridge var   | → record field       | note                                   |
|--------------|----------------------|----------------------------------------|
| `senderId`   | `principal.id`       | platform-authenticated WeCom userid    |
| `senderLabel`| `principal.display`  | best-effort display name               |
| `sessionKey` | `session_id`         | `wecom-<acct>-<chat>` = the agent session (JOIN key) |
| `messageSid` | `turn_id` (prefixed) | `wecom:<messageSid>`                    |

```ts
// inlined in the bridge (cannot import across packages); guarded so a failure
// NEVER affects message handling — attribution just degrades to unknown.
emitPrincipalTurn({ senderId, senderLabel, sessionKey, messageSid });
```

**turn_id alignment:** the agent must stamp its in-band organ writes with the same
`turn_id` (`wecom:<messageSid>`), or at minimum run in the same `session_id`
(`sessionKey`) so the session / time-window fallback can still JOIN.

---

## Entrypoint B — feishu (official plugin) — ⏳ DEGRADED (black box, D8)

**Status (probed 2026-07-14):** the feishu integration on this host is present
only as *outbound* skills (`plugin-skills/feishu-doc|drive|perm|wiki`) plus
credentials — there is **no controllable inbound channel source** to instrument
(no `channel.ts`/`monitor.ts` like WeCom). Per D8 this is an honest ⏳ degrade,
**not a failure**: feishu-originated writes currently resolve `principal=unknown`
(the write is still recorded), and OrganLedger stays fully functional.

**Forced-attempt hook template** — the moment feishu's plugin exposes a
middleware / event callback carrying the inbound message (with `open_id`), append
one record at that point, before the agent processes it:

```ts
// PSEUDO — attach at the feishu plugin's inbound event callback / middleware.
// You need: openId (event.sender.sender_id.open_id), a display name if available,
// the agent session id this message maps to, and the platform message id.
function onFeishuInbound(event) {
  const rec = {
    turn_id: `feishu:${event.message.message_id}`,   // <channel>:<msgid>
    session_id: feishuSessionKey(event),             // MUST equal the agent's session_id for JOIN
    ts_start: new Date().toISOString(),
    principal: {
      kind: "im-user",
      channel: "feishu",
      id: event.sender.sender_id.open_id,            // platform-authenticated feishu open_id
      display: event.sender.name ?? null,
      verified: true,                                // platform-attested (see honesty boundary)
      attestation: "platform-attested",
    },
  };
  appendJsonl(`${organledgerHome()}/state/principal/turns.jsonl`, rec); // append-only, guarded
}
```

Until that hook exists, feishu writes are honestly `unknown` — surfaced as such by
`organledger attribution --stats` (no silent gaps).

---

## Entrypoint C — Hermes shim (in-repo, REAL ✅)

`src/adapters/hermes/shim.py` → `emit_organ_event(..., turn_id=..., session_id=...)`.
The runtime passes the current turn/session when it can resolve them; when it
can't, `turn_id`/`session_id` stay null and the write honestly degrades to
`autonomy:"self"` (known session) or `unknown` (no context). Never guessed.
