// PrincipalIndex — the read side of the principal-turn contract (04.2 / D5).
//
// IM entrypoints (WeCom bridge / feishu hook, OUTSIDE this repo) append one
// TurnRecord per external message to state/principal/turns.jsonl. This index
// reads that append-only stream and lets the normalizer JOIN a principal onto an
// in-band organ write, by turn_id (exact) → session_id (unambiguous) → nearest
// turn in the same session within a time window (weak).
//
// Honesty / resilience contract:
//   * A missing stream, an empty stream, or torn/garbage lines NEVER crash — the
//     index stays empty and every JOIN returns null (writes degrade to unknown).
//   * bySession only answers when the session has ONE unambiguous principal; a
//     session mixing principals (e.g. a group chat) falls through to the weak
//     time-window match so we never silently attribute to the wrong user.
//   * Append-only tail: refresh() reads only bytes appended since last read, so a
//     long-running daemon picks up new turns without re-parsing the whole file.
//     A shrunk file (rotation/truncation) is detected and the index rebuilt.
import * as fs from "node:fs";
import type { TurnRecord } from "../types.ts";

// default half-width of the session time-window fallback (weak match).
export const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // ±5 min

function principalKey(r: TurnRecord): string {
  return `${r.principal.channel ?? "?"}:${r.principal.id ?? "?"}`;
}

export class PrincipalIndex {
  private file: string;
  private offset = 0;              // bytes consumed so far (append-only tail)
  private partial = "";           // trailing partial line carried across reads
  private byTurnId = new Map<string, TurnRecord>();
  private bySessionId = new Map<string, TurnRecord[]>(); // insertion order == ts order (append-only)

  constructor(turnsFile: string) {
    this.file = turnsFile;
  }

  // Read all currently-available records. Safe to call repeatedly; incremental.
  refresh(): void {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return; // stream not created yet → stay empty (contract: degrade, don't crash)
    }
    if (size < this.offset) this.reset(); // file shrank (rotation/truncate) → rebuild
    if (size === this.offset) return;     // nothing new

    let chunk = "";
    try {
      const fd = fs.openSync(this.file, "r");
      try {
        const len = size - this.offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, this.offset);
        chunk = buf.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return; // transient read error → try again next refresh
    }
    this.offset = size;

    const text = this.partial + chunk;
    const lines = text.split(/\r?\n/);
    this.partial = lines.pop() ?? ""; // last element is either "" (clean) or a torn partial line
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      this.ingest(t);
    }
  }

  private ingest(line: string): void {
    let rec: TurnRecord;
    try {
      rec = JSON.parse(line) as TurnRecord;
    } catch {
      return; // torn/garbage line — skip (resilient like readJsonl)
    }
    // minimal shape guard: a usable record must at least carry a turn_id + principal
    if (!rec || typeof rec.turn_id !== "string" || !rec.principal) return;
    this.byTurnId.set(rec.turn_id, rec);
    if (rec.session_id) {
      const arr = this.bySessionId.get(rec.session_id) ?? [];
      arr.push(rec);
      this.bySessionId.set(rec.session_id, arr);
    }
  }

  private reset(): void {
    this.offset = 0;
    this.partial = "";
    this.byTurnId.clear();
    this.bySessionId.clear();
  }

  // Exact JOIN — strongest. match:"turn-id".
  byTurn(turnId: string | null | undefined): TurnRecord | null {
    if (!turnId) return null;
    return this.byTurnId.get(turnId) ?? null;
  }

  // Session JOIN — only when the session has a SINGLE unambiguous principal.
  // Returns the latest such record; null if the session is unknown OR mixes
  // principals (ambiguous → caller falls through to the weak time-window). match:"session".
  bySession(sessionId: string | null | undefined): TurnRecord | null {
    if (!sessionId) return null;
    const arr = this.bySessionId.get(sessionId);
    if (!arr || arr.length === 0) return null;
    const keys = new Set(arr.map(principalKey));
    if (keys.size !== 1) return null; // ambiguous session — do not guess
    return arr[arr.length - 1];
  }

  // Weak fallback — nearest turn in the same session within ±windowMs of `ts`.
  // match:"time-window" (front-end shows this as a weak correlation).
  nearestInSession(
    sessionId: string | null | undefined,
    ts: string,
    windowMs: number = DEFAULT_WINDOW_MS
  ): TurnRecord | null {
    if (!sessionId) return null;
    const arr = this.bySessionId.get(sessionId);
    if (!arr || arr.length === 0) return null;
    const at = Date.parse(ts);
    if (Number.isNaN(at)) return null;
    let best: TurnRecord | null = null;
    let bestDelta = Infinity;
    for (const r of arr) {
      const rt = Date.parse(r.ts_start);
      if (Number.isNaN(rt)) continue;
      const d = Math.abs(rt - at);
      if (d <= windowMs && d < bestDelta) {
        best = r;
        bestDelta = d;
      }
    }
    return best;
  }

  // diagnostics (used by `attribution --stats` / tests): how many turns loaded.
  size(): number {
    return this.byTurnId.size;
  }
}
