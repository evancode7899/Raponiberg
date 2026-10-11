import { AUDIT_ACTOR_SETTINGS, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { backupStatus, runBackup } from "@/lib/backup/auto";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The backup folder, the latest snapshot and the last run (see lib/backup). */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(backupStatus());
}

/** Backs up now ("Back up now" in Settings › Data). */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runBackup(prisma, "manual");
    if (result.status === "created") {
      // Logged after the snapshot, so the entry itself lands in the next one.
      await logAuditEvent({ action: "backup_created", actor: AUDIT_ACTOR_SETTINGS, payload: { snapshot: result.snapshot.name } });
    }
    return NextResponse.json({ status: result.status, snapshot: result.snapshot.name, statementsCopied: result.statementsCopied, backup: backupStatus() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Backup failed", backup: backupStatus() }, { status: 500 });
  }
}
