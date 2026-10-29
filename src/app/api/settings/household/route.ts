import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { reclassifyRows } from "@/lib/classifier/persist";
import { isIsoDate } from "@/lib/dates/isoDate";
import { prisma } from "@/lib/db";
import { getHouseholdView, getMergeDate, HOUSEHOLD_VIEW_MODES, setHouseholdView, setMergeDate, type HouseholdViewMode } from "@/lib/ledger/householdSettings";
import { refreshDerived } from "@/lib/ledger/maintenance";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ mergeDate: await getMergeDate(prisma), view: await getHouseholdView(prisma) });
}

/**
 * Body: { mergeDate?: "YYYY-MM-DD", view?: "STRICT" | "PRO_FORMA" }. A new merge date re-labels
 * partner transfers on either side of it; the view (book/householdView.ts) only changes what
 * the figures count, so the Book rebuilds with it.
 */
export async function PUT(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { mergeDate?: string; view?: string } | null;
  if (body?.view !== undefined && !HOUSEHOLD_VIEW_MODES.includes(body.view as HouseholdViewMode)) {
    return NextResponse.json({ error: "view must be STRICT or PRO_FORMA" }, { status: 400 });
  }
  if (body?.mergeDate === undefined && body?.view !== undefined) {
    const before = await getHouseholdView(prisma);
    await setHouseholdView(prisma, body.view as HouseholdViewMode);
    await logAuditEvent({ action: "household_settings_updated", actor: AUDIT_ACTOR_APP, payload: { view: { from: before, to: body.view } } });
    return NextResponse.json({ view: body.view, reclassified: 0 });
  }
  if (!body?.mergeDate || !isIsoDate(body.mergeDate)) {
    return NextResponse.json({ error: "mergeDate must be YYYY-MM-DD" }, { status: 400 });
  }
  if (body.view !== undefined) await setHouseholdView(prisma, body.view as HouseholdViewMode);
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
