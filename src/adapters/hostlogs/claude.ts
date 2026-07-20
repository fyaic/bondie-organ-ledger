// Host-log parser: Claude Code transcripts (DEV source, positive anchor).
//   ~/.claude/projects/<enc-cwd>/*.jsonl — one file = one session, one JSON per line.
// A write is a tool_use block inside o.message.content[]:
//   o.timestamp                     ISO8601 → tsMs
//   b.type === "tool_use"
//   b.name ∈ {Write, Edit, MultiEdit}
//   b.input.file_path               Windows backslash ABSOLUTE path → canonPath
//   b.id                            → ref anchor
// READ-ONLY. Bad/torn lines and missing fields are skipped, never thrown (02 §A1).
import { canonPath } from "../../util.ts";
import type { HostWriteRecord } from "../../types.ts";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

// Parse one transcript line → 0+ write records. Pure; `ref` is the log file id used
// to build the auditable back-reference "<ref>#<toolUseId|Lline>".
export function claudeRecordsFromLine(line: string, ref: string, lineNo: number): HostWriteRecord[] {
  const t = line.trim();
  if (!t) return [];
  let o: any;
  try { o = JSON.parse(t); } catch { return []; }
  const content = o?.message?.content;
  if (!Array.isArray(content)) return [];
  const tsMs = Date.parse(o.timestamp);
  if (Number.isNaN(tsMs)) return [];
  const out: HostWriteRecord[] = [];
  for (const b of content) {
    if (!b || b.type !== "tool_use" || !WRITE_TOOLS.has(b.name)) continue;
    const fp = b.input?.file_path;
    if (typeof fp !== "string" || !fp) continue;
    out.push({
      source: "claude-code",
      actor_class: "dev",
      absPath: canonPath(fp),
      tsMs,
      ref: `${ref}#${b.id ?? "L" + lineNo}`,
    });
  }
  return out;
}

// Whole-file convenience (fixture tests / non-incremental scans).
export function parseClaude(text: string, ref: string): HostWriteRecord[] {
  const out: HostWriteRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) out.push(...claudeRecordsFromLine(lines[i], ref, i + 1));
  return out;
}
