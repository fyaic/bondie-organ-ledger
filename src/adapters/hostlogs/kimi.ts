// Host-log parser: Kimi-code wire.jsonl (DEV source; ALSO Hermes' runtime → AGENT).
//   ~/.kimi-code/sessions/wd_<slug>/<session>/agents/<name>/wire.jsonl
// A write is a loop event carrying a tool.call:
//   o.type === "context.append_loop_event"
//   o.event.type === "tool.call"
//   o.event.name ∈ {Write, Edit, MultiEdit}
//   o.event.args.path               forward-slash ABSOLUTE path → canonPath
//   o.time                          top-level epoch ms (NOT inside event)
//   o.event.toolCallId              → ref anchor
// actor_class is decided by the wd_<slug> bucket (classifyKimiWd), NOT by path:
// Hermes writes go to arbitrary paths but always land in wd_hermes_* (P-1 verified).
// READ-ONLY; bad/torn lines skipped (02 §A3, §4.3).
import { canonPath } from "../../util.ts";
import type { HostWriteRecord } from "../../types.ts";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

// wd_<slug> → actor_class. Default rule + config override (prefix match).
// wd_hermes_* is an AGENT runtime; every other workDir is DEV coding. If P-1 ever
// finds a wd_openclaw_* bucket, add it via wdActorMap:{ "wd_openclaw_": "agent" }.
export function classifyKimiWd(
  wdSlug: string,
  wdActorMap?: Record<string, "dev" | "agent">
): "dev" | "agent" {
  if (wdActorMap) {
    for (const prefix of Object.keys(wdActorMap)) {
      if (wdSlug.startsWith(prefix)) return wdActorMap[prefix];
    }
  }
  if (/^wd_hermes_/.test(wdSlug)) return "agent";
  return "dev";
}

// source label for a classified kimi write, derived from the wd slug so it stays
// HONEST if a non-hermes agent bucket is ever mapped in (e.g. a future wd_openclaw_*
// via wdActorMap): dev → kimi-code; agent + openclaw slug → openclaw; else → hermes.
export function kimiSource(actorClass: "dev" | "agent", wdSlug = ""): HostWriteRecord["source"] {
  if (actorClass === "dev") return "kimi-code";
  if (/openclaw/i.test(wdSlug)) return "openclaw";
  return "hermes";
}

export function kimiRecordsFromLine(
  line: string,
  ref: string,
  lineNo: number,
  actorClass: "dev" | "agent",
  source: HostWriteRecord["source"] = kimiSource(actorClass)
): HostWriteRecord[] {
  const t = line.trim();
  if (!t) return [];
  let o: any;
  try { o = JSON.parse(t); } catch { return []; }
  if (o?.type !== "context.append_loop_event") return [];
  const ev = o.event;
  if (!ev || ev.type !== "tool.call" || !WRITE_TOOLS.has(ev.name)) return [];
  const p = ev.args?.path;
  if (typeof p !== "string" || !p) return [];
  const tsMs = typeof o.time === "number" ? o.time : Date.parse(o.time);
  if (Number.isNaN(tsMs)) return [];
  return [{
    source,
    actor_class: actorClass,
    absPath: canonPath(p),
    tsMs,
    ref: `${ref}#${ev.toolCallId ?? "L" + lineNo}`,
  }];
}

// Whole-file convenience (fixture tests / non-incremental scans).
export function parseKimi(text: string, ref: string, actorClass: "dev" | "agent", source: HostWriteRecord["source"] = kimiSource(actorClass)): HostWriteRecord[] {
  const out: HostWriteRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) out.push(...kimiRecordsFromLine(lines[i], ref, i + 1, actorClass, source));
  return out;
}
