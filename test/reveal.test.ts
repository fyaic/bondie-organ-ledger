// /api/reveal safety tests (Phase 1.8) — the head red line. reveal.ts spawns an
// OS file-manager "locate" for a file, so these prove the path gate holds BEFORE
// anything could spawn: traversal / absolute / symlink-escape / out-of-target all
// resolve to an error (403/404) with NO spawn, and the platform command only
// LOCATES (select/-R) — never opens or executes — and is passed as an argument
// array (never a shell string).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveReveal, osRevealCommand, revealInOS } from "../src/dashboard/reveal.ts";
import type { Target } from "../src/types.ts";

// realpath so containment comparisons match on macOS/Windows (/var → /private/var, 8.3 names…)
function mktmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
function tgt(home: string): Target {
  return { system: "openclaw", home, watch: [], git: true, ignore: [] };
}

test("legal in-target path resolves ok, and the abs path stays inside home", () => {
  const home = mktmp("ol-rev-ok-");
  fs.mkdirSync(path.join(home, "skills", "eye-on"), { recursive: true });
  fs.writeFileSync(path.join(home, "skills", "eye-on", "SKILL.md"), "x");
  const d = resolveReveal("openclaw", "skills/eye-on/SKILL.md", [tgt(home)]);
  assert.equal(d.ok, true);
  if (d.ok) assert.ok(d.abs === home || d.abs.startsWith(home + path.sep), "resolved abs is inside home");
});

// ---- SECURITY 1: traversal / absolute / empty are rejected 403 and NEVER spawn
test("SECURITY: traversal / absolute / empty paths → 403 and spawn is never called", () => {
  const home = mktmp("ol-rev-sec-");
  fs.writeFileSync(path.join(home, "a.md"), "x");
  const targets = [tgt(home)];

  let spawnCalls = 0;
  const spy = (() => { spawnCalls++; return { unref() {} }; }) as any;

  const bad = ["../../../etc/passwd", "..\\..\\Windows", "/etc/passwd", "C:\\Windows\\system32", "skills/../../escape", ".."];
  for (const p of bad) {
    const d = resolveReveal("openclaw", p, targets);
    assert.equal(d.ok, false, `must reject: ${p}`);
    if (!d.ok) assert.equal(d.status, 403, `403 expected for: ${p}`);
    // mirror the server: revealInOS is only reached when d.ok — so a rejected
    // path can never cause a spawn.
    if (d.ok) revealInOS(d.abs, spy);
  }
  // empty path (what a redacted node's blanked rel_path yields) is also refused
  const empty = resolveReveal("openclaw", "", targets);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.status, 403);

  assert.equal(spawnCalls, 0, "no spawn happened for any rejected path — the gate held before any process");
});

// ---- SECURITY 2: a symlink escaping the target is caught by realpath containment
test("SECURITY: a symlink pointing outside the target is rejected (realpath containment)", () => {
  const home = mktmp("ol-rev-sym-");
  const outside = mktmp("ol-rev-out-");
  fs.writeFileSync(path.join(outside, "secret.txt"), "x");

  let made = false;
  try {
    // 'junction' works on Windows without elevation; 'dir' elsewhere
    fs.symlinkSync(outside, path.join(home, "link"), process.platform === "win32" ? "junction" : "dir");
    made = true;
  } catch {
    // environment can't create links (perms) — skip without failing the suite
  }
  if (!made) return;

  const d = resolveReveal("openclaw", "link/secret.txt", [tgt(home)]);
  assert.equal(d.ok, false, "symlink escape must be rejected");
  if (!d.ok) assert.equal(d.status, 403, "escape is 403 (out of bounds), not a 404");
});

test("unknown system → 404; a nonexistent in-target path → 404 (no spawn either)", () => {
  const home = mktmp("ol-rev-404-");
  const targets = [tgt(home)];
  const noSys = resolveReveal("nope", "a.md", targets);
  assert.equal(noSys.ok, false);
  if (!noSys.ok) assert.equal(noSys.status, 404, "unknown system is 404");
  const noPath = resolveReveal("openclaw", "does/not/exist.md", targets);
  assert.equal(noPath.ok, false);
  if (!noPath.ok) assert.equal(noPath.status, 404, "missing path is 404");
});

// ---- SECURITY 3: the OS command LOCATES only, never opens/executes ------------
test("osRevealCommand only LOCATES (select/-R), never opens/executes, and uses array args", () => {
  const abs = path.join(path.sep === "\\" ? "C:\\" : "/", "Users", "x", "f.md");

  const win = osRevealCommand(abs, "win32");
  assert.equal(win.cmd, "explorer");
  assert.ok(win.args[0].startsWith("/select,"), "win uses /select (locate), not 'start' (which opens/executes)");
  assert.ok(!JSON.stringify(win).includes('"start"'), "never invokes 'start'");

  const mac = osRevealCommand(abs, "darwin");
  assert.deepEqual(mac, { cmd: "open", args: ["-R", abs] }, "mac uses 'open -R' (reveal in Finder), not 'open <file>'");

  const lin = osRevealCommand(abs, "linux");
  assert.equal(lin.cmd, "xdg-open");
  assert.equal(lin.args.length, 1);
  assert.notEqual(lin.args[0], abs, "linux opens the CONTAINING directory, not the file itself");

  // every command is an argument array of strings — never concatenated into a shell string
  for (const c of [win, mac, lin]) {
    assert.ok(Array.isArray(c.args) && c.args.every((a) => typeof a === "string"), "args is string[]");
  }
});

test("revealInOS passes the command to spawn as an ARRAY (injection-safe), detached + stdio ignore", () => {
  const abs = process.platform === "win32" ? "C:\\x\\f.md" : "/x/f.md";
  let seen: { cmd: string; args: unknown; opts: any } | null = null;
  const spy = ((cmd: string, args: unknown, opts: any) => { seen = { cmd, args, opts }; return { unref() {} }; }) as any;
  revealInOS(abs, spy);
  assert.ok(seen, "spawn was called for a vetted path");
  assert.ok(Array.isArray(seen!.args), "args is an array, not a shell string (no injection surface)");
  assert.equal(seen!.opts.detached, true, "spawned detached");
  assert.equal(seen!.opts.stdio, "ignore", "stdio ignored (never inherits the dashboard's streams)");
});
