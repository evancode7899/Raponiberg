import { netWorthBlockers } from "../book/blockers.ts";
import type { Book } from "../book/load.ts";
import type { ProofDescriptor } from "../book/proof/index.ts";
import { refs } from "../book/reports/blockerRef.ts";
import { buildCashFlowReport } from "../book/reports/cashFlow.ts";
import { buildNetWorth } from "../book/reports/netWorth.ts";
import { latestProvenMonthEnd } from "../book/reports/spending.ts";
import { addDays, endOfMonth, startOfMonth } from "../dates/isoDate.ts";
import { GROUP_ORDER } from "../ledger/loadLedger.ts";
import { homeEncouragement } from "./homeEncouragement.ts";

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
 * carries the findings that block it; a blocked figure is withheld (null). Each figure
 * shown also carries the descriptor of its proof (`proof`), naming exactly that figure.
 */
export function buildHomeSummary(book: Book) {
  const nw = buildNetWorth(book, { granularity: "month" });
  const periods = nw.periods;
  const asOf = nw.provenThrough;
  const nwBlockers = nw.current.blockers;
  const known = nwBlockers.length === 0;
  const closingAt = (i: number) => periods.at(i) ?? null;
  const balance = (extra: { accountIds?: string[]; side?: "assets" | "debts" } = {}): ProofDescriptor => ({ report: "net-worth", metric: "balance", date: asOf, ...extra });
  // A change needs both ends proven.
  const change = (p: (typeof periods)[number] | null) => {
    if (!p || !known) return { cents: null, blockers: nwBlockers };
    const b = refs(netWorthBlockers(book, addDays(p.end, 1), asOf));
    if (b.length) return { cents: null, blockers: b };
    const proof: ProofDescriptor = { report: "net-worth", metric: "change", granularity: "month", start: addDays(p.end, 1), end: asOf };
    return { cents: nw.current.totalCents - p.household.closingCents, blockers: b, proof };
  };
  const yearEnd = periods.find((p) => p.end === `${Number(asOf.slice(0, 4)) - 1}-12-31`) ?? null;

  const byGroup = new Map<string, { cents: number; accountIds: string[] }>();
  for (const a of nw.accounts) {
    const g = byGroup.get(a.group) ?? { cents: 0, accountIds: [] };
    g.cents += a.currentCents;
    g.accountIds.push(a.id);
    byGroup.set(a.group, g);
  }
  const groups = GROUP_ORDER.filter((g) => byGroup.has(g) && byGroup.get(g)!.cents !== 0).map((g) => ({
    group: g,
    cents: byGroup.get(g)!.cents,
    proof: balance({ accountIds: byGroup.get(g)!.accountIds }),
  }));
  const liquidIds = nw.accounts.filter((a) => LIQUID_GROUPS.has(a.group)).map((a) => a.id);

  // Where the last twelve months of change came from.
  const t12 = periods.slice(-12);
  const t12Blockers = refs(netWorthBlockers(book, t12[0]?.start ?? asOf, asOf));
  const sum = (f: (h: (typeof periods)[number]["household"]) => number) => t12.reduce((s, p) => s + f(p.household), 0);
  const driver = (figure: "saving" | "markets"): ProofDescriptor => ({ report: "dashboard", figure, start: t12[0]?.start ?? asOf, end: asOf });

  // Twelve months of cash flow ending at the latest proven month (the month the Cash flow
  // page ends at), so a month still waiting on a statement doesn't withhold all of them.
  const cfThrough = book.horizon.cashFlow;
  const throughMonthEnd = latestProvenMonthEnd(book) ?? (endOfMonth(cfThrough) === cfThrough ? cfThrough : addDays(startOfMonth(cfThrough), -1));
  const cfFrom = monthsBack(throughMonthEnd, 11);
  const cf = buildCashFlowReport(book, { granularity: "month", from: cfFrom, to: throughMonthEnd });
  const cfBlockers = [...new Map(cf.periods.flatMap((p) => p.blockers).map((b) => [b.id, b])).values()];
  const cfKnown = cfBlockers.length === 0;
  const cashFlow = (metric: "income" | "spending" | "net", start: string, end: string, category?: string): ProofDescriptor => ({
    report: "cash-flow",
    metric,
    granularity: "month",
    start,
    end,
    ...(category ? { category } : {}),
  });
  const lastMonth = cf.periods.at(-1);
  const avg = new Map<string, number>();
  for (const p of cf.periods) for (const c of p.spendingByCategory) avg.set(c.category, (avg.get(c.category) ?? 0) + c.cents / cf.periods.length);
  const categories = cfKnown
    ? [...avg.keys()]
        .map((category) => ({
          category,
          lastMonthCents: lastMonth?.spendingByCategory.find((c) => c.category === category)?.cents ?? 0,
          avgCents: Math.round(avg.get(category)!),
          proof: lastMonth ? cashFlow("spending", lastMonth.start, lastMonth.end, category) : undefined,
        }))
        .filter((c) => c.lastMonthCents > 0 || c.avgCents > 0)
        .sort((a, b) => b.avgCents - a.avgCents)
    : [];
  const income12 = cf.periods.reduce((s, p) => s + p.incomeCents, 0);
  const spending12 = cf.periods.reduce((s, p) => s + p.spendingCents, 0);

  // Findings past the data edge are statements still on their way, counted apart.
  const findings = book.integrity.findings.filter((f) => !f.atEdge);
  return {
    /** No committed statement yet: the page welcomes instead of showing empty figures. */
    hasStatements: book.ledger.accounts.length > 0,
    netWorth: {
      asOf,
      blockers: nwBlockers,
      quality: nw.current.quality,
      totalCents: known ? nw.current.totalCents : null,
      assetsCents: known ? nw.accounts.reduce((s, a) => s + Math.max(0, a.currentCents), 0) : null,
      debtsCents: known ? nw.accounts.reduce((s, a) => s + Math.min(0, a.currentCents), 0) : null,
      liquidCents: known ? nw.accounts.filter((a) => LIQUID_GROUPS.has(a.group)).reduce((s, a) => s + a.currentCents, 0) : null,
      proofs: known
        ? {
            total: balance(),
            assets: balance({ side: "assets" }),
            debts: balance({ side: "debts" }),
            liquid: liquidIds.length ? balance({ accountIds: liquidIds }) : null,
          }
        : null,
      change: { month: change(closingAt(-2)), year: change(closingAt(-13)), ytd: change(yearEnd), ytdYear: asOf.slice(0, 4) },
      drivers: t12Blockers.length
        ? null
        : {
            principalCents: sum((h) => h.principalCents + h.newlyTrackedCents),
            growthCents: sum((h) => h.growthNetOfFeesCents),
            otherCents: sum((h) => h.transferResidualCents + h.unexplainedCents),
            proofs: { principal: driver("saving"), growth: driver("markets") },
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
      last12: cfKnown
        ? {
            incomeCents: income12,
            spendingCents: spending12,
            netCents: income12 - spending12,
            savingsRate: income12 > 0 ? (income12 - spending12) / income12 : null,
            proofs: { income: cashFlow("income", cfFrom, throughMonthEnd), spending: cashFlow("spending", cfFrom, throughMonthEnd), net: cashFlow("net", cfFrom, throughMonthEnd) },
          }
        : null,
      lastMonth:
        lastMonth && lastMonth.blockers.length === 0
          ? {
              label: lastMonth.label,
              start: lastMonth.start,
              end: lastMonth.end,
              incomeCents: lastMonth.incomeCents,
              spendingCents: lastMonth.spendingCents,
              netCents: lastMonth.netCents,
              proof: cashFlow("spending", lastMonth.start, lastMonth.end),
            }
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
    encouragement: homeEncouragement({ netWorthDeltaCents: change(closingAt(-13)).cents }),
  };
}

export type HomeSummary = ReturnType<typeof buildHomeSummary> & { attention: { needsReview: number } };
