// SQLite memory → deterministic markdown projection (git-diffable).
// Uses Node's built-in node:sqlite (no native build). Read-only + query_only to
// coexist with the live WAL. Degrades to a hash-only note if the DB can't be read.
import * as fs from "node:fs";
import * as path from "node:path";

export interface DumpResult {
  ok: boolean;
  dumpPath: string;
  note: string;
}

export function dumpSqliteToMarkdown(dbAbsPath: string, outAbsPath: string): DumpResult {
  let DatabaseSync: any;
  try {
    // dynamic to keep the module loadable even if node:sqlite is unavailable
    ({ DatabaseSync } = loadSqlite());
  } catch (e) {
    return { ok: false, dumpPath: outAbsPath, note: "node:sqlite unavailable: " + (e as Error).message };
  }

  let db: any;
  try {
    db = new DatabaseSync(dbAbsPath, { readOnly: true });
  } catch (e) {
    // fall back: read-write open but immediately mark query_only
    try {
      db = new DatabaseSync(dbAbsPath);
      db.exec("PRAGMA query_only = ON;");
    } catch (e2) {
      return { ok: false, dumpPath: outAbsPath, note: "open failed: " + (e2 as Error).message };
    }
  }

  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r: any) => r.name as string);

    const lines: string[] = [
      "# OpenClaw memory dump (organledger projection)",
      "",
      "> Deterministic markdown snapshot of the SQLite memory. Intra-day intermediate",
      "> states are lost by design (08 §8.8); trigger-level audit is Phase 2.",
      "",
    ];

    for (const table of tables) {
      lines.push(`## table: ${table}`, "");
      let cols: string[] = [];
      try {
        cols = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map((c: any) => c.name as string);
      } catch {
        cols = [];
      }
      // stable ordering by all columns to keep diffs meaningful
      let rows: any[] = [];
      try {
        rows = db.prepare(`SELECT * FROM ${quoteIdent(table)}`).all();
      } catch {
        rows = [];
      }
      rows = stableSort(rows, cols);
      if (cols.length) lines.push("| " + cols.join(" | ") + " |", "| " + cols.map(() => "---").join(" | ") + " |");
      for (const row of rows) {
        lines.push("| " + cols.map((c) => cell(row[c])).join(" | ") + " |");
      }
      lines.push(`\n_${rows.length} rows_`, "");
    }

    fs.mkdirSync(path.dirname(outAbsPath), { recursive: true });
    fs.writeFileSync(outAbsPath, lines.join("\n"));
    return { ok: true, dumpPath: outAbsPath, note: `dumped ${tables.length} tables` };
  } catch (e) {
    return { ok: false, dumpPath: outAbsPath, note: "dump failed: " + (e as Error).message };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

function loadSqlite(): { DatabaseSync: any } {
  const getB = (process as any).getBuiltinModule;
  if (typeof getB !== "function") throw new Error("process.getBuiltinModule missing");
  return getB("node:sqlite");
}

function quoteIdent(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"';
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Uint8Array) return `<blob ${v.length}b>`;
  return String(v).replace(/\r?\n/g, " ").replace(/\|/g, "\\|").slice(0, 500);
}

function stableSort(rows: any[], cols: string[]): any[] {
  return rows
    .map((r, i) => [r, i] as const)
    .sort((a, b) => {
      for (const c of cols) {
        const av = String(a[0][c] ?? "");
        const bv = String(b[0][c] ?? "");
        if (av < bv) return -1;
        if (av > bv) return 1;
      }
      return a[1] - b[1];
    })
    .map(([r]) => r);
}
