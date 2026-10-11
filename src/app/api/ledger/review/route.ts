import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import { computeMatches } from "@/lib/transfers/runMatching";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const txnSelect = {
  id: true,
  date: true,
  amountCents: true,
  payee: true,
  detail: true,
  section: true,
  lane: true,
  merchantKey: true,
  classifiedBy: true,
  confidence: true,
  counterpartyInstitution: true,
  account: { select: { id: true, name: true } },
  category: { select: { name: true } },
  statementImport: { select: { status: true, periodStart: true, periodEnd: true } },
} as const;

/**
 * Everything that wants a human decision:
 *  - rows the classifier wasn't sure about (grouped by merchant, so one answer can
 *    teach every row from that merchant);
 *  - transfer legs with no partner yet, ambiguous pairings, and near-miss pairings
 *    (e.g. a rollover that lost a fee in transit) offered for confirmation.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const [needsReview, unmatched, { result }] = await Promise.all([
    prisma.transaction.findMany({
      where: { needsReview: true, statementImport: { isSummary: false } },
      orderBy: [{ amountCents: "asc" }],
      take: 2000,
      select: txnSelect,
    }),
    prisma.transaction.findMany({
      where: { lane: "TRANSFER", transferLeg: null, statementImport: { isSummary: false } },
      orderBy: { date: "desc" },
      select: txnSelect,
    }),
    computeMatches(prisma),
  ]);

  const ids = [...new Set([...result.ambiguous.flat(), ...result.suggestions.flatMap((s) => s.legIds)])];
  const rows = await prisma.transaction.findMany({ where: { id: { in: ids } }, select: txnSelect });
  const byId = new Map(rows.map((r) => [r.id, r]));

  return NextResponse.json({
    needsReview,
    transfers: {
      unmatched,
      ambiguous: result.ambiguous.map((g) => g.map((id) => byId.get(id)).filter(Boolean)),
      suggestions: result.suggestions.map((s) => ({
        differenceCents: s.differenceCents,
        legs: s.legIds.map((id) => byId.get(id)).filter(Boolean),
      })),
    },
  });
}
