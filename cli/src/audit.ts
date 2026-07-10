// Append-only audit log (~/.local/state/skills-manager/audit.jsonl). One JSON
// object per line. Timestamp and machine come from the injected env (determinism);
// the operator is detected from the ambient agent env vars. Owned by the
// apply/state team.

import * as fs from "node:fs";
import * as path from "node:path";
import { type SkmEnv, auditPath } from "./env";
import type { AuditEntry } from "./types";

/**
 * Best-effort operator label for the audit line. Coding agents set marker env
 * vars; a human at a terminal falls back to $USER. This is the one spot that
 * reads process.env directly (the operator is ambient, not part of SkmEnv) —
 * tests control it by setting/restoring process.env explicitly.
 */
function detectOperator(): string {
  if (process.env.CLAUDECODE) return "claude-code";
  if (process.env.CODEX_HOME) return "codex";
  return process.env.USER || process.env.LOGNAME || "unknown";
}

/** Build an entry stamped with env.clock.now() and env.machineName. */
export function makeAuditEntry(
  env: SkmEnv,
  verb: string,
  summary: string,
  planHash?: string,
): AuditEntry {
  return {
    timestamp: env.clock.now(),
    machine: env.machineName,
    operator: detectOperator(),
    verb,
    ...(planHash !== undefined ? { planHash } : {}),
    summary,
  };
}

/** Append one JSONL record to the audit log, creating the log dir if needed. */
export function appendAudit(env: SkmEnv, entry: AuditEntry): void {
  const file = auditPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}
