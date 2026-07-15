# Prompt — Wire your self-built WeCom bridge into OrganLedger attribution

**Hand this file to your coding-terminal agent** (Claude Code / Cursor / Codex / etc.)
when you want IM-driven organ changes to attribute to the **external user who
requested them**, instead of being recorded as `unknown`. The agent instruments
your **self-built WeCom bridge** (outside the organledger repo) to append a
principal-turn record per inbound message, per the contract in
[`docs/principal-turn-contract.md`](../docs/principal-turn-contract.md).

Copy everything inside the fenced block into your agent, or say:
*"Run the task in `prompts/wire-wecom-attribution.md`."*

> Scope: this wires **WeCom** (self-built bridge, controllable source). **Feishu**
> is an official plugin / black box on this host — leave it degraded (principal =
> unknown) until it exposes an inbound middleware hook; then apply the same pattern
> using its `open_id`.

---

```prompt
ROLE
You are instrumenting the user's SELF-BUILT WeCom bridge (a channel plugin OUTSIDE
the organledger repository) so that OrganLedger can attribute organ changes to the
external WeCom user who requested them. Read docs/principal-turn-contract.md first.

GOAL
At the bridge's inbound message handler — the point where it has the sender's
platform userid and is about to dispatch the message to the agent — append ONE
principal-turn record to the OrganLedger principal stream. OrganLedger's daemon
reads that stream and JOINs the principal onto the agent's in-band organ writes.

HARD RULES — HONESTY RED LINE (violating any of these is a failure)
1. NEVER forge `verified`. Set `verified:true` + `attestation:"platform-attested"`
   ONLY for a real, platform-authenticated WeCom userid. attested = "channel auth +
   runtime self-report", it is NOT cryptographic proof — never call it "proven".
   The daemon re-clamps this on read (normalizer.clampPrincipal); do not rely on
   that as an excuse to be sloppy — get it right at the source.
2. REPOSITORY BOUNDARY: the bridge is OUTSIDE the organledger repo. Mark every edit
   you make there with a clear cross-repo comment block. Do NOT edit the organledger
   repo itself for this task — the reference implementation
   (src/adapters/wecom/principal-turn.ts) is already there and version-controlled.
3. NON-FATAL: wrap the append in try/catch so a failure to record a turn NEVER
   breaks the bridge's message handling — attribution just degrades to unknown.
4. Append-only: write one JSON line to <ORGANLEDGER_HOME>/state/principal/turns.jsonl
   (default ~/.organledger). Never touch the ledger or the hash chain.
5. Local changes stay unverified; requested ≠ faithful. Do not overclaim anywhere.

STEPS
1. Locate the bridge's inbound handler (the function that resolves senderId /
   sender display name / the agent session key / the platform message id, just
   before it dispatches to the agent). In the reference bridge this is
   monitor.ts → handleWecomMessage(), right before the dispatch call.

2. Map the fields per the contract (docs/principal-turn-contract.md §Entrypoint A):
      turn_id    = `wecom:<messageSid>`      // <channel>:<msgid>, globally unique
      session_id = sessionKey                // MUST equal the agent's session_id
      principal  = { kind:"im-user", channel:"wecom", id:<senderId>,
                     display:<senderLabel|null>, verified:true,
                     attestation:"platform-attested" }
      ts_start   = new Date().toISOString()

3. Append it (guarded, append-only, cross-repo comment block):
      const file = path.join(process.env.ORGANLEDGER_HOME || <home>/.organledger,
                             "state","principal","turns.jsonl");
      try { fs.mkdirSync(path.dirname(file),{recursive:true});
            fs.appendFileSync(file, JSON.stringify(rec)+"\n",{flag:"a"}); }
      catch { /* non-fatal: degrade to unknown attribution */ }

4. Ensure the agent stamps its in-band organ writes with the same turn_id (or at
   least runs in the same session_id) so the JOIN lands — see the Hermes shim
   `emit_organ_event(..., turn_id=..., session_id=...)`.

5. Verify the round-trip WITHOUT faking anything:
   - send yourself a real WeCom message through the bridge,
   - confirm a line appended to state/principal/turns.jsonl with the real userid,
   - after the agent writes an organ, run:
        node src/cli/index.ts attribution --stats
     and confirm the im-user share went up and the change attributes to that user.

REPORT BACK
- exact file + function you instrumented (with the cross-repo boundary marker)
- a sample turn record (redact the real userid if sharing)
- confirmation: verified only on real platform userid, try/catch non-fatal,
  organledger repo itself untouched, attested described as "channel auth + runtime
  self-report (not cryptographic proof)".
```

---

## Notes for the human

- **What this buys you:** a change an external WeCom user asked your agent to make
  stops reading as "agent did it / unknown" and correctly shows
  `👤 企业微信·<user>（渠道认证·运行时证言）· 经 agent 执行` on the board.
- **Trust boundary (honest):** attested = platform-authenticated IM identity + agent
  runtime self-report. A compromised runtime can forge it → this is **not**
  cryptographic non-repudiation (that's Phase 3). Local changes remain
  `local-unverified`; "requested" proves a message existed this turn, not that the
  write was faithful to it.
- **Feishu:** currently a black box on this host (outbound skills only). When its
  plugin exposes an inbound middleware/event hook carrying `open_id`, apply the same
  pattern with `channel:"feishu"` — until then feishu-driven changes honestly show
  `unknown`.
