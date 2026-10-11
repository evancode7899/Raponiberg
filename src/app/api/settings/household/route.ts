import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { reclassifyRows } from "@/lib/classifier/persist";
import { isIsoDate } from "@/lib/dates/isoDate";
import { prisma } from "@/lib/db";
import { getMergeDate, setMergeDate } from "@/lib/ledger/householdSettings";
import { refreshDerived } from "@/lib/ledger/maintenance";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ mergeDate: await getMergeDate(prisma) });
}

/** Body: { mergeDate: "YYYY-MM-DD" }. Re-labels partner transfers on either side of it. */
export async function PUT(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { mergeDate?: string } | null;
  if (!body?.mergeDate || !isIsoDate(body.mergeDate)) {
    return NextResponse.json({ error: "mergeDate must be YYYY-MM-DD" }, { status: 400 });
  }
  const before = await getMergeDate(prisma);
  await setMergeDate(prisma, body.mergeDate);
  const changed = await reclassifyRows(prisma);
  await refreshDerived(prisma);
  await logAuditEvent({
    action: "household_settings_updated",
    actor: AUDIT_ACTOR_APP,
    payload: { mergeDate: { from: before, to: body.mergeDate }, reclassified: changed },
  });
  return NextResponse.json({ mergeDate: body.mergeDate, reclassified: changed });
}
