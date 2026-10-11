import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { netWorthBlockers } from "@/lib/book/blockers";
import { cachedReport, jsonBody } from "@/lib/book/cache";
import type { Book } from "@/lib/book/load";
import { refs } from "@/lib/book/reports/blockerRef";
import { buildCashFlowReport } from "@/lib/book/reports/cashFlow";
import { buildNetWorth } from "@/lib/book/reports/netWorth";
import { latestProvenMonthEnd } from "@/lib/book/reports/spending";
import { homeEncouragement } from "@/lib/dashboard/homeEncouragement";
import { addDays, endOfMonth, startOfMonth } from "@/lib/dates/isoDate";
import { prisma } from "@/lib/db";
import { GROUP_ORDER } from "@/lib/ledger/loadLedger";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const LIQUID_GROUPS = new Set(["Cash", "Taxable investments", "Credit cards"]);

/** First day of the month `n` months before the month containing `iso`. */
function monthsBack(iso: string, n: number): string {
  let d = startOfMonth(iso);
  for (let i = 0; i < n; i++) d = startOfMonth(addDays(d, -1));
  return d;
}

/**
 * Home dashboard payload from the Book: net worth with its recent changes and
 * composition, the last twelve full months of cash flow, last month's spending by
 * category against the twelve-month average, and the integrity status. Every figure
 * carries the findings that block it; a blocked figure is withheld (null).
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return jsonBody(await cachedReport(prisma, "home-summary", summary));
}

async function summary(book: Book) {
  const nw = buildNetWorth(book, { granularity: "month" });
  const periods = nw.periods;
  const asOf = nw.provenThrough;
  const nwBlockers = nw.current.blockers;
  const known = nwBlockers.length === 0;
  const closingAt = (i: number) => periods.at(i) ?? null;
  // A change needs both ends proven.
  const change = (p: (typeof periods)[number] | null) => {
    if (!p || !known) return { cents: null, blockers: nwBlockers };
    const b = refs(netWorthBlockers(book, addDays(p.end, 1), asOf));
    return { cents: b.length ? null : nw.current.totalCents - p.household.closingCents, blockers: b };
  };
  const yearEnd = periods.find((p) => p.end === `${Number(asOf.slice(0, 4)) - 1}-12-31`) ?? null;

  const byGroup = new Map<string, number>();
  for (const a of nw.accounts) byGroup.set(a.group, (byGroup.get(a.group) ?? 0) + a.currentCents);
  const groups = GROUP_ORDER.filter((g) => byGroup.has(g) && byGroup.get(g) !== 0).map((g) => ({ group: g, cents: byGroup.get(g)! }));

  // Where the last twelve months of change came from.
  const t12 = periods.slice(-12);
  const t12Blockers = refs(netWorthBlockers(book, t12[0]?.start ?? asOf, asOf));
  const sum = (f: (h: (typeof periods)[number]["household"]) => number) => t12.reduce((s, p) => s + f(p.household), 0);

  // Twelve months of cash flow ending at the latest proven month (the month the Cash flow
  // page ends at), so a month still waiting on a statement doesn't withhold all of them.
  const cfThrough = book.horizon.cashFlow;
  const throughMonthEnd = latestProvenMonthEnd(book) ?? (endOfMonth(cfThrough) === cfThrough ? cfThrough : addDays(startOfMonth(cfThrough), -1));
  const cf = buildCashFlowReport(book, { granularity: "month", from: monthsBack(throughMonthEnd, 11), to: throughMonthEnd });
  const cfBlockers = [...new Map(cf.periods.flatMap((p) => p.blockers).map((b) => [b.id, b])).values()];
  const cfKnown = cfBlockers.length === 0;
  const lastMonth = cf.periods.at(-1);
  const avg = new Map<string, number>();
  for (const p of cf.periods) for (const c of p.spendingByCategory) avg.set(c.category, (avg.get(c.category) ?? 0) + c.cents / cf.periods.length);
  const categories = cfKnown
    ? [...avg.keys()]
        .map((category) => ({
          category,
          lastMonthCents: lastMonth?.spendingByCategory.find((c) => c.category === category)?.cents ?? 0,
          avgCents: Math.round(avg.get(category)!),
        }))
        .filter((c) => c.lastMonthCents > 0 || c.avgCents > 0)
        .sort((a, b) => b.avgCents - a.avgCents)
    : [];
  const income12 = cf.periods.reduce((s, p) => s + p.incomeCents, 0);
  const spending12 = cf.periods.reduce((s, p) => s + p.spendingCents, 0);

  const needsReview = await prisma.transaction.count({ where: { needsReview: true, statementImport: { isSummary: false } } });
  // Findings past the data edge are statements still on their way, counted apart.
  const findings = book.integrity.findings.filter((f) => !f.atEdge);
  return {
    netWorth: {
      asOf,
      blockers: nwBlockers,
      quality: nw.current.quality,
      totalCents: known ? nw.current.totalCents : null,
      assetsCents: known ? nw.accounts.reduce((s, a) => s + Math.max(0, a.currentCents), 0) : null,
      debtsCents: known ? nw.accounts.reduce((s, a) => s + Math.min(0, a.currentCents), 0) : null,
      liquidCents: known ? nw.accounts.filter((a) => LIQUID_GROUPS.has(a.group)).reduce((s, a) => s + a.currentCents, 0) : null,
      change: { month: change(closingAt(-2)), year: change(closingAt(-13)), ytd: change(yearEnd), ytdYear: asOf.slice(0, 4) },
      drivers: t12Blockers.length
        ? null
        : {
            principalCents: sum((h) => h.principalCents + h.newlyTrackedCents),
            growthCents: sum((h) => h.growthNetOfFeesCents),
            otherCents: sum((h) => h.transferResidualCents + h.unexplainedCents),
          },
      driversBlockers: t12Blockers,
      groups: known ? groups : [],
      series: periods.slice(-24).map((p) => ({ end: p.end, label: p.label, cents: p.blockers.length ? null : p.household.closingCents, quality: p.household.quality })),
      mergeDate: nw.mergeDate,
    },
    cashFlow: {
      through: throughMonthEnd,
      blockers: cfBlockers,
      months: cf.periods.map((p) => ({
        label: p.label,
        start: p.start,
        end: p.end,
        blocked: p.blockers.length > 0,
        incomeCents: p.blockers.length ? null : p.incomeCents,
        spendingCents: p.blockers.length ? null : p.spendingCents,
        netCents: p.blockers.length ? null : p.netCents,
        savingsRate: p.blockers.length ? null : p.savingsRate,
      })),
      last12: cfKnown ? { incomeCents: income12, spendingCents: spending12, netCents: income12 - spending12, savingsRate: income12 > 0 ? (income12 - spending12) / income12 : null } : null,
      lastMonth:
        lastMonth && lastMonth.blockers.length === 0
          ? { label: lastMonth.label, start: lastMonth.start, end: lastMonth.end, incomeCents: lastMonth.incomeCents, spendingCents: lastMonth.spendingCents, netCents: lastMonth.netCents }
          : null,
      categories,
    },
    integrity: {
      failing: findings.filter((f) => f.status === "FAIL").length,
      missing: findings.filter((f) => f.status === "MISSING").length,
      awaiting: book.integrity.findings.length - findings.length,
      edge: book.horizon.netWorth,
      accepted: book.integrity.accepted.length,
      toReview: book.integrity.stale.length,
      checksPassing: book.integrity.checks.filter((c) => c.failed === 0 && c.missing === 0).length,
      checksTotal: book.integrity.checks.length,
    },
    attention: { needsReview },
    encouragement: homeEncouragement({ netWorthDeltaCents: change(closingAt(-13)).cents }),
  };
}
