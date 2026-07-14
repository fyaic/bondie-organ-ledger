// Gate: Phase 1 default = observe. held only for severity=critical or op=delete
// (and per-rule delete_gate). Held tickets stop the pipeline before the committer.
import type { Config, Op, Severity, Status } from "../types.ts";

export interface GateResult {
  status: Extract<Status, "observed" | "held">;
  reason: string;
}

export function gate(severity: Severity, op: Op, cfg: Config): GateResult {
  const heldOn = cfg.gate.held_on;
  if (heldOn.includes("critical") && severity === "critical") {
    return { status: "held", reason: "severity=critical" };
  }
  if (heldOn.includes("delete") && op === "delete") {
    return { status: "held", reason: "op=delete" };
  }
  return { status: "observed", reason: "default observe" };
}
