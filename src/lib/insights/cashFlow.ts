import { categoryKey, windowKey } from "../book/derived/cashFlow.ts";
import { savingsRate } from "../book/definitions.ts";
import type { CashFlowMetric } from "../book/proof/cashFlowProof.ts";
import { noFigure } from "../book/proof/clearance.ts";
import { compositeOf, type ProofRef } from "../book/proof/compose.ts";
import { cashFlowDescriptor, median, mergeCategories, SPEND_CATEGORIES, spendingMover, sum, type CashFlowRecipe, type Slice } from "../book/reports/cashFlowWindows.ts";
import type { SpendingMonth, SpendingReport } from "../book/reports/spending.ts";
import { formatDisplayDateFromYmd } from "../displayTime.ts";
import { formatPercentRatio, usd0, usdCompact } from "../formatMoney.ts";

type Report = SpendingReport;

export { SPEND_CATEGORIES };

export type Totals = {
  n: number;
  income: number;
  spending: number;
  net: number;
  oneOff: number;
  avgIncome: number;
  avgSpending: number;
  /** Median month, which a bonus or a one-off doesn't move. */
  typicalIncome: number;
  typicalSpending: number;
  /** Average month excluding spending counted as one-off. */
  avgCore: number;
  savingsRate: number | null;
  employee: number;
  employer: number;
};

export function totals(months: SpendingMonth[]): Totals {
  const n = Math.max(1, months.length);
  const income = sum(months, (m) => m.incomeCents);
  const spending = sum(months, (m) => m.spendingCents);
  const oneOff = sum(months, (m) => m.oneOffCents);
  return {
    n: months.length,
    income,
    spending,
    net: income - spending,
    oneOff,
    avgIncome: income / n,
    avgSpending: spending / n,
    typicalIncome: median(months.map((m) => m.incomeCents)),
    typicalSpending: median(months.map((m) => m.spendingCents)),
    avgCore: (spending - oneOff) / n,
    savingsRate: savingsRate(income, income - spending),
    employee: sum(months, (m) => m.retirementEmployeeCents),
    employer: sum(months, (m) => m.retirementEmployerCents),
  };
}

export const categoryCents = (m: SpendingMonth, category: string) => m.spendingByCategory.find((c) => c.category === category)?.cents ?? 0;

/** A number in an insight's words, and the figure it is: a sentence's numbers are as provable as a tile's. */
export type Seg = string | { text: string; proof: ProofRef };

/** `key`: the insight in plain words, for ordering and as a list key. */
export type Insight = {
  tone: "good" | "bad" | "info" | "warn";
  key: string;
  title: Seg[];
  body: Seg[];
  action?: { label: string; tab?: string; category?: string };
  /** 0: something changed. 1: worth knowing. 2: context. 3: nothing changed. */
  rank: 0 | 1 | 2 | 3;
  /** Dollars a year it's about: within a rank, the most money leads. */
  weight: number;
};

/** Builds a figure's proof target over months (CashFlowClient's ctx.proof). */
export type ProofOf = (metric: CashFlowMetric, months: SpendingMonth[], o: ProofOptions) => ProofRef;

/** The page's proofs an insight's numbers use: sums over months (ctx.proof) and derived figures (ctx.dp). */
export type InsightProofs = { proof: ProofOf; dp: (figure: string, key?: string) => ProofRef };

const pct = (r: number) => formatPercentRatio(Math.abs(r), 0);
const words = (segs: Seg[]) => segs.map((x) => (typeof x === "string" ? x : x.text)).join("");

/**
 * Plain-language observations about the selected months, most useful first. Each
 * compares like with like: averages per month against the same-length run before.
 * Every number in them is a figure with its proof (Seg), never loose text.
 */
export function buildInsights(slice: Slice, r: Report, x: InsightProofs): Insight[] {
  const out: Insight[] = [];
  const { months, prior } = slice;
  if (!months.length) return out;
  const t = totals(months);
  const p = prior.length ? totals(prior) : null;
  const key = windowKey(months);
  const fig = (text: string, proof: ProofRef): Seg => ({ text, proof });
  const push = (i: Omit<Insight, "key">) => out.push({ ...i, key: words(i.title) });
  const perMonth = (metric: CashFlowMetric, ms: SpendingMonth[], cents: number, o: Omit<ProofOptions, "shownCents" | "perMonth"> = {}) => fig(usd0(cents / Math.max(1, ms.length)), x.proof(metric, ms, { ...o, perMonth: true, shownCents: cents }));

  if (p && p.avgSpending > 0) {
    const ch = t.avgSpending / p.avgSpending - 1;
    const driver = spendingMover(slice);
    // The change in a month's spending: this run against the one before, each over its months.
    const change = fig(pct(ch), compositeOf("growth", [x.proof("spending", months, { shownCents: t.spending }), x.proof("spending", prior, { shownCents: p.spending })], { ratio: ch }, [t.n, p.n]));
    if (Math.abs(ch) >= 0.05) {
      const mover =
        driver
          ? [
              ` Biggest mover: ${driver.c} (${driver.d > 0 ? "+" : "−"}`,
              fig(usd0(Math.abs(driver.d)), compositeOf("diff", [x.proof("spending", months, { category: driver.c, shownCents: driver.now }), x.proof("spending", prior, { category: driver.c, shownCents: driver.then })], { cents: driver.d }, [t.n, p.n])),
              "/mo).",
            ]
          : [];
      push({
        rank: 0,
        weight: Math.abs(t.avgSpending - p.avgSpending) * 12,
        tone: ch > 0 ? "warn" : "good",
        title: [`Spending ${ch > 0 ? "up" : "down"} `, change, ` vs ${slice.priorLabel}`],
        body: [perMonth("spending", months, t.spending), "/mo now against ", perMonth("spending", prior, p.spending), "/mo then.", ...mover],
        action: driver ? { label: `Open ${driver.c}`, tab: "spending", category: driver.c } : undefined,
      });
    } else {
      push({ rank: 3, weight: t.avgSpending * 12, tone: "info", title: ["Spending is steady"], body: [perMonth("spending", months, t.spending), "/mo, within ", change, ` of ${slice.priorLabel} (`, perMonth("spending", prior, p.spending), "/mo)."] });
    }
  }

  if (t.savingsRate != null) {
    const months_ = months.filter((m) => m.incomeCents > 0);
    const best = [...months_].sort((a, b) => (b.savingsRate ?? -9) - (a.savingsRate ?? -9))[0];
    const deficit = months.filter((m) => m.netCents < 0).length;
    push({
      rank: 1,
      weight: Math.abs(t.net / Math.max(1, t.n)) * 12,
      tone: t.savingsRate >= 0.2 ? "good" : t.savingsRate >= 0 ? "info" : "bad",
      title: ["You kept ", fig(formatPercentRatio(t.savingsRate, 0), x.dp("savings-rate", key)), " of income"],
      body: [
        fig(usd0(t.net), x.proof("net", months, { shownCents: t.net })),
        ` saved over ${t.n} month${t.n === 1 ? "" : "s"}. ${deficit ? `${deficit} month${deficit === 1 ? "" : "s"} spent more than came in` : "No month spent more than came in"}`,
        ...(best && t.n > 2 ? [`; best was ${best.label} (`, fig(formatPercentRatio(best.savingsRate ?? 0, 0), x.dp("savings-rate", windowKey([best]))), ")"] : []),
        ".",
      ],
    });
  }

  if (t.n >= 3 && t.typicalIncome > 0 && t.avgIncome > t.typicalIncome * 1.25) {
    push({
      rank: 2,
      weight: (t.avgIncome - t.typicalIncome) * 12,
      tone: "info",
      title: ["Bonuses lift the average"],
      body: [
        "A typical month brings in ",
        fig(usd0(t.typicalIncome), x.dp("typical-income", key)),
        ", but the average is ",
        perMonth("income", months, t.income),
        " — the gap is irregular pay (bonuses, one-time deposits). Budget against the typical month.",
      ],
      action: { label: "See income", tab: "income" },
    });
  }

  const cats = mergeCategories(months, (m) => m.spendingByCategory).filter((c) => c.cents > 0);
  const top = cats[0];
  if (top && t.spending > 0) {
    push({
      rank: 2,
      weight: (top.cents / Math.max(1, t.n)) * 12,
      tone: "info",
      title: [`${top.category} is `, fig(pct(top.cents / t.spending), x.dp("category-share", categoryKey(months, "EXPENSE", top.category))), " of spending"],
      body: [
        perMonth("spending", months, top.cents, { category: top.category }),
        "/mo on average",
        ...(cats[1] ? [`, then ${cats[1].category} (`, perMonth("spending", months, cats[1].cents, { category: cats[1].category }), `/mo) and ${cats[2]?.category ?? "the rest"}`] : []),
        ".",
      ],
      action: { label: `Open ${top.category}`, tab: "spending", category: top.category },
    });
  }

  // Latest month against the typical one, per category.
  const last = months.at(-1)!;
  if (t.n >= 3) {
    const rest = months.slice(0, -1);
    const spikes = SPEND_CATEGORIES.map((c) => ({ c, now: categoryCents(last, c), typ: median(rest.map((m) => categoryCents(m, c))) }))
      .filter((y) => y.now - y.typ >= 20000 && y.now > y.typ * 1.4)
      .sort((a, b) => b.now - b.typ - (a.now - a.typ));
    const s = spikes[0];
    if (s) {
      const now = x.proof("spending", [last], { category: s.c, shownCents: s.now });
      const typ = x.dp("category-typical-earlier", categoryKey(months, "EXPENSE", s.c));
      push({
        rank: 0,
        weight: s.now - Math.max(0, s.typ),
        tone: "warn",
        title: [`${s.c} ran high in ${last.label}`],
        // A typical month of none, or of refunds, has no typical amount worth stating.
        body:
          s.typ > 0
            ? [fig(usd0(s.now), now), " against a typical ", fig(usd0(s.typ), typ), " — ", fig(usd0(s.now - s.typ), compositeOf("diff", [now, typ], { cents: s.now - s.typ })), " more than usual."]
            : [fig(usd0(s.now), now), ", in a category a typical month spends nothing on."],
        action: { label: `Open ${s.c}`, tab: "spending", category: s.c },
      });
    }
  }

  const bill = (c: Report["recurring"][number], figure: string, cents: number) => fig(usd0(cents), x.dp(figure, c.key));
  const active = r.recurring.filter((c) => c.kind === "bill" && c.active);
  if (active.length) {
    const yearly = sum(active, (c) => c.annualCents);
    push({
      rank: 2,
      weight: yearly,
      tone: "info",
      title: [`${active.length} recurring bills and subscriptions: `, fig(usdCompact(yearly), x.dp("bills-yearly")), "/yr"],
      body: [
        fig(usd0(yearly / 12), x.dp("bills-monthly")),
        "/mo is committed before you buy anything. Largest: ",
        ...active.slice(0, 3).flatMap((c, i): Seg[] => [...(i ? [", "] : []), `${c.name} (`, bill(c, "recurring-typical", c.typicalCents), ")"]),
        ".",
      ],
      action: { label: "Review recurring", tab: "recurring" },
    });
  }
  const raised = r.recurring.filter((c) => c.kind === "bill" && c.active && c.changeCents && c.changeCents > 0);
  if (raised.length) {
    push({
      rank: 0,
      weight: sum(raised, (c) => c.changeCents!) * 12,
      tone: "warn",
      title: [`${raised.length} bill${raised.length === 1 ? "" : "s"} went up`],
      body: raised.slice(0, 3).flatMap((c, i): Seg[] => [...(i ? [" · "] : []), `${c.name} +`, bill(c, "recurring-change", c.changeCents!), " to ", bill(c, "recurring-last", c.lastCents)]),
      action: { label: "Review recurring", tab: "recurring" },
    });
  }

  const habit = r.recurring.filter((c) => c.kind === "habit" && c.active).sort((a, b) => b.last12Cents - a.last12Cents)[0];
  if (habit) {
    push({
      rank: 2,
      weight: habit.last12Cents,
      tone: "info",
      title: [`Top habit: ${habit.name}`],
      body: [`${habit.count} visits at about `, bill(habit, "recurring-typical", habit.typicalCents), " each — ", fig(usd0(habit.last12Cents), x.proof("spending", r.months, { merchantKey: habit.key, charges: true, shownCents: habit.last12Cents })), " over the last 12 months."],
      action: { label: "See habits", tab: "recurring" },
    });
  }

  const big = r.oneOffs.filter((o) => o.date >= months[0]!.start && o.date <= last.end && !o.tagged)[0];
  if (big) {
    push({
      rank: 1,
      weight: big.cents,
      tone: "info",
      title: ["Largest single expense: ", fig(usd0(big.cents), { descriptor: { report: "row", rowId: big.rowId }, shownCents: -big.cents })],
      body: [`${big.merchant} (${big.category}) on ${formatDisplayDateFromYmd(big.date)}. Mark big one-offs so your typical spending isn't skewed.`],
      action: { label: "Review one-offs", tab: "spending" },
    });
  }
  return out.sort((a, b) => a.rank - b.rank || b.weight - a.weight).slice(0, 6);
}

export type ProofOptions = CashFlowRecipe & {
  perMonth?: boolean;
  /** The total the page shows (before any per-month split); null for a figure that isn't one. */
  shownCents: number | null;
};

/**
 * The proof target for a figure summed over `months` (contiguous, as a slice is): the
 * server re-derives it from the Book and lists the rows behind it. `perMonth`: the page
 * shows the total divided by the months; `shownCents` is the total the page computed.
 * `merchantKey`: one merchant's (or, with income, one payer's) part, as mergeMerchants sums it.
 */
export function proofTarget(
  metric: CashFlowMetric,
  months: SpendingMonth[],
  accountIds: string[] | undefined,
  o: ProofOptions,
): ProofRef {
  if (!months.length) return noFigure("no months in the range");
  return {
    descriptor: cashFlowDescriptor(metric, months, accountIds, o),
    shownCents: o.shownCents,
    ...(o.perMonth && months.length > 1 ? { perMonths: months.length } : {}),
  };
}
