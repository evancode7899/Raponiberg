import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedReport, jsonBody } from "@/lib/book/cache";
import { buildNetWorth } from "@/lib/book/reports/netWorth";
import { isIsoDate, type Granularity } from "@/lib/dates/isoDate";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Net worth from the Book: per-period opening / net principal / growth (net of fees) /
 * closing for the household and each account, portfolio returns and current balances,
 * through the proven-through date. Each period lists what makes it unprovable.
 * Query: granularity=month|quarter|year, from, to (YYYY-MM-DD).
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const sp = request.nextUrl.searchParams;
  const g = sp.get("granularity");
  const granularity: Granularity = g === "quarter" || g === "year" ? g : "month";
  const from = sp.get("from") ?? undefined;
  const to = sp.get("to") ?? undefined;
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) {
    return NextResponse.json({ error: "from/to must be YYYY-MM-DD" }, { status: 400 });
  }
  return jsonBody(await cachedReport(prisma, `net-worth|${granularity}|${from ?? ""}|${to ?? ""}`, (book) => buildNetWorth(book, { granularity, from, to })));
}
