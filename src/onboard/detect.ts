// Environment detection for `init` / `doctor`. Finds OpenClaw / Hermes homes,
// verifies git, and reports what's usable — never crashes on a missing target.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { gitSafe } from "../util.ts";

export interface DetectedTarget {
  system: "openclaw" | "hermes";
  home: string;
  exists: boolean;
  isGitRepo: boolean;
  organDirs: string[]; // which of the expected organ dirs are present
  usable: boolean;     // exists AND (git repo OR has organ dirs)
  note: string;
}

export interface Detection {
  nodeVersion: string;
  nodeOk: boolean;
  gitVersion: string | null;
  targets: DetectedTarget[];
}

const OPENCLAW_ORGANS = ["skills", "agents", "cron", "tasks", "flows", "memory"];
const HERMES_ORGANS = ["skills", "memories", "cron"];

export function detectEnvironment(overrides: { openclaw?: string; hermes?: string } = {}): Detection {
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.replace(/^v/, "").split(".")[0], 10);
  const gitProbe = gitSafe(process.cwd(), ["--version"]);

  const home = os.homedir();
  const targets: DetectedTarget[] = [];

  targets.push(
    inspectTarget(
      "openclaw",
      overrides.openclaw || path.join(home, ".openclaw"),
      OPENCLAW_ORGANS
    )
  );
  targets.push(
    inspectTarget(
      "hermes",
      overrides.hermes || path.join(home, ".hermes"),
      HERMES_ORGANS
    )
  );

  return {
    nodeVersion,
    nodeOk: major >= 24,
    gitVersion: gitProbe.ok ? gitProbe.out.replace(/^git version /, "") : null,
    targets,
  };
}

function inspectTarget(
  system: "openclaw" | "hermes",
  home: string,
  organs: string[]
): DetectedTarget {
  const exists = fs.existsSync(home);
  let isGitRepo = false;
  let organDirs: string[] = [];
  if (exists) {
    const r = gitSafe(home, ["rev-parse", "--is-inside-work-tree"]);
    isGitRepo = r.ok && r.out.trim() === "true";
    organDirs = organs.filter((o) => fs.existsSync(path.join(home, o)));
  }
  const usable = exists && (isGitRepo || organDirs.length > 0);
  let note: string;
  if (!exists) note = `not found (pass --${system} <path> or create it later)`;
  else if (!isGitRepo && organDirs.length === 0) note = "exists but no organ dirs / not git — not governable yet";
  else if (!isGitRepo) note = `organ dirs [${organDirs.join(", ")}] but NOT a git repo — first-scan can 'git init' (deferred)`;
  else note = `git repo, organ dirs [${organDirs.join(", ")}]`;
  return { system, home, exists, isGitRepo, organDirs, usable, note };
}
