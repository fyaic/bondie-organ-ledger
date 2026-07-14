# Prompt — Populate the OrganLedger dashboard with historical data

**Hand this file to your coding-terminal agent** (Claude Code / Cursor / Codex / etc.)
when you've just installed OrganLedger and the dashboard is empty. The agent will
replay your target's git history into the ledger so the dashboard shows the full
organ-evolution story instead of a blank slate.

Copy everything inside the fenced block below into your agent, or just say:
*"Run the task in `prompts/populate-dashboard-history.md`."*

---

```prompt
ROLE
You are operating the OrganLedger CLI in this repository to backfill historical
organ changes into the ledger. Work from the repo root. Do NOT edit source code —
this is an operational task, not a coding task.

GOAL
The dashboard is empty because the "water line" only observes changes from install
time forward. Populate it by replaying the governed target's git history into the
ledger, then confirm the hash chain is still intact.

HARD RULES (do not violate)
1. backfill is READ-ONLY on the target repo (it only runs `git log`/`git show`).
   Never `git add/commit/checkout/reset` the target. Never pass --no-backfill's
   opposite by editing anything.
2. The daemon is the SINGLE writer. Backfill refuses to run while a daemon holds
   the lock — that is by design. Stop the daemon first, then backfill, then you may
   restart it.
3. Do not claim who made a historical change. `author.verified` is always false;
   git author is only an unverified hint. Never present it as proof of identity.
4. Stop and report if `verify-ledger` is not intact after backfill.

STEPS
1. Confirm OrganLedger is initialized:
      node src/cli/index.ts status
   - If it errors with "未初始化 / not initialized", run `node src/cli/index.ts init --yes`
     first (that also does a first backfill), then STOP and report — you're done.
   - Otherwise note the current ticket count.

2. Ensure no daemon is running (it must not write concurrently):
   - macOS/Linux:  check `state/daemon.lock` under the ledger home; if a live PID is
     listed, ask the user to Ctrl-C the daemon, then continue.
   - Windows (Git-Bash gotcha — `$!`/pkill are unreliable): find the real node.exe
     PID and stop it via PowerShell, e.g.:
        powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*organledger*daemon*' } | Select-Object ProcessId, CommandLine"
        powershell -Command "Stop-Process -Id <PID>"
     If `node src/cli/index.ts backfill` prints "a daemon (pid …) is running", that
     daemon is still alive — stop it and retry rather than forcing anything.

3. Run the backfill. Default is the last 90 days; use --full-history for everything:
      node src/cli/index.ts backfill                 # last 90 days
      node src/cli/index.ts backfill --full-history  # entire history
      node src/cli/index.ts backfill --since-days 30 # custom window
   Backfill is idempotent + incremental (dedupes by git commit SHA), so re-running
   is safe and only adds commits not already recorded.

4. Verify integrity (must say OK / intact):
      node src/cli/index.ts verify-ledger

5. Show the result to the user:
      node src/cli/index.ts dashboard --open
   (local, read-only, http://localhost:7377)

REPORT BACK
- ticket count before → after, and the date span backfilled
- how many runtime/binary files were dropped (expected — cron/runs, sqlite, logs)
- confirmation that the chain is intact
- reminder: author identity is unverified (Phase 1 honesty boundary)
```

---

## Notes for the human

- **What gets captured:** every add/modify/delete of an organ-definition file
  (`skills/ agents/ cron/ tasks/ flows/ memory/*.md …`) that exists in the target's
  git history. Runtime churn (`cron/runs`, `flows/tasks` sqlite, `memory/*.sqlite`,
  `*.log`, etc.) is deliberately excluded — it would flood the ledger with noise.
- **Where it lands:** each historical commit becomes one squash group
  (`session_id = git:<sha>`), with `op`, before/after blob hashes, `git_commit`, and
  a `severity` from the classifier. `created_at` is the real commit date.
- **Backfilling an already-used ledger** appends history to the chain tail, so
  historical `created_at` values sort before existing tickets (time is non-monotonic,
  but the chain stays valid). On a fresh install this is clean and in order.
- **Non-git targets** (e.g. a `~/.hermes` that isn't a repo) have no history to
  backfill — the task is a safe no-op there.
