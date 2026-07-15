# Prompt — Generate & read the OrganLedger file-tree heatmap (Phase 1.8)

**Hand this file to your coding-terminal agent** when you want a picture of "where
is my agent's organ churning most" as a **file tree** (like a file explorer) where
**deeper row color = more changes**. The board shows **structure + heat + counts**;
it NEVER shows file contents or diffs. To actually inspect a file you click it and
your **OS file manager** opens with it selected — content viewing happens in your
own trusted environment, never inside the board.

> Posture note (changed since 1.7): 1.7 was "color only, no details". 1.8 lets you
> click through to the real file **in the OS**. The board still never inlines
> content/diff; file names are shown for navigation (mask them with `--redact`
> for screenshots/sharing).

Copy the fenced block into your agent, or say:
*"Run the task in `prompts/privacy-heatmap-readout.md`."*

---

```prompt
ROLE
You are operating the OrganLedger CLI in this repository. Generate the file-tree
heatmap and give the user a plain-language read-out. HARD RULE: never open, cat,
diff, or quote any target file's contents — the heat is derived purely from the
ledger's change counts, and you must keep it that way. To let the user SEE a file,
tell them to click it in the dashboard (it opens the OS file manager); do not paste
its contents.

STEPS
1. Generate a bounded snapshot (safe on huge repos — node_modules/.git are
   excluded, over-full dirs fold, depth is capped). The DEFAULT is the full organ
   tree (looks like a file explorer, includes never-changed files at heat 0):
     node src/cli/index.ts heatmap
   Add --changed-only to show just the paths that actually changed.
   Note the printed summary: node count, whether it was truncated (folded).

2. Read ONLY the produced state/heatmap.json (paths: `node src/cli/index.ts paths`).
   Each node contains ONLY: name / rel_path / type / change_count / last_change /
   depth / redacted / truncated / children. If you see anything else (content,
   diff, hashes, reason, remote_url, secrets) STOP — that is a privacy-red-line bug
   to report, not use.

3. Summarize for a non-engineer, in their language:
   - The 3–5 hottest folders/skills (highest change_count) and their last_change day.
   - Whether the tree was truncated/folded, and roughly where.
   - How many nodes are flagged `redacted:true` (sensitive globs like agents/main,
     credentials, *.key). Their names are real by default for navigation; the
     dashboard's「打码」toggle (or `--redact`) masks them to "•••" for sharing.

4. Optionally open the dashboard and use the「文件树」tab (rows colored by frequency,
   click a folder to expand/collapse, click a file to LOCATE it in the OS):
     node src/cli/index.ts dashboard --open

DO NOT
- Do NOT readFile/cat/diff any target file to "explain" a hot spot — click-to-reveal
  in the OS is the only path to a file's contents.
- Do NOT add any "view file content / view diff" affordance to the board — locating
  in the OS file manager is the contract; the board stays content-free.
- Do NOT weaken /api/reveal's path safety (must stay inside the target root, select
  only, never execute).
```
