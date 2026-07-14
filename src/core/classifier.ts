// Path-driven severity classifier. First matching glob wins.
// "Large rewrite": deleted-line ratio > rewrite_ratio_critical → escalate to critical.
import type { Config, Severity, SeverityRule } from "../types.ts";

// Minimal glob → RegExp: supports **, *, and literal path segments.
export function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // consume trailing slash of **/
      } else {
        re += "[^/]*";
      }
    } else if ("\\^$+?.()|[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}

export interface ClassifyInput {
  path: string;            // relative organ path, forward slashes
  op: "create" | "update" | "delete";
  beforeText?: string | null;
  afterText?: string | null;
}

export interface ClassifyResult {
  severity: Severity;
  rule: string | null;
  escalated: boolean;      // bumped to critical by rewrite ratio
}

export function classify(input: ClassifyInput, cfg: Config): ClassifyResult {
  const rel = input.path.replace(/\\/g, "/");
  let matched: SeverityRule | null = null;
  for (const rule of cfg.severity_rules) {
    if (globToRegExp(rule.glob).test(rel)) {
      matched = rule;
      break;
    }
  }
  let severity: Severity = matched ? matched.severity : "low";
  let escalated = false;

  // large-rewrite escalation on update with both sides available
  if (input.op === "update" && input.beforeText != null && input.afterText != null) {
    const threshold = matched?.rewrite_ratio_critical ?? cfg.rewrite_ratio_critical;
    const beforeLines = input.beforeText.split(/\r?\n/).length;
    const afterLines = input.afterText.split(/\r?\n/).length;
    if (beforeLines > 0) {
      const deletedRatio = Math.max(0, beforeLines - afterLines) / beforeLines;
      if (deletedRatio > threshold) {
        severity = "critical";
        escalated = true;
      }
    }
  }

  return { severity, rule: matched ? matched.glob : null, escalated };
}
