import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import { loadTaxProfile, saveTaxProfile } from "@/lib/tax/profile";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await loadTaxProfile(prisma));
}

/** Body: the whole tax profile (household, dependents, per-year inputs). */
export async function PUT(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected a tax profile object" }, { status: 400 });
  }
  const saved = await saveTaxProfile(prisma, body);
  await logAuditEvent({ action: "tax_profile_updated", actor: AUDIT_ACTOR_APP, payload: { years: Object.keys(saved.years) } });
  return NextResponse.json(saved);
}
