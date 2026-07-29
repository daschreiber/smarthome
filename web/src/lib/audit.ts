import fs from "node:fs";
import path from "node:path";

/** Append-only JSONL audit log of every command the app issues. */

export interface AuditEvent {
  ts: string;
  user?: string;
  deviceId: string;
  entityId: string;
  command: string;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  error?: string;
  resultState?: string;
  /** Security-tier device (door locks): flagged so the activity view can
   * surface these events distinctly (IMPLEMENTATION_SPEC Phase F). */
  security?: boolean;
}

function logPath(): string {
  return process.env.AUDIT_LOG_PATH || path.join(process.cwd(), "audit.log");
}

export function audit(event: AuditEvent): void {
  try {
    fs.appendFileSync(logPath(), JSON.stringify(event) + "\n");
  } catch (err) {
    console.error("audit write failed:", err);
  }
}

export function readAudit(limit = 100): AuditEvent[] {
  try {
    const lines = fs.readFileSync(logPath(), "utf8").trim().split("\n");
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => JSON.parse(l) as AuditEvent);
  } catch {
    return [];
  }
}
