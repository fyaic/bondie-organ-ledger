// Cross-language proof (06.4): a shim-emitted line is normalized by the TS core
// into a valid ticket with system=hermes, source=in-band, verified=false.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Ledger } from "../src/core/ledger.ts";
import { normalize } from "../src/core/normalizer.ts";
import type { OrganEvent, Target } from "../src/types.ts";

function mktmp(p: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

test("python shim event → TS normalizer → hermes ticket (verified:false)", () => {
  const home = mktmp("ol-hermes-");
  const inbox = path.join(home, "events", "inbox.jsonl");
  fs.mkdirSync(path.dirname(inbox), { recursive: true });

  // run the actual Python shim to append a real line
  const py = process.platform === "win32" ? "python" : "python3";
  const shimPath = path.join(process.cwd(), "src", "adapters", "hermes", "shim.py");
  const code = [
    "import sys; sys.path.insert(0, r'" + path.dirname(shimPath) + "')",
    "import shim",
    "shim.emit_organ_event('skills/note/SKILL.md','update',origin='foreground',session_id='sess-x',author_hint='agent',reason='xlang',after_hash=shim.sha256_text('hi'),inbox=__import__('pathlib').Path(r'" + inbox + "'))",
  ].join("; ");
  execFileSync(py, ["-c", code]);

  const line = fs.readFileSync(inbox, "utf8").trim().split(/\r?\n/).pop()!;
  const evt = JSON.parse(line) as OrganEvent;
  assert.equal(evt.system, "hermes");
  assert.equal(evt.source, "in-band");

  const organHome = mktmp("ol-hermes-organ-");
  const target: Target = {
    system: "hermes",
    home: organHome,
    watch: ["skills"],
    git: false,
    ignore: [],
  };
  const ledger = new Ledger(mktmp("ol-hermes-ledger-"));
  const { ticket } = normalize(evt, target, ledger);

  assert.equal(ticket.system, "hermes");
  assert.equal(ticket.source, "in-band");
  assert.equal(ticket.author.verified, false);
  assert.equal(ticket.author.type, "agent");
  assert.equal(ticket.session_id, "sess-x");
  assert.equal(ticket.op, "update");
  assert.ok(ticket.change_id.startsWith("chg-"));
});
