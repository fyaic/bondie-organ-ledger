// Reporter: aggregate the day's tickets by session / file / severity / status.
// Cross-platform by construction (unified ticket schema → one report).
import * as fs from "node:fs";
import * as path from "node:path";
import { paths, readJsonl, todayStamp, gitSafe } from "../util.ts";
import type { Config, Ticket } from "../types.ts";

export function buildReport(cfg: Config, dateArg: string): { md: string; outPath: string } {
  const day = resolveDay(dateArg); // local YYYY-MM-DD
  const p = paths(cfg.ledger_home);
  const all = readJsonl<Ticket>(p.tickets);
  // compare on LOCAL date (change_id day bucket is local; created_at is UTC ISO)
  const dayTickets = all.filter((t) => localDay(t.created_at) === day);

  const bySession = groupBy(dayTickets, (t) => t.session_id ?? "none");
  const sevCount = countBy(dayTickets, (t) => t.severity);
  const statusCount = countBy(dayTickets, (t) => t.status);
  const files = new Set(dayTickets.map((t) => t.file));
  const held = readHeld(p.held);
  const rolledBack = dayTickets.filter((t) => t.status === "rolled_back");

  const lines: string[] = [];
  lines.push(`# 器官审计日报 ${day}`, "");
  lines.push(
    `- 总写入 ${dayTickets.length} 次 | ${bySession.size} 个 session | 涉及 ${files.size} 个文件`,
    ""
  );

  lines.push("## 按 session");
  if (bySession.size === 0) lines.push("- （无）");
  for (const [sess, ts] of bySession) {
    const fs2 = [...new Set(ts.map((t) => t.file))];
    const sev = countBy(ts, (t) => t.severity);
    lines.push(
      `- \`${sess}\`: ${ts.length} 次，文件 [${fs2.join(", ")}]，severity ${fmtCount(sev)}`
    );
  }
  lines.push("");

  lines.push("## 待确认（held）⚠️");
  if (held.length === 0) lines.push("- （无）");
  for (const t of held) {
    lines.push(
      `- \`${t.change_id}\`: ${t.op} ${t.file}（severity ${t.severity}）→ \`organledger approve/reject ${t.change_id}\``
    );
  }
  lines.push("");

  lines.push("## 按严重度");
  lines.push(
    `- critical ${sevCount.critical || 0} / high ${sevCount.high || 0} / medium ${sevCount.medium || 0} / low ${sevCount.low || 0}`
  );
  lines.push("");

  lines.push("## 按状态");
  lines.push(`- ${fmtCount(statusCount)}`);
  lines.push("");

  lines.push("## 按系统");
  const bySys = countBy(dayTickets, (t) => t.system);
  lines.push(`- ${fmtCount(bySys)}`);
  lines.push("");

  if (rolledBack.length) {
    lines.push("## 已回滚");
    for (const t of rolledBack) lines.push(`- \`${t.change_id}\` ${t.file}`);
    lines.push("");
  }

  // git commit summary per target
  lines.push("## git 提交（当日）");
  for (const target of cfg.targets) {
    if (!target.git) continue;
    const log = gitSafe(target.home, [
      "log",
      `--since=${day} 00:00`,
      `--until=${day} 23:59`,
      "--pretty=%h %s",
    ]);
    const body = log.ok && log.out ? log.out : "（无或不可读）";
    lines.push(`### ${target.system} (${target.home})`, "```", body, "```", "");
  }

  const md = lines.join("\n");
  const outPath = path.join(p.reports, `${day}.md`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md);
  return { md, outPath };
}

function resolveDay(arg: string): string {
  if (!arg || arg === "today") return localDay(new Date().toISOString());
  return arg;
}

// local-timezone YYYY-MM-DD of an ISO instant (keeps report aligned with the
// change_id day bucket, which also uses local time).
function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return (iso || "").slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function readHeld(heldDir: string): Ticket[] {
  if (!fs.existsSync(heldDir)) return [];
  return fs
    .readdirSync(heldDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(heldDir, f), "utf8")) as Ticket);
}

function groupBy<T>(arr: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of arr) (m.get(key(x)) ?? m.set(key(x), []).get(key(x))!).push(x);
  return m;
}
function countBy<T>(arr: T[], key: (t: T) => string): Record<string, number> {
  const o: Record<string, number> = {};
  for (const x of arr) o[key(x)] = (o[key(x)] || 0) + 1;
  return o;
}
function fmtCount(o: Record<string, number>): string {
  return Object.entries(o).map(([k, v]) => `${k}:${v}`).join(" ") || "（无）";
}
