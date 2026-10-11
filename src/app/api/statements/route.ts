import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Imported documents, newest statement period first, with each account section's
 * status and reconciliation. `?status=attention` limits to documents with a section
 * that isn't committed.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const attention = request.nextUrl.searchParams.get("status") === "attention";
  const documents = await prisma.sourceDocument.findMany({
    where: attention ? { statementImports: { some: { status: { not: "COMMITTED" } } } } : {},
    orderBy: [{ periodEnd: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      title: true,
      institution: true,
      kind: true,
      parserId: true,
      originalFileName: true,
      periodStart: true,
      periodEnd: true,
      warningsJson: true,
      createdAt: true,
      _count: { select: { payStubs: true } },
      statementImports: {
        orderBy: { periodStart: "asc" },
        select: {
          id: true,
          status: true,
          isSummary: true,
          periodStart: true,
          periodEnd: true,
          openingBalanceCents: true,
          closingBalanceCents: true,
          growthCents: true,
          feesCents: true,
          reconciliationDeltaCents: true,
          checksJson: true,
          account: { select: { id: true, name: true } },
          _count: { select: { transactions: true } },
        },
      },
    },
  });
  return NextResponse.json({ documents });
}
