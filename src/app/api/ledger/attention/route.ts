import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedBuilt, jsonBody } from "@/lib/book/cache";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * What's waiting on a person, for the sidebar badges: classifier questions, and the
 * integrity findings (failures and missing data) that block figures — not those past the
 * data edge, which are statements still on their way.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return jsonBody(
    await cachedBuilt(prisma, "attention", async (book) => {
      const needsReview = await prisma.transaction.count({ where: { needsReview: true, statementImport: { isSummary: false } } });
      const findings = book.integrity.findings.filter((f) => !f.atEdge);
      return {
        needsReview,
        integrityFailing: findings.filter((f) => f.status === "FAIL").length,
        integrityMissing: findings.filter((f) => f.status === "MISSING").length,
      };
    }),
  );
}
