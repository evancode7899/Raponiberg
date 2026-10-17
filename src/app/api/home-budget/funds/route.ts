import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedReport, jsonBody } from "@/lib/book/cache";
import { buildHomeFunds, buildHomeSpending } from "@/lib/book/reports/homeFunds";
import { prisma } from "@/lib/db";
import { homeForecast } from "@/lib/forecast/forecast";
import { loadForecast } from "@/lib/forecast/load";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Money the household could put toward a home, from the Book: bank cash and taxable
 * investments at the proven-through date, with the investments' embedded gain — plus the
 * shared forecast's liquid money and salary ahead, for a buy date in the future.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return jsonBody(
    await cachedReport(prisma, "home-funds", async (book) => {
      const { forecast, data } = await loadForecast(prisma, book);
      const seeds = data.profile.seeds;
      return {
        ...buildHomeFunds(book),
        forecast: forecast && seeds ? homeForecast(forecast, seeds) : null,
        spending: buildHomeSpending(book, data.profile.settings),
      };
    }),
  );
}
