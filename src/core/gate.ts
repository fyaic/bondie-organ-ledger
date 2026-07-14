// Gate: Phase 1 default = observe. held only for severity=critical or op=delete
// (and per-rule delete_gate). Held tickets stop the pipeline before the committer.
import type { Config, Op, Severity, Status } from "../types.ts";

export interface GateResult {
  status: Extract<Status, "observed" | "held">;
  reason: string;
}

// `ruleDeleteGate` is the per-path SeverityRule.delete_gate signal (from the
// classifier). It holds a delete for THIS path even when the global gate does
// not list "delete" in held_on — the fine-grained, path-scoped delete gate.
export function gate(severity: Severity, op: Op, cfg: Config, ruleDeleteGate = false): GateResult {
  const heldOn = cfg.gate.held_on;
  if (heldOn.includes("critical") && severity === "critical") {
    return { status: "held", reason: "severity=critical" };
  }
  if (op === "delete" && (heldOn.includes("delete") || ruleDeleteGate)) {
    return {
      status: "held",
      reason: ruleDeleteGate && !heldOn.includes("delete") ? "op=delete (rule)" : "op=delete",
    };
  }
  return { status: "observed", reason: "default observe" };
}
