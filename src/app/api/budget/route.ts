import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { loadBudget, saveBudget } from "@/lib/budget/settings";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The owner's monthly spending targets by category (see src/lib/budget/settings.ts). */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await loadBudget(prisma));
}

/** Body: { targets: { [category]: cents } } — replaces every target. */
export async function PUT(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected a budget object" }, { status: 400 });
  }
  const saved = await saveBudget(prisma, body);
  await logAuditEvent({ action: "spending_budget_updated", actor: AUDIT_ACTOR_APP, payload: { categories: Object.keys(saved.targets).length } });
  return NextResponse.json(saved);
}
