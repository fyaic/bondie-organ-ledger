# Prompt — Prime every OrganLedger dashboard view (来源 / 文件树 / 活动)

**Hand this file to your coding-terminal agent** (Claude Code / Cursor / Codex / etc.)
when the dashboard opens but the **来源 (Sources)** or **文件树 (File-tree)** view is
blank. `organledger init` primes these automatically now, but this task re-generates
the recomputable state files on demand — after a `reset`, a `--no-prime` install, or
whenever you want the views refreshed.

Copy everything inside the fenced block into your agent, or just say:
*"Run the task in `prompts/prime-dashboard-views.md`."*

---

```prompt
ROLE
You are operating the OrganLedger CLI in this repository to (re)generate the
recomputable dashboard state so every view is populated. Work from the repo root.
This is an OPERATIONAL task — do NOT edit source code.

GOAL
Make the dashboard's 来源 (Sources) and 文件树 (File-tree) views full by generating
state/provenance.json and state/heatmap.json. Optionally fold in upstream-update
events so the activity log is richer.

HARD RULES (do not violate)
1. READ-ONLY on the governed target. `provenance` runs only `git rev-parse/config/
   remote/rev-list/status/log`; `heatmap` is a bounded filesystem walk. Neither
   writes to the target. Never `git add/commit/checkout/reset` the target.
2. Do NOT use `provenance --fetch` unless the user explicitly wants a network call;
   offline last-known ahead/behind is the honest default.
3. These files are recomputable STATE, not audit truth — regenerating them never
   touches the ledger or the hash chain.
4. Do not claim who changed anything. Attribution/identity honesty is unchanged:
   attested ≠ proven, author.verified stays false. This task only fills VIEWS.

STEPS
1. Confirm initialized:
      node src/cli/index.ts status
   If "未初始化 / not initialized", run `node src/cli/index.ts init --yes` and STOP
   (init already primes the views) — report done.

2. Generate the git source map → state/provenance.json (offline, read-only):
      node src/cli/index.ts provenance

3. Generate the file-tree heat → state/heatmap.json (bounded fs walk, no file content):
      node src/cli/index.ts heatmap

4. (Optional) add upstream-update events (pull/merge/clone) to the activity log.
   Requires the daemon to be stopped first (single-writer rule). If a daemon is
   running, ask the user to stop it (on Windows find the real node PID via
   PowerShell `Get-CimInstance Win32_Process | Where CommandLine -like '*daemon*'`
   then `Stop-Process -Id <PID>`), then:
      node src/cli/index.ts backfill --reflog

5. Open the dashboard and confirm the views are populated:
      node src/cli/index.ts dashboard --open
   (local, read-only, http://localhost:7377)

REPORT BACK
- provenance: how many git sources found (parent + embedded repos)
- heatmap: node count, and whether it was bounded/truncated
- whether reflog upstream events were added (and how many), or skipped
- confirm no writes were made to the target and the ledger/chain were untouched
```

---

## Notes for the human

- **Why views can be empty:** the dashboard NEVER runs git or walks your fs — it only
  reads `state/provenance.json` and `state/heatmap.json`. If those files don't exist
  (fresh `reset`, `init --no-prime`), the 来源/文件树 views show an "empty" prompt.
- **`organledger doctor`** also refreshes `state/provenance.json` as a side benefit and
  reports a **视图就绪度** line (票据 / 来源 / 文件树 / 归因) so you can see at a glance
  what's primed.
- **Read-only + idempotent:** re-running is always safe; both files are recomputable.
