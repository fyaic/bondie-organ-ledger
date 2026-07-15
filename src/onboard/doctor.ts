// `organledger doctor` — partitioned health report (🟢/🟡/🔴). Read-only.
import * as fs from "node:fs";
import * as path from "node:path";
import { paths, loadConfigSafe, readVersion, expandHome } from "../util.ts";
import { liveDaemonPid } from "../core/daemon.ts";
import { Ledger } from "../core/ledger.ts";
import { detectEnvironment } from "./detect.ts";
import { isAutostartInstalled } from "./autostart.ts";
import { buildProvenanceReport, writeProvenanceReport } from "./provenance.ts";

type Mark = "🟢" | "🟡" | "🔴";

export function runDoctor(homeArg: string): { lines: string[]; healthy: boolean } {
  const home = expandHome(homeArg);
  const lines: string[] = [];
  const rank: Record<Mark, number> = { "🟢": 0, "🟡": 1, "🔴": 2 };
  let worstRank = 0;
  const add = (m: Mark, section: string, msg: string) => {
    if (rank[m] > worstRank) worstRank = rank[m];
    lines.push(`${m} [${section}] ${msg}`);
  };

  lines.push(`OrganLedger doctor — ${home}`);
  lines.push("");

  // environment
  const det = detectEnvironment();
  add(det.nodeOk ? "🟢" : "🔴", "env", `node ${det.nodeVersion} (need ≥24)`);
  add(det.gitVersion ? "🟢" : "🔴", "env", `git ${det.gitVersion ?? "MISSING"}`);

  // initialized?
  const cfg = loadConfigSafe(home);
  const ver = readVersion(home);
  if (!cfg) {
    add("🔴", "config", "not initialized — run 'organledger init'");
    lines.push("\nNext: organledger init");
    return { lines, healthy: false };
  }
  add(ver && ver.layout >= 2 ? "🟢" : "🟡", "config", `layout v${ver?.layout ?? "?"}, config.json valid, ${cfg.targets.length} target(s)`);

  // paths writable
  const p = paths(home);
  for (const [name, dir] of [
    ["ledger", path.dirname(p.tickets)], ["state", p.state], ["logs", p.logs], ["reports", p.reports],
  ] as const) {
    add(writable(dir) ? "🟢" : "🔴", "paths", `${name} writable (${dir})`);
  }

  // targets exist
  for (const t of cfg.targets) {
    add(fs.existsSync(t.home) ? "🟢" : "🔴", "targets", `${t.system} home ${t.home} ${fs.existsSync(t.home) ? "present" : "MISSING"}`);
  }

  // ledger chain
  const v = new Ledger(home).verify();
  add(v.ok ? "🟢" : "🔴", "audit", v.ok ? `hash chain intact (${v.detail})` : `CHAIN BROKEN: ${v.detail}`);

  // provenance: git source map per target (offline, read-only). Refreshes
  // state/provenance.json as a side benefit so the dashboard stays current.
  try {
    const report = buildProvenanceReport(cfg, { fetch: false });
    for (const g of report.targets) {
      if (!g.git) {
        add("🟡", "provenance", `${g.system}: not a git repo — no sources`);
        continue;
      }
      const dirty = g.sources.filter((s) => s.dirty).length;
      const behind = g.sources.filter((s) => (s.behind ?? 0) > 0).length;
      const noUp = g.sources.filter((s) => !s.upstream).length;
      const mark: Mark = behind > 0 || dirty > 0 ? "🟡" : "🟢";
      add(mark, "provenance",
        `${g.system}: ${g.sources.length} source(s) — ${dirty} dirty, ${behind} behind upstream, ${noUp} no-upstream (as of last fetch)`);
    }
    writeProvenanceReport(home, report);
    add("🟢", "provenance", `state/provenance.json refreshed (${paths(home).provenance})`);
  } catch (e) {
    add("🟡", "provenance", `could not scan sources: ${(e as Error).message}`);
  }

  // file-tree heatmap: read-only freshness check of state/heatmap.json. Doctor
  // does NOT rebuild it (that would traverse the target fs) — it only reports
  // whether a snapshot exists, how many nodes, and if it was bounded/truncated.
  try {
    const hmFile = paths(home).heatmap;
    if (!fs.existsSync(hmFile)) {
      add("🟡", "heatmap", "no snapshot — run 'organledger heatmap' to generate the file-tree state/heatmap.json");
    } else {
      const hm = JSON.parse(fs.readFileSync(hmFile, "utf8"));
      const nodes = hm?.limits?.node_count ?? "?";
      const trunc = hm?.limits?.truncated ? " (bounded: some nodes folded)" : "";
      const ageMs = Date.now() - Date.parse(hm?.generated_at ?? "");
      const ageStr = Number.isNaN(ageMs) ? "unknown age" : `${Math.round(ageMs / 3600000)}h old`;
      const stale = !Number.isNaN(ageMs) && ageMs > 7 * 24 * 3600000;
      add(stale ? "🟡" : "🟢", "heatmap",
        `state/heatmap.json — ${nodes} nodes · window=${hm?.window ?? "?"} · ${hm?.full_tree ? "full-tree" : "changed-only"} · ${ageStr}${trunc}`);
    }
  } catch (e) {
    add("🟡", "heatmap", `could not read heatmap.json: ${(e as Error).message}`);
  }

  // daemon running
  const pid = liveDaemonPid(p.lock);
  add("🟢", "runtime", pid ? `daemon running (pid ${pid})` : "daemon not running (start: organledger daemon)");

  // autostart
  const auto = isAutostartInstalled();
  add(auto ? "🟢" : "🟡", "runtime", auto ? "autostart installed" : "autostart not installed (optional)");

  // capacity
  const logBytes = dirSize(p.logs);
  const procBytes = dirSize(p.processed);
  add(logBytes < 50_000_000 ? "🟢" : "🟡", "capacity", `logs ${fmtBytes(logBytes)}${logBytes >= 50_000_000 ? " — consider reset --keep-audit" : ""}`);
  add("🟢", "capacity", `state/processed ${fmtBytes(procBytes)}`);

  lines.push("");
  lines.push(`Overall: ${worstRank === 0 ? "🟢 healthy" : worstRank === 1 ? "🟡 usable with warnings" : "🔴 needs attention"}`);
  return { lines, healthy: worstRank < 2 };
}

function writable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const full = `${dir}/${name}`;
      const st = fs.statSync(full);
      total += st.isDirectory() ? dirSize(full) : st.size;
    }
  } catch {
    /* missing */
  }
  return total;
}
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
