# Prompt — Generate & read the OrganLedger privacy heatmap (Phase 1.7)

**Hand this file to your coding-terminal agent** when you want a privacy-preserving
picture of "where is my agent's organ churning most" — WITHOUT exposing any file
contents. The heatmap shows **only structure + color (= change frequency)**; it never
reads or reveals file contents, diffs, or secrets.

Copy the fenced block into your agent, or say:
*"Run the task in `prompts/privacy-heatmap-readout.md`."*

---

```prompt
ROLE
You are operating the OrganLedger CLI in this repository. Generate the privacy
directory heatmap and give the user a plain-language read-out. HARD RULE: never
open, cat, diff, or quote any target file's contents — the heatmap is derived
purely from the ledger's change counts, and you must keep it that way.

STEPS
1. Generate a bounded full-tree snapshot (safe on huge repos — node_modules/.git
   are excluded, over-full dirs fold, depth is capped):
     node src/cli/index.ts heatmap --full-tree
   Note the printed summary: node count, whether it was truncated (folded).

2. Read ONLY the produced state/heatmap.json (paths: `node src/cli/index.ts paths`).
   It contains ONLY: name / type / change_count / last_change / depth / redacted /
   truncated / children. If you see anything else (content, diff, hashes, reason,
   remote_url, secrets) STOP — that is a privacy-red-line bug to report, not use.

3. Summarize for a non-engineer, in their language:
   - The 3–5 hottest folders/skills (highest change_count) and their last_change day.
   - How many nodes were redacted (name = "•••"): these are sensitive paths whose
     HEAT is shown but whose NAME is hidden by design — do not try to un-redact them.
   - Whether the tree was truncated/folded, and roughly where.

4. Optionally open the visual treemap (color = frequency, click = count tooltip only):
     node src/cli/index.ts dashboard --open
   then switch to the「热力图」tab.

DO NOT
- Do NOT readFile/cat/diff any target file to "explain" a hot spot.
- Do NOT attempt to reveal a redacted node's real name.
- Do NOT add any "view file / view diff / open" affordance — the heatmap is
  color-only by contract.
```
