import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import { refreshDerived } from "@/lib/ledger/maintenance";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Re-runs the classifier over every row not corrected by hand (after rule changes or a
 * classifier upgrade), then re-matches transfers.
 */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // The refresh re-runs the rules itself, inside its one transaction.
  const maintenance = await refreshDerived(prisma);
  const changed = maintenance.reclassified;
  await logAuditEvent({ action: "ledger_reclassified", actor: AUDIT_ACTOR_APP, payload: { changed } });
  return NextResponse.json({ ok: true, changed, maintenance });
}
