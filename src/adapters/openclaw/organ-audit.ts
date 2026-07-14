// Mirror of OpenClaw's config-audit.jsonl for organ writes. Phase-1 write-only:
// a coarse provenance seed (pid/ppid/cwd/argv/prevHash/nextHash) for Phase-2
// correlation. We never consume it this phase.
import * as fs from "node:fs";
import * as path from "node:path";
import { sha256 } from "../../util.ts";

export interface OrganAuditRecord {
  ts: string;
  source: "organ-io";
  event: "organ.write" | "organ.skip";
  path: string;
  op: "create" | "update" | "delete" | "skip";
  pid: number;
  ppid: number;
  cwd: string;
  argv: string[];
  previousHash: string | null;
  nextHash: string | null;
  previousBytes: number | null;
  nextBytes: number | null;
  note?: string;
}

export class OrganAudit {
  private file: string;

  constructor(home: string) {
    this.file = path.join(home, "logs", "organ-audit.jsonl");
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
  }

  write(rec: Partial<OrganAuditRecord> & { path: string; op: OrganAuditRecord["op"]; event: OrganAuditRecord["event"] }): void {
    const full: OrganAuditRecord = {
      ts: new Date().toISOString(),
      source: "organ-io",
      event: rec.event,
      path: rec.path,
      op: rec.op,
      pid: rec.pid ?? process.pid,
      ppid: rec.ppid ?? (process.ppid || 0),
      cwd: rec.cwd ?? process.cwd(),
      argv: rec.argv ?? process.argv,
      previousHash: rec.previousHash ?? null,
      nextHash: rec.nextHash ?? null,
      previousBytes: rec.previousBytes ?? null,
      nextBytes: rec.nextBytes ?? null,
      ...(rec.note ? { note: rec.note } : {}),
    };
    fs.appendFileSync(this.file, JSON.stringify(full) + "\n");
  }

  skip(relPath: string, note: string): void {
    this.write({ path: relPath, op: "skip", event: "organ.skip", note });
  }
}

export function hashBytes(buf: Buffer): { hash: string; bytes: number } {
  return { hash: sha256(buf), bytes: buf.length };
}
