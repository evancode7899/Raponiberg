import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedBuilt, jsonBody } from "@/lib/book/cache";
import { buildPortfolioReturns } from "@/lib/book/reports/portfolioReturns";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * The portfolio against the S&P 500, quarter by quarter (reports/portfolioReturns.ts): the one
 * benchmark engine, which Investments › Returns draws in full and Net worth › Investment
 * returns sums up. The same report the investments route serves inside its own.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return jsonBody(await cachedBuilt(prisma, "portfolio-returns", (book) => buildPortfolioReturns(book)));
}
