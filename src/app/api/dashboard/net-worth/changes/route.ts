import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedReport, jsonBody } from "@/lib/book/cache";
import { buildNetWorthChanges } from "@/lib/book/reports/netWorthChanges";
import type { Granularity } from "@/lib/dates/isoDate";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * What changed net worth in each proven period (Net worth › What changed): the steps from
 * opening to closing, each against its average over the periods before, the spending and
 * income categories that moved most, and the period in plain sentences.
 * Query: granularity=month|quarter|year.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const g = request.nextUrl.searchParams.get("granularity");
  const granularity: Granularity = g === "quarter" || g === "year" ? g : "month";
  return jsonBody(await cachedReport(prisma, `net-worth-changes|${granularity}`, (book) => buildNetWorthChanges(book, { granularity })));
}
