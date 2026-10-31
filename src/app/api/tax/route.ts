import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import { cachedBuilt, jsonBody } from "@/lib/book/cache";
import { taxLink } from "@/lib/forecast/forecast";
import { loadForecast } from "@/lib/forecast/load";
import { buildTaxReport } from "@/lib/tax/buildTaxReport";
import { TAX_YEARS } from "@/lib/tax/params";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Projected federal + Connecticut taxes for one year: W-2 build-up from pay stubs,
 * investment income from statements, payments from the bank ledger, joint vs separate,
 * dependent impact, and the safe-harbor true-up. The year in progress takes each person's
 * paycheck basis and the bonuses still to come from the shared forecast. Query: year
 * (defaults to this year).
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const supported = Object.keys(TAX_YEARS).map(Number);
  const asked = Number(request.nextUrl.searchParams.get("year"));
  try {
    return jsonBody(
      await cachedBuilt(prisma, `tax|${supported.includes(asked) ? asked : "current"}`, async (book) => {
        // No year asked: the Book's year (book.today), the one every figure is built as of.
        const raw = supported.includes(asked) ? asked : Number(book.today.slice(0, 4));
        const year = supported.includes(raw) ? raw : Math.max(...supported);
        const { forecast } = await loadForecast(prisma, book);
        // Birth years (the 401(k) catch-up limit) come from the Book, as on every page.
        return { ...buildTaxReport(book, year, { forecast: forecast ? taxLink(forecast) : null }), supportedYears: supported };
      }),
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
