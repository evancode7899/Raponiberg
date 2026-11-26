import { AUDIT_ACTOR_APP, AUDIT_ACTOR_SETTINGS, logAuditEvent } from "@/lib/audit/logAuditEvent";
import type { DrillResult } from "./drill";

/** What the audit log keeps of a restore drill: which snapshot, and whether it restored and matched. */
export const logDrill = (r: DrillResult, reason: string) =>
  logAuditEvent({
    action: "restore_drill_run",
    actor: reason === "manual" ? AUDIT_ACTOR_SETTINGS : AUDIT_ACTOR_APP,
    payload: { reason, snapshot: r.snapshot, ok: r.ok, matches: r.matches, changedTables: r.differences.map((d) => d.table), changedFiles: r.changedFiles },
  });
