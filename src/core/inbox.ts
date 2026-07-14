// Append-only event inbox. Adapters append; the single consumer drains + archives.
// Crash-safe & replayable: a line is moved to processed/ only after full success.
import * as fs from "node:fs";
import * as path from "node:path";
import { appendLine, readJsonl, paths, nowIso } from "../util.ts";
import type { OrganEvent } from "../types.ts";

export class Inbox {
  private inboxFile: string;
  private processedDir: string;

  constructor(ledgerHome: string) {
    const p = paths(ledgerHome);
    this.inboxFile = p.inbox;
    this.processedDir = p.processed;
    fs.mkdirSync(path.dirname(this.inboxFile), { recursive: true });
    fs.mkdirSync(this.processedDir, { recursive: true });
  }

  appendEvent(evt: OrganEvent): void {
    appendLine(this.inboxFile, evt);
  }

  readAll(): OrganEvent[] {
    return readJsonl<OrganEvent>(this.inboxFile);
  }

  // Drain: hand each event to `handle` in order; on success, archive processed
  // events and remove ONLY them from the inbox (events appended concurrently by
  // the in-process watcher during await are preserved). Handlers must be
  // idempotent so a crash mid-drain replays safely.
  async drain(handle: (evt: OrganEvent) => Promise<void>): Promise<number> {
    const events = this.readAll();
    if (events.length === 0) return 0;
    const processedIds = new Set<string>();
    const stamp = nowIso().replace(/[:.]/g, "-");
    const archive = path.join(this.processedDir, `batch-${stamp}.jsonl`);
    for (const evt of events) {
      await handle(evt); // serial — no concurrency, no races
      appendLine(archive, evt);
      processedIds.add(evt.event_id);
    }
    // rewrite inbox keeping only events that were NOT processed (arrived during drain)
    const current = this.readAll();
    const remaining = current.filter((e) => !processedIds.has(e.event_id));
    fs.writeFileSync(
      this.inboxFile,
      remaining.map((e) => JSON.stringify(e)).join("\n") + (remaining.length ? "\n" : "")
    );
    return processedIds.size;
  }
}
