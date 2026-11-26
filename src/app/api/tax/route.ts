import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import { cachedBuilt, jsonBody } from "@/lib/book/cache";
import { taxLink } from "@/lib/forecast/forecast";
import { loadForecast } from "@/lib/forecast/load";
import { buildTaxReport } from "@/lib/tax/buildTaxReport";
import { startedTaxYears, TAX_YEARS } from "@/lib/tax/params";
import { taxMoved } from "@/lib/tax/whyMoved";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Each year's tax report, built once per Book (the forecast it links is the Book's too): a year's answer and the next year's "why tax moved" share it. */
const reports = new WeakMap<object, Map<number, ReturnType<typeof buildTaxReport>>>();
function yearReport(book: Parameters<typeof buildTaxReport>[0], year: number, link: ReturnType<typeof taxLink> | null) {
  let byYear = reports.get(book);
  if (!byYear) reports.set(book, (byYear = new Map()));
  let r = byYear.get(year);
  if (!r) byYear.set(year, (r = buildTaxReport(book, year, { forecast: link })));
  return r;
}

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
  const asked = Number(request.nextUrl.searchParams.get("year"));
  try {
    return jsonBody(
      await cachedBuilt(prisma, `tax|${TAX_YEARS[asked] ? asked : "current"}`, async (book) => {
        const supported = startedTaxYears(book.today);
        // No year asked: the Book's year (book.today), the one every figure is built as of.
        const raw = supported.includes(asked) ? asked : Number(book.today.slice(0, 4));
        const year = supported.includes(raw) ? raw : Math.max(...supported);
        const { forecast } = await loadForecast(prisma, book);
        // Birth years (the 401(k) catch-up limit) come from the Book, as on every page.
        const link = forecast ? taxLink(forecast) : null;
        const report = yearReport(book, year, link);
        // Overview › why tax moved: the year before on the same terms, where both can be proven (built once per Book, shared with that year's own answer).
        const prior = !report.blocked && supported.includes(year - 1) ? yearReport(book, year - 1, link) : null;
        return { ...report, supportedYears: supported, moved: !report.blocked && prior && !prior.blocked ? taxMoved(report, prior) : null };
      }),
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
