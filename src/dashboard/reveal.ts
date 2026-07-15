// /api/reveal — the ONLY outward side-effect the dashboard has, and its head red
// line (Phase 1.8). It lets the operator jump from a file-tree row to that file
// in their own OS file manager. Because it spawns a process on the server host,
// every safety check lives here and is pure/testable:
//
//   1. `system` must resolve to a configured target's home (absolute, realpath'd).
//   2. the raw relative path may not contain any ".." segment, and may not be
//      absolute.
//   3. the realpath of home/<path> must stay INSIDE realpath(home) — this defeats
//      symlink escapes and any residual traversal. Otherwise → 403, NO spawn.
//   4. the spawned command only *locates/selects* the file (explorer /select,
//      open -R, xdg-open <dir>) — it NEVER opens/executes it — and is passed as an
//      argument array (never a shell string), so a filename can't inject a command.
//
// resolveReveal() does all validation and spawns NOTHING, so tests can assert that
// out-of-bounds inputs are rejected before any process could ever start.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { Target } from "../types.ts";

export interface RevealOk {
  ok: true;
  abs: string; // realpath'd absolute path, proven inside the target home
}
export interface RevealErr {
  ok: false;
  status: 403 | 404;
  error: string;
}
export type RevealDecision = RevealOk | RevealErr;

// Pure safety gate — resolves & validates, spawns nothing. Returns the vetted
// absolute path on success, or an error+status to send back verbatim.
export function resolveReveal(
  system: string,
  relPath: string,
  targets: Target[],
): RevealDecision {
  const target = targets.find((t) => t.system === system);
  if (!target) return { ok: false, status: 404, error: "no such target" };

  let home: string;
  try {
    home = fs.realpathSync(path.resolve(target.home));
  } catch {
    return { ok: false, status: 404, error: "no such target" };
  }

  const norm = String(relPath || "").replace(/\\/g, "/");
  // empty path, absolute path, or any ".." segment → refuse before touching fs.
  if (!norm) return { ok: false, status: 403, error: "out of bounds" };
  if (path.isAbsolute(norm) || /^[a-zA-Z]:/.test(norm)) {
    return { ok: false, status: 403, error: "out of bounds" };
  }
  if (norm.split("/").some((seg) => seg === "..")) {
    return { ok: false, status: 403, error: "out of bounds" };
  }

  let abs: string;
  try {
    abs = fs.realpathSync(path.resolve(home, norm));
  } catch {
    return { ok: false, status: 404, error: "no such path" };
  }

  // containment: realpath(home/path) must equal home or sit under home + sep.
  // This is what defeats a symlink that points outside the target.
  if (abs !== home && !abs.startsWith(home + path.sep)) {
    return { ok: false, status: 403, error: "out of bounds" };
  }
  return { ok: true, abs };
}

// Platform locate command — SELECT/-R only, never open/execute the file. Returned
// as {cmd, args} (array form) so it's testable and never goes through a shell.
export function osRevealCommand(abs: string, platform: NodeJS.Platform = process.platform): {
  cmd: string;
  args: string[];
} {
  if (platform === "win32") {
    // explorer /select,<abs> highlights the file in a new Explorer window.
    return { cmd: "explorer", args: [`/select,${abs}`] };
  }
  if (platform === "darwin") {
    // open -R reveals (selects) the file in Finder — does not open it.
    return { cmd: "open", args: ["-R", abs] };
  }
  // linux/other: no portable "select" — open the CONTAINING directory only.
  return { cmd: "xdg-open", args: [path.dirname(abs)] };
}

// Spawn the locate command, detached and unref'd, so the dashboard never blocks
// or inherits the child. `spawnFn` is injectable for tests. Explorer often exits
// non-zero even on success, so exit status is intentionally ignored.
export function revealInOS(abs: string, spawnFn: typeof spawn = spawn): void {
  const { cmd, args } = osRevealCommand(abs);
  const child = spawnFn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref?.();
}
