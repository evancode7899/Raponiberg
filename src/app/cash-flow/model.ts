import type { CategoryAmount } from "@/lib/book/reports/cashFlow";
import type { MerchantMonth, SpendingKind, SpendingMonth, SpendingReport } from "@/lib/book/reports/spending";
import { CATEGORIES } from "@/lib/classifier/taxonomy";
import { savingsRate } from "@/lib/book/definitions";
import { formatPercentRatio, usd0, usdCompact } from "@/lib/formatMoney";
import type { ProofTarget } from "@/components/ui/proof/context";
import type { CashFlowMetric } from "@/lib/book/proof/cashFlowProof";

export type Report = SpendingReport & { accounts: { id: string; name: string }[] };
export type RangeId = "3m" | "6m" | "12m" | "ytd" | "all" | "custom";

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

export type Slice = {
  months: SpendingMonth[];
  /** Up to as many months just before, for comparison (empty when fewer than three are proven). */
  prior: SpendingMonth[];
  label: string;
};

export function sliceRange(r: Report, range: RangeId, custom: { from: string; to: string }): Slice {
  const all = r.months;
  if (!all.length) return { months: [], prior: [], label: "" };
  let lo = 0;
  let hi = all.length - 1;
  if (range === "custom") {
    lo = Math.max(0, all.findIndex((m) => m.start >= custom.from));
    const h = all.findLastIndex((m) => m.start <= custom.to);
    hi = h < 0 ? all.length - 1 : h;
    if (lo > hi) lo = hi;
  } else if (range === "ytd") {
    const y = all[hi]!.start.slice(0, 4);
    lo = Math.max(0, all.findIndex((m) => m.start.startsWith(y)));
  } else if (range !== "all") {
    lo = Math.max(0, hi - ({ "3m": 3, "6m": 6, "12m": 12 }[range] - 1));
  }
  const months = all.slice(lo, hi + 1);
  const n = months.length;
  // Compared per month, so a shorter run before still works (at least three months).
  const prior = all.slice(Math.max(0, lo - n), lo);
  if (prior.length < Math.min(3, n)) prior.length = 0;
  return { months, prior, label: n === 1 ? months[0]!.label : `${months[0]!.label} – ${months.at(-1)!.label}` };
}

export const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
export const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

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

export function mergeCategories(months: SpendingMonth[], pick: (m: SpendingMonth) => CategoryAmount[]): CategoryAmount[] {
  const m = new Map<string, CategoryAmount>();
  for (const p of months) {
    for (const c of pick(p)) {
      const cur = m.get(c.category) ?? { ...c, cents: 0 };
      cur.cents += c.cents;
      m.set(c.category, cur);
    }
  }
  return [...m.values()].filter((c) => c.cents !== 0).sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents));
}

export const categoryCents = (m: SpendingMonth, category: string) => m.spendingByCategory.find((c) => c.category === category)?.cents ?? 0;

export type MerchantTotal = MerchantMonth & { months: number; lastMonth: string; series: number[] };

/** Merchants (or payers) summed over months, with how many months they appear in. */
export function mergeMerchants(months: SpendingMonth[], pick: (m: SpendingMonth) => MerchantMonth[] = (m) => m.merchants): MerchantTotal[] {
  const out = new Map<string, MerchantTotal>();
  months.forEach((p, i) => {
    for (const x of pick(p)) {
      const cur = out.get(x.key) ?? { ...x, cents: 0, count: 0, months: 0, lastMonth: p.label, series: months.map(() => 0) };
      cur.cents += x.cents;
      cur.count += x.count;
      cur.months++;
      cur.lastMonth = p.label;
      cur.series[i] = x.cents;
      out.set(x.key, cur);
    }
  });
  return [...out.values()].filter((x) => x.cents > 0).sort((a, b) => b.cents - a.cents);
}

/** `proof`: the figure the title names, so a number in a sentence is as provable as one in a tile. */
export type Insight = { tone: "good" | "bad" | "info" | "warn"; title: string; body: string; action?: { label: string; tab?: string; category?: string }; proof?: ProofTarget };

/** Builds a figure's proof target over months (CashFlowClient's ctx.proof). */
export type ProofOf = (metric: CashFlowMetric, months: SpendingMonth[], o: ProofOptions) => ProofTarget | undefined;

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

/** "2026-06" style month keys for selects. */
export const monthKey = (iso: string) => iso.slice(0, 7);

export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-06" moved by a number of months. */
export const shiftMonth = (ym: string, months: number) => {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + months, 1)).toISOString().slice(0, 7);
};

/**
 * The sum of `f` over the `n` months ending at each month (null until `n` are available).
 * The report's months are one unbroken run, so a window never spans a gap.
 */
export function trailing(all: SpendingMonth[], n: number, f: (m: SpendingMonth) => number): (number | null)[] {
  let run = 0;
  return all.map((m, i) => {
    run += f(m);
    if (i >= n) run -= f(all[i - n]!);
    return i >= n - 1 ? run : null;
  });
}

/** The three kinds of spending, in stacking order, with what each means (spending.ts spendingKindRule). */
export const KINDS = [
  { id: "billCents", kind: "bill", label: "Bills & subscriptions", hint: "rent and steady charges from recurring merchants" },
  { id: "everydayCents", kind: "everyday", label: "Everyday", hint: "day-to-day charges under $1,500, net of their refunds" },
  { id: "bigCents", kind: "big", label: "Big & one-off", hint: "single charges of $1,500+, anything marked one-off, taxes, and big merchant refunds" },
] as const satisfies readonly { id: string; kind: SpendingKind; label: string; hint: string }[];

/** Where a slice's months sit in the report (the slice is a contiguous run of them). */
export const sliceStart = (r: Report, s: Slice) => Math.max(0, r.months.indexOf(s.months[0]!));

export type ProofOptions = {
  category?: string;
  merchantKey?: string;
  /** With merchantKey: the merchant's charges dated in the twelve months ending with the last of `months` (Recurring's "last 12 months"). */
  charges?: boolean;
  perMonth?: boolean;
  /** Spending without the one-offs (Cash flow's "Excluding one-offs"). */
  excludeOneOffs?: boolean;
  /** One band of spending (Trends' bills / everyday / big & one-off). */
  spendingKind?: SpendingKind;
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
): ProofTarget | undefined {
  if (!months.length) return undefined;
  return {
    descriptor: {
      report: "cash-flow",
      metric,
      granularity: "month",
      start: o.charges ? `${shiftMonth(monthKey(months.at(-1)!.start), -11)}-01` : months[0]!.start,
      end: months.at(-1)!.end,
      ...(o.category ? { category: o.category } : {}),
      ...(o.merchantKey ? { merchantKey: o.merchantKey, ...(o.charges ? { merchantBasis: "charges" as const } : {}) } : {}),
      ...(accountIds?.length ? { accountIds } : {}),
      ...(o.excludeOneOffs ? { oneOffs: "exclude" as const } : {}),
      ...(o.spendingKind ? { spendingKind: o.spendingKind } : {}),
    },
    shownCents: o.shownCents,
    ...(o.perMonth && months.length > 1 ? { perMonths: months.length } : {}),
  };
}
