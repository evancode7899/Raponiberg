import { answerAndRefresh } from "@/app/api/transactions/answer";
import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import { refreshDerived } from "@/lib/ledger/maintenance";
import { AnswerError, undoAnswer } from "@/lib/review/answerRows";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Body: { ids: string[], category?, lane?, applyToMerchant?, reviewed? }: one answer over several rows (all of them or none). */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const ids = Array.isArray(body?.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
  if (!body || !ids.length || ids.length > 5000) return NextResponse.json({ error: "Expected { ids: [1 to 5,000 row ids], … }" }, { status: 400 });
  return answerAndRefresh(ids, body);
}

/** ?undo=<undoId>: takes an answer back, while the app stays open. */
export async function DELETE(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const undoId = request.nextUrl.searchParams.get("undo") ?? "";
  try {
    const ids = await undoAnswer(prisma, undoId);
    await logAuditEvent({ action: "transactions_restored", actor: AUDIT_ACTOR_APP, payload: { undoId, rows: ids.length } });
    const maintenance = await refreshDerived(prisma);
    return NextResponse.json({ ok: true, restored: ids.length, maintenance });
  } catch (e) {
    if (e instanceof AnswerError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
