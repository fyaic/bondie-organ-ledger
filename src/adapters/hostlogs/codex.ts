// Host-log parser: Codex rollout-*.jsonl (DEV source).
//   ~/.codex/sessions/** and ~/.codex/archived_sessions/rollout-*.jsonl
// Shape (02 §A2, P-1 re-verified):
//   first line  type:"session_meta", payload.cwd            → the resolve() base
//   a write is  type:"response_item", payload.type:"custom_tool_call",
//               payload.name:"apply_patch", payload.input = patch text:
//                 *** Begin Patch
//                 *** Update File: <path>          ← path may be ABSOLUTE or cwd-relative
//                 ...
//   o.timestamp ISO8601 → tsMs ; payload.call_id → ref anchor
// One apply_patch may touch MANY files → one record per "*** (Add|Update|Delete) File:",
// all sharing the same tsMs. path.resolve(cwd, p) leaves absolute paths intact and
// only joins cwd for relative ones. READ-ONLY; bad/torn lines skipped.
import { resolve } from "node:path";
import { canonPath } from "../../util.ts";
import type { HostWriteRecord } from "../../types.ts";

const FILE_LINE = /^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/gm;

// mutable per-file state carried across lines (cwd is set by session_meta).
export interface CodexState { cwd: string | null; }

// extract patch text from either the custom_tool_call (payload.input) or the
// function_call (payload.arguments JSON → .input) form. This install only emits the
// custom_tool_call form (P-1), but other Codex versions use function_call → keep both.
function patchInputOf(payload: any): string | null {
  if (payload?.name !== "apply_patch") return null;
  if (payload.type === "custom_tool_call" && typeof payload.input === "string") return payload.input;
  if (payload.type === "function_call" && typeof payload.arguments === "string") {
    try { const a = JSON.parse(payload.arguments); return typeof a?.input === "string" ? a.input : null; } catch { return null; }
  }
  return null;
}

export function codexRecordsFromLine(
  line: string,
  ref: string,
  lineNo: number,
  state: CodexState
): HostWriteRecord[] {
  const t = line.trim();
  if (!t) return [];
  let o: any;
  try { o = JSON.parse(t); } catch { return []; }

  if (o?.type === "session_meta" && typeof o.payload?.cwd === "string") {
    state.cwd = o.payload.cwd; // establish resolve base for subsequent relative patch paths
    return [];
  }
  if (o?.type !== "response_item") return [];
  const patch = patchInputOf(o.payload);
  if (patch == null) return [];
  const tsMs = Date.parse(o.timestamp);
  if (Number.isNaN(tsMs)) return [];

  const callId = o.payload?.call_id ?? "L" + lineNo;
  const out: HostWriteRecord[] = [];
  let m: RegExpExecArray | null;
  FILE_LINE.lastIndex = 0;
  let idx = 0;
  while ((m = FILE_LINE.exec(patch)) !== null) {
    const raw = m[1];
    const abs = state.cwd ? resolve(state.cwd, raw) : raw; // absolute stays absolute
    out.push({
      source: "codex",
      actor_class: "dev",
      absPath: canonPath(abs),
      tsMs,
      ref: `${ref}#${callId}:${idx++}`,
    });
  }
  return out;
}

// Whole-file convenience (fixture tests / non-incremental scans).
export function parseCodex(text: string, ref: string): HostWriteRecord[] {
  const state: CodexState = { cwd: null };
  const out: HostWriteRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) out.push(...codexRecordsFromLine(lines[i], ref, i + 1, state));
  return out;
}
