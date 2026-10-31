import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedBuilt, jsonBody } from "@/lib/book/cache";
import type { Book } from "@/lib/book/load";
import { buildHomeSummary, type HomeSummary } from "@/lib/dashboard/homeSummary";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Home dashboard payload from the Book (lib/dashboard/homeSummary.ts), plus the count of rows awaiting classification. */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return jsonBody(await cachedBuilt(prisma, "home-summary", summary));
}

async function summary(book: Book): Promise<HomeSummary> {
  const needsReview = await prisma.transaction.count({ where: { needsReview: true, statementImport: { isSummary: false } } });
  return { ...buildHomeSummary(book), attention: { needsReview } };
}
