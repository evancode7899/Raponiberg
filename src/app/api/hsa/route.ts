import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import { loadHsaReport } from "@/lib/hsa/loadReport";
import { applyHsaOp, type HsaOp } from "@/lib/hsa/store";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The HSA receipts log joined to the ledger (lib/hsa/report.ts). */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await loadHsaReport(prisma));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the HSA log" }, { status: 500 });
  }
}

/** Body: one change (lib/hsa/store.ts HsaOp): add, update, delete, reimburse, dismiss… */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as HsaOp | null;
  if (!body || typeof body !== "object" || typeof body.op !== "string") {
    return NextResponse.json({ error: "Expected a change ({ op: … })" }, { status: 400 });
  }
  try {
    const result = applyHsaOp(body);
    // Amounts and providers stay in the journal beside the log; the audit trail only says what kind of change.
    if (result.changed) await logAuditEvent({ action: "hsa_expenses_updated", actor: AUDIT_ACTOR_APP, payload: { op: body.op, changed: result.changed } });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save" }, { status: 400 });
  }
}
