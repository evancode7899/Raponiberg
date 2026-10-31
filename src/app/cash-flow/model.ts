import type { SpendingKind, SpendingMonth, SpendingReport } from "@/lib/book/reports/spending";
import { CATEGORIES } from "@/lib/classifier/taxonomy";
import { savingsRate } from "@/lib/book/definitions";
import { formatPercentRatio, usd0, usdCompact } from "@/lib/formatMoney";
import type { ProofRef } from "@/components/ui/proof/context";
import type { CashFlowMetric } from "@/lib/book/proof/cashFlowProof";
import { unswept } from "@/lib/book/proof/clearance";
import { cashFlowDescriptor, median, mergeCategories, sum, type CashFlowRecipe, type Slice } from "@/lib/book/reports/cashFlowWindows";

export {
  byYear,
  mergeCategories,
  median,
  mergeMerchants,
  monthKey,
  shiftMonth,
  sliceRange,
  sliceStart,
  sum,
  trailing,
  type MerchantTotal,
  type RangeId,
  type Slice,
} from "@/lib/book/reports/cashFlowWindows";

export type Report = SpendingReport & { accounts: { id: string; name: string }[] };
/** The spending categories in the taxonomy's order; each keeps its color slot everywhere. */
export const SPEND_CATEGORIES = CATEGORIES.filter((c) => c.kind === "EXPENSE" && c.group !== "Money movement").map((c) => c.name);
/** Fixed chart slot per category (eight slots; the rest share the neutral "Other" color). */
const CATEGORY_SLOT: Record<string, number> = {
  "Housing & utilities": 0,
  Groceries: 2,
  Transportation: 3,
  "Health & insurance": 6,
  Dining: 1,
  "Shopping & gifts": 4,
  "Travel & entertainment": 5,
};
export const categorySlot = (c: string): number | null => CATEGORY_SLOT[c] ?? null;
export const categoryGroup = (c: string) => CATEGORIES.find((x) => x.name === c)?.group ?? "Other";
export const SPEND_GROUPS = ["Essentials", "Lifestyle", "Financial"] as const;


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

/** `proof`: the figure the title names, so a number in a sentence is as provable as one in a tile. */
export type Insight = { tone: "good" | "bad" | "info" | "warn"; title: string; body: string; action?: { label: string; tab?: string; category?: string }; proof?: ProofRef };

/** Builds a figure's proof target over months (CashFlowClient's ctx.proof). */
export type ProofOf = (metric: CashFlowMetric, months: SpendingMonth[], o: ProofOptions) => ProofRef;

/** Which insights lead when there are more than fit: changes and warnings before context. */
const RANK = ["Spending", "You kept", "ran high", "went up", "recurring bills", "of spending", "Bonuses", "Largest", "Top habit"];
const rank = (i: Insight) => {
  const r = RANK.findIndex((k) => i.title.includes(k));
  return r < 0 ? RANK.length : r;
};

const pct = (r: number) => formatPercentRatio(Math.abs(r), 0);

/**
 * Plain-language observations about the selected months, most useful first. Each
 * compares like with like: averages per month against the same-length run before.
 */
export function buildInsights(slice: Slice, r: Report, proof?: ProofOf): Insight[] {
  const out: Insight[] = [];
  const { months, prior } = slice;
  if (!months.length) return out;
  const t = totals(months);
  const p = prior.length ? totals(prior) : null;

  if (p && p.avgSpending > 0) {
    const ch = t.avgSpending / p.avgSpending - 1;
    const cats = mergeCategories(months, (m) => m.spendingByCategory);
    const prevCats = mergeCategories(prior, (m) => m.spendingByCategory);
    const deltas = SPEND_CATEGORIES.map((c) => ({
      c,
      d: (cats.find((x) => x.category === c)?.cents ?? 0) / t.n - (prevCats.find((x) => x.category === c)?.cents ?? 0) / p.n,
    })).sort((a, b) => (ch >= 0 ? b.d - a.d : a.d - b.d));
    const driver = deltas[0];
    if (Math.abs(ch) >= 0.05) {
      out.push({
        tone: ch > 0 ? "warn" : "good",
        title: `Spending ${ch > 0 ? "up" : "down"} ${pct(ch)} vs the previous ${p.n} months`,
        body: `${usd0(t.avgSpending)}/mo now against ${usd0(p.avgSpending)}/mo before.${
          driver && Math.abs(driver.d) >= 5000 ? ` Biggest mover: ${driver.c} (${driver.d > 0 ? "+" : "−"}${usd0(Math.abs(driver.d))}/mo).` : ""
        }`,
        action: driver ? { label: `Open ${driver.c}`, tab: "spending", category: driver.c } : undefined,
        proof: proof?.("spending", months, { perMonth: true, shownCents: t.spending }),
      });
    } else {
      out.push({ tone: "info", proof: proof?.("spending", months, { perMonth: true, shownCents: t.spending }), title: "Spending is steady", body: `${usd0(t.avgSpending)}/mo, within ${pct(ch)} of the previous ${p.n} months (${usd0(p.avgSpending)}/mo).` });
    }
  }

  if (t.savingsRate != null) {
    const months_ = months.filter((m) => m.incomeCents > 0);
    const best = [...months_].sort((a, b) => (b.savingsRate ?? -9) - (a.savingsRate ?? -9))[0];
    const deficit = months.filter((m) => m.netCents < 0).length;
    out.push({
      tone: t.savingsRate >= 0.2 ? "good" : t.savingsRate >= 0 ? "info" : "bad",
      title: `You kept ${formatPercentRatio(t.savingsRate, 0)} of income`,
      proof: proof?.("net", months, { shownCents: t.net }),
      body: `${usd0(t.net)} saved over ${t.n} month${t.n === 1 ? "" : "s"}. ${deficit ? `${deficit} month${deficit === 1 ? "" : "s"} spent more than came in` : "No month spent more than came in"}${
        best && t.n > 2 ? `; best was ${best.label} (${formatPercentRatio(best.savingsRate ?? 0, 0)})` : ""
      }.`,
    });
  }

  if (t.n >= 3 && t.typicalIncome > 0 && t.avgIncome > t.typicalIncome * 1.25) {
    out.push({
      tone: "info",
      title: "Bonuses lift the average",
      proof: proof?.("income", months, { perMonth: true, shownCents: t.income }),
      body: `A typical month brings in ${usd0(t.typicalIncome)}, but the average is ${usd0(t.avgIncome)} — the gap is irregular pay (bonuses, one-time deposits). Budget against the typical month.`,
      action: { label: "See income", tab: "income" },
    });
  }

  const cats = mergeCategories(months, (m) => m.spendingByCategory).filter((c) => c.cents > 0);
  const top = cats[0];
  if (top && t.spending > 0) {
    out.push({
      tone: "info",
      title: `${top.category} is ${pct(top.cents / t.spending)} of spending`,
      proof: proof?.("spending", months, { category: top.category, perMonth: true, shownCents: top.cents }),
      body: `${usd0(top.cents / t.n)}/mo on average${cats[1] ? `, then ${cats[1].category} (${usd0(cats[1].cents / t.n)}/mo) and ${cats[2]?.category ?? "the rest"}` : ""}.`,
      action: { label: `Open ${top.category}`, tab: "spending", category: top.category },
    });
  }

  // Latest month against the typical one, per category.
  const last = months.at(-1)!;
  if (t.n >= 3) {
    const rest = months.slice(0, -1);
    const spikes = SPEND_CATEGORIES.map((c) => ({ c, now: categoryCents(last, c), typ: median(rest.map((m) => categoryCents(m, c))) }))
      .filter((x) => x.now - x.typ >= 20000 && x.now > x.typ * 1.4)
      .sort((a, b) => b.now - b.typ - (a.now - a.typ));
    const s = spikes[0];
    if (s) {
      out.push({
        tone: "warn",
        title: `${s.c} ran high in ${last.label}`,
        proof: proof?.("spending", [last], { category: s.c, shownCents: s.now }),
        body: `${usd0(s.now)} against a typical ${usd0(s.typ)} — ${usd0(s.now - s.typ)} more than usual.`,
        action: { label: `Open ${s.c}`, tab: "spending", category: s.c },
      });
    }
  }

  const active = r.recurring.filter((c) => c.kind === "bill" && c.active);
  if (active.length) {
    const yearly = sum(active, (c) => c.annualCents);
    out.push({
      tone: "info",
      title: `${active.length} recurring bills and subscriptions: ${usdCompact(yearly)}/yr`,
      body: `${usd0(yearly / 12)}/mo is committed before you buy anything. Largest: ${active
        .slice(0, 3)
        .map((c) => `${c.name} (${usd0(c.typicalCents)})`)
        .join(", ")}.`,
      action: { label: "Review recurring", tab: "recurring" },
    });
  }
  const raised = r.recurring.filter((c) => c.kind === "bill" && c.active && c.changeCents && c.changeCents > 0);
  if (raised.length) {
    out.push({
      tone: "warn",
      title: `${raised.length} bill${raised.length === 1 ? "" : "s"} went up`,
      body: raised
        .slice(0, 3)
        .map((c) => `${c.name} +${usd0(c.changeCents!)} to ${usd0(c.lastCents)}`)
        .join(" · "),
      action: { label: "Review recurring", tab: "recurring" },
    });
  }

  const habit = r.recurring.filter((c) => c.kind === "habit" && c.active).sort((a, b) => b.last12Cents - a.last12Cents)[0];
  if (habit) {
    out.push({
      tone: "info",
      title: `Top habit: ${habit.name}`,
      body: `${habit.count} visits at about ${usd0(habit.typicalCents)} each — ${usd0(habit.last12Cents)} over the last 12 months.`,
      action: { label: "See habits", tab: "recurring" },
    });
  }

  const big = r.oneOffs.filter((o) => o.date >= months[0]!.start && o.date <= last.end && !o.tagged)[0];
  if (big) {
    out.push({
      tone: "info",
      title: `Largest single expense: ${usd0(big.cents)}`,
      body: `${big.merchant} (${big.category}) on ${big.date}. Mark big one-offs so your typical spending isn't skewed.`,
      action: { label: "Review one-offs", tab: "spending" },
    });
  }
  return out.sort((a, b) => rank(a) - rank(b)).slice(0, 6);
}

export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The three kinds of spending, in stacking order, with what each means (spending.ts spendingKindRule). */
export const KINDS = [
  { id: "billCents", kind: "bill", label: "Bills & subscriptions", hint: "rent and steady charges from recurring merchants" },
  { id: "everydayCents", kind: "everyday", label: "Everyday", hint: "day-to-day charges under $1,500, net of their refunds" },
  { id: "bigCents", kind: "big", label: "Big & one-off", hint: "single charges of $1,500+, anything marked one-off, taxes, and big merchant refunds" },
] as const satisfies readonly { id: string; kind: SpendingKind; label: string; hint: string }[];

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
  if (!months.length) return unswept("no months in the range");
  return {
    descriptor: cashFlowDescriptor(metric, months, accountIds, o),
    shownCents: o.shownCents,
    ...(o.perMonth && months.length > 1 ? { perMonths: months.length } : {}),
  };
}
