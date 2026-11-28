import { readAuditHead } from "@/lib/audit/logAuditEvent";
import { checkChain } from "@/lib/audit/chain";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { readDrill } from "@/lib/backup/drill";
import { dataStamp, getBook } from "@/lib/book/cache";
import type { SweepReport } from "@/lib/book/proof/sweep";
import { proofSweep } from "@/lib/book/proof/sweepProcess";
import { trustOf, type TrustPanelBody } from "@/lib/book/proof/trust";
import { prisma } from "@/lib/db";
import { movedSince } from "@/lib/restatements";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * The Dashboard's Trust panel, in one answer: the proof sweep's counts (proof/trust.ts), the
 * date the data is proven through, the restatements since the last month-end, whether the
 * audit chain holds and the last restore drill. Counts, dates and verdicts only: no figure.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const now = proofSweep().peek();
  if (now.state !== "ready") return NextResponse.json({ status: now.state }, { status: 202 });
  const report = JSON.parse(now.body) as SweepReport;
  const [book, events] = await Promise.all([getBook(prisma, dataStamp()), prisma.auditEvent.findMany({ select: { id: true, occurredAt: true, action: true, actor: true, payloadJson: true, correlationId: true } })]);
  const chain = checkChain(events, readAuditHead());
  const since = movedSince(report.cleared);
  const drill = readDrill();
  const body: TrustPanelBody = {
    trust: trustOf(report),
    provenThrough: book.horizon.netWorth,
    restated: since ? { month: since.month, moved: since.moved.length, compared: since.compared } : null,
    chain: { ok: chain.ok, chained: chain.chained, problems: chain.problems.length, head: chain.head },
    drill: drill ? { at: drill.at, ok: drill.ok, matches: drill.matches } : null,
  };
  return NextResponse.json(body);
}
