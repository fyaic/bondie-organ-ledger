// Read-only heatmap loader for the dashboard (Phase 1.7 feature B). The board
// NEVER traverses the target filesystem — the directory walk happens ONLY in the
// `organledger heatmap` CLI command, which writes state/heatmap.json. This module
// just fs.readFile's that file (mirrors loadProvenance). `import type` keeps the
// dependency on the CLI builder purely at the type level (erased at runtime), so
// this file stays free of any target-fs walk or git — the architectural red line.
import fs from "node:fs";

import { defaultLedgerHome, paths } from "../util.ts";
import type { HeatmapReport } from "../onboard/heatmap.ts";

// Returns { missing:true } when state/heatmap.json isn't there yet, so the UI can
// prompt the operator to run `organledger heatmap`.
export function loadHeatmap(ledgerHome = defaultLedgerHome()): {
  missing: boolean;
  report: HeatmapReport | null;
} {
  const file = paths(ledgerHome).heatmap;
  if (!fs.existsSync(file)) return { missing: true, report: null };
  try {
    return { missing: false, report: JSON.parse(fs.readFileSync(file, "utf8")) as HeatmapReport };
  } catch {
    return { missing: true, report: null };
  }
}
