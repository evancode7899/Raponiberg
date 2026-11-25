import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { LANES, type Lane } from "@/lib/classifier/taxonomy";
import { prisma } from "@/lib/db";
import { refreshDerived } from "@/lib/ledger/maintenance";
import { AnswerError, answerRows } from "@/lib/review/answerRows";
import { NextResponse } from "next/server";

/** At most this many rows' before and after are written to one audit entry. */
const AUDIT_ROWS = 50;

/** One answer over one or more rows: applied together, put on the audit log with what it replaced, and the ledger refreshed once. */
export async function answerAndRefresh(ids: string[], body: Record<string, unknown>): Promise<NextResponse> {
  const lane = typeof body.lane === "string" ? (body.lane as Lane) : undefined;
  if (lane && !LANES.includes(lane)) return NextResponse.json({ error: `lane must be one of ${LANES.join(", ")}` }, { status: 400 });
  try {
    const r = await answerRows(prisma, {
      ids,
      category: typeof body.category === "string" ? body.category : undefined,
      lane,
      applyToMerchant: body.applyToMerchant === true,
      reviewed: body.reviewed === true,
    });
    await logAuditEvent({
      action: "transaction_classified",
      actor: AUDIT_ACTOR_APP,
      payload: { rows: r.audit.slice(0, AUDIT_ROWS), rowCount: r.audit.length, merchantKey: r.merchantKey, applyToMerchant: body.applyToMerchant === true, affected: r.affected },
    });
    const maintenance = r.needsRefresh ? await refreshDerived(prisma) : null;
    return NextResponse.json({ ok: true, affected: r.affected, undoId: r.undoId, maintenance });
  } catch (e) {
    if (e instanceof AnswerError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
