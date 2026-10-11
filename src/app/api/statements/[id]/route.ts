import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** One account section of a document, with its rows and how each was classified. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const statement = await prisma.statementImport.findUnique({
    where: { id },
    include: {
      account: { select: { id: true, name: true } },
      document: { select: { id: true, title: true, originalFileName: true, warningsJson: true } },
      transactions: {
        orderBy: [{ date: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          date: true,
          amountCents: true,
          payee: true,
          section: true,
          detail: true,
          cardMember: true,
          lane: true,
          datePrecision: true,
          needsReview: true,
          classifiedBy: true,
          confidence: true,
          userLocked: true,
          category: { select: { name: true } },
          transferLeg: { select: { matchId: true } },
        },
      },
    },
  });
  if (!statement) return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  return NextResponse.json({ statement });
}
