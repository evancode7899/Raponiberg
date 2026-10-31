import type { Granularity } from "../../dates/isoDate.ts";
import { formatUsdFromCents } from "../../formatMoney.ts";
import type { Book, BookRow } from "../load.ts";
import { rentCovers } from "../rent.ts";
import { buildCashFlowReport, cashFlowContributions, dayOfFor, type CashFlowContribution, type CashFlowPeriod, type CashFlowReport } from "../reports/cashFlow.ts";
import { detectRecurring, merchantKeyOf, merchantName, oneOffTest, spendingKindRule, spendingReportFor, spendingRows, type SpendingKind } from "../reports/spending.ts";
import { loadProfileSettings, type FinancialProfileSettings } from "../../profile/settings.ts";
import type { CheckId } from "../types.ts";
import { checksFor, estimatesFor, isIsoDate, sumCheck } from "./common.ts";
import type { Proof, ProofBlock, ProofCheck, ProofEstimate, ProofGroup, ProofKind, ProofRow } from "./types.ts";

/**
 * The proof behind a cash-flow figure: exactly which rows add up to it, grouped by the
 * statement each was read from, and every integrity check that covers it. The page sends
 * the figure's recipe (a descriptor), not the figure: the proof re-derives it from the
 * Book through the same selection step the report uses (cashFlowContributions), then
 * re-adds the listed rows on their own and says whether they come to the same number.
 */

export type CashFlowMetric = "income" | "spending" | "external" | "net";

export type CashFlowDescriptor = {
  report: "cash-flow";
  metric: CashFlowMetric;
  granularity: Granularity;
  /** First and last day of the figure's periods (inclusive). */
  start: string;
  end: string;
  /** One category's part of the figure (income, spending or external lanes). */
  category?: string;
  /** The page's account filter. */
  accountIds?: string[];
  /**
   * One merchant's part (spending) or one payer's (income), grouped the way the spending
   * report groups them (merchantKeyOf): net of refunds, each row whole in the month it
   * counts in, less charges reversed in full. The Merchants and Year-over-year tabs.
   */
  merchantKey?: string;
  /**
   * With a merchantKey: "charges" is the merchant's charges only (no refunds), picked by the
   * date the statement prints from `start` on, among rows counted through `end`, as the
   * Recurring tab's "last 12 months" sums them.
   */
  merchantBasis?: "charges";
  /** Spending without what the owner counts as one-off (Cash flow's "Excluding one-offs"): those rows are listed apart. */
  oneOffs?: "exclude";
  /**
   * One band of spending as the Trends tab splits it (spendingKindRule): bills, big &
   * one-off, or everyday. The figure is the spending report's band; the rows are the
   * period's spending rows in that band.
   */
  spendingKind?: SpendingKind;
};

export const SPENDING_KIND_LABEL: Record<SpendingKind, string> = { bill: "Bills & subscriptions", big: "Big & one-off spending", everyday: "Everyday spending" };

export type CashFlowSection = {
  /** "Income" / "Spending" / "Outside money" (net has two). */
  label: string;
  /** The figure the page shows for this part. */
  figureCents: number;
  /** The listed rows re-added: each period's rows summed and rounded once, like the report. */
  rowsCents: number;
  /** Statements, largest share first. */
  groups: ProofGroup[];
  /** The part by category, as the page shows them (each rounded per period). */
  byCategory: { category: string; cents: number }[];
  /** figureCents − Σ byCategory: rounding per category vs per total, cents at most. */
  categoryRoundingCents: number;
  /** What the rows leave out or where they stop (a merchant's reversed pairs). */
  note?: string;
};

export type CashFlowProof = {
  descriptor: CashFlowDescriptor;
  describes: string;
  figureCents: number;
  rowsCents: number;
  selfCheck: { ok: boolean; deltaCents: number };
  sections: CashFlowSection[];
  /** The figure's periods, with each one's part (unrounded rows rounded once). */
  periods: { label: string; start: string; end: string; through: string | null; cents: number }[];
  /** Open findings over the figure: when any, the page withholds it. */
  withheld: boolean;
  checks: ProofCheck[];
  estimates: ProofEstimate[];
  /** Cash flow runs through this day (the period holding it may be cut short). */
  through: string;
  today: string;
};

/** The checks that can withhold a cash-flow figure, in the order the drawer lists them. */
export const CASH_FLOW_CHECKS: CheckId[] = [
  "statement.held",
  "statement.chain",
  "statement.gap",
  "statement.history",
  "statement.overdue",
  "transfer.unmatched",
  "transfer.decisions",
  "ledger.consistency",
  "ledger.freshness",
  "networth.reconciles",
];

/** A cash-flow descriptor from a request body, or why it's not one. */
export function parseCashFlowDescriptor(d: Record<string, unknown>): CashFlowDescriptor | { error: string } {
  if (!["income", "spending", "external", "net"].includes(d.metric as string)) return { error: "metric must be income, spending, external or net." };
  if (!["month", "quarter", "year"].includes(d.granularity as string)) return { error: "granularity must be month, quarter or year." };
  if (!isIsoDate(d.start) || !isIsoDate(d.end)) return { error: "start and end must be YYYY-MM-DD." };
  if (d.start > d.end) return { error: "start is after end." };
  if (d.category != null && (typeof d.category !== "string" || !d.category)) return { error: "category must be a name." };
  if (d.category != null && d.metric === "net") return { error: "net has no category." };
  if (d.accountIds != null && (!Array.isArray(d.accountIds) || d.accountIds.some((x) => typeof x !== "string"))) return { error: "accountIds must be a list of ids." };
  if (d.merchantKey != null && (typeof d.merchantKey !== "string" || !d.merchantKey)) return { error: "merchantKey must be a merchant's key." };
  if (d.merchantKey != null && d.metric !== "spending" && d.metric !== "income") return { error: "merchantKey goes with spending (a merchant) or income (a payer)." };
  if (d.merchantKey != null && d.category != null) return { error: "Give a category or a merchantKey, not both." };
  if (d.merchantBasis != null && (d.merchantBasis !== "charges" || !d.merchantKey || d.metric !== "spending")) return { error: "merchantBasis can only be charges, with a merchantKey and spending." };
  if (d.oneOffs != null && (d.oneOffs !== "exclude" || d.metric !== "spending" || d.merchantKey != null)) return { error: "oneOffs can only be exclude, with spending (not a merchant)." };
  if (d.spendingKind != null && (!["bill", "big", "everyday"].includes(d.spendingKind as string) || d.metric !== "spending" || d.merchantKey != null || d.category != null || d.oneOffs != null))
    return { error: "spendingKind is bill, big or everyday, with spending only (no category, merchant or oneOffs)." };
  return {
    report: "cash-flow",
    metric: d.metric as CashFlowMetric,
    granularity: d.granularity as Granularity,
    start: d.start,
    end: d.end,
    ...(d.category ? { category: d.category as string } : {}),
    ...((d.accountIds as string[] | undefined)?.length ? { accountIds: d.accountIds as string[] } : {}),
    ...(d.merchantKey ? { merchantKey: d.merchantKey as string } : {}),
    ...(d.merchantBasis ? { merchantBasis: "charges" as const } : {}),
    ...(d.oneOffs ? { oneOffs: "exclude" as const } : {}),
    ...(d.spendingKind ? { spendingKind: d.spendingKind as SpendingKind } : {}),
  };
}

/** A row's part in one period: as the statement prints it, times its share. */
type Picked = { row: BookRow; periodIndex: number; share: number; cents: number };

type Part = { lane: "INCOME" | "EXPENSE" | "EXTERNAL_TRANSFER"; label: string; sign: 1 | -1; pick: (p: CashFlowPeriod) => number; cats: (p: CashFlowPeriod) => { category: string; cents: number }[] };

const PARTS: Record<"income" | "spending" | "external", Part> = {
  income: { lane: "INCOME", label: "Income", sign: 1, pick: (p) => p.incomeCents, cats: (p) => p.incomeByCategory },
  spending: { lane: "EXPENSE", label: "Spending", sign: -1, pick: (p) => p.spendingCents, cats: (p) => p.spendingByCategory },
  external: { lane: "EXTERNAL_TRANSFER", label: "Outside money", sign: 1, pick: (p) => p.externalByCategory.reduce((t, c) => t + c.cents, 0), cats: (p) => p.externalByCategory },
};

type View = { report: CashFlowReport; contributions?: readonly CashFlowContribution[] };
const views = new WeakMap<Book, Map<string, View>>();

/**
 * The report and its rows over a figure's periods, worked out once per Book: every figure
 * of a month (each category, income, spending, net) and every row linking to it share
 * them, and each is a pass over the whole ledger. Read-only (frozen): proofs only pick from them.
 */
function viewFor(book: Book, d: CashFlowDescriptor, withRows: boolean): { report: CashFlowReport; contributions: readonly CashFlowContribution[] } {
  let byKey = views.get(book);
  if (!byKey) views.set(book, (byKey = new Map()));
  const key = [d.granularity, d.start, d.end, ...(d.accountIds ?? [])].join("|");
  let v = byKey.get(key);
  if (!v) byKey.set(key, (v = { report: buildCashFlowReport(book, { granularity: d.granularity, from: d.start, to: d.end, accountIds: d.accountIds }) }));
  if (withRows && !v.contributions) v.contributions = Object.freeze(cashFlowContributions(book, v.report.periods, d.accountIds?.length ? new Set(d.accountIds) : null));
  return { report: v.report, contributions: (withRows && v.contributions) || [] };
}

/** The spending rows by lane and merchant, in row order, once per row list: a merchant's proof reads only its own. */
const merchantIndexes = new WeakMap<readonly BookRow[], Map<string, BookRow[]>>();
function byMerchant(rows: readonly BookRow[]): Map<string, BookRow[]> {
  let m = merchantIndexes.get(rows);
  if (!m) {
    m = new Map();
    for (const r of rows) {
      const k = `${r.lane}|${merchantKeyOf(r)}`;
      const list = m.get(k);
      if (list) list.push(r);
      else m.set(k, [r]);
    }
    merchantIndexes.set(rows, m);
  }
  return m;
}

/** The recurring charges through `end` (last twelve months from `start`), once per spending rows and dates. */
const recurringMemo = new WeakMap<object, Map<string, ReturnType<typeof detectRecurring>>>();
function recurringThrough(s: object, end: string, start: string, rows: BookRow[]): ReturnType<typeof detectRecurring> {
  let m = recurringMemo.get(s);
  if (!m) recurringMemo.set(s, (m = new Map()));
  let r = m.get(`${end}|${start}`);
  if (!r) m.set(`${end}|${start}`, (r = detectRecurring(rows, end, start)));
  return r;
}

/** What every cash-flow proof on a Book looks rows up in, worked out once per Book: rent detection reads every row. */
const lookupMemo = new WeakMap<Book, { accountName: Map<string, string>; statementById: Map<string, Book["statements"][number]>; rent: ReturnType<typeof rentCovers>; dayOf: (r: BookRow) => string }>();
function lookups(book: Book) {
  let l = lookupMemo.get(book);
  if (!l)
    lookupMemo.set(
      book,
      (l = {
        accountName: new Map(book.accounts.map((a) => [a.id, a.name])),
        statementById: new Map(book.statements.map((s) => [s.id, s])),
        rent: rentCovers(book.rows, book.accounts, book.household.merchantRules),
        dayOf: dayOfFor(book),
      }),
    );
  return l;
}

export function buildCashFlowProof(
  book: Book,
  d: CashFlowDescriptor,
  isOneOff: (r: BookRow) => boolean = () => false,
  /** Needed for a spendingKind figure (which charges are one-off candidates). */
  settings: Pick<FinancialProfileSettings, "oneOffs" | "nonRecurringCategories"> = { oneOffs: {}, nonRecurringCategories: [] },
): CashFlowProof {
  const dropOneOffs = d.oneOffs === "exclude";
  const { report, contributions } = viewFor(book, d, !d.merchantKey);
  const periods = report.periods;
  const { accountName, statementById, rent, dayOf } = lookups(book);

  // A band of spending: the spending report's own figure per month, and its rule for which rows are in it.
  const band = d.spendingKind ? kindView(book, d, settings, periods) : null;

  // A merchant's figure reads the spending report's own rows (reversed pairs left out,
  // each row whole on the day it counts), through the same grouping step the page sums.
  const spend = d.merchantKey ? spendingRows(book, d.accountIds) : null;
  const merchantNotes: string[] = [];
  /** A merchant figure's part in each period, as the page sums it month by month. */
  let merchantPeriods: number[] = [];
  const merchantPart = (part: Part): { mine: Picked[]; figureCents: number } => {
    const s = spend!;
    const lane = part.lane as "EXPENSE" | "INCOME";
    const isMine = (r: BookRow) => r.lane === lane && merchantKeyOf(r) === d.merchantKey;
    const at = (iso: string) => periods.findIndex((p) => p.start <= iso && iso <= p.end);
    let mine: Picked[];
    let figureCents: number;
    if (d.merchantBasis === "charges") {
      // The recurring charge's own sum (detectRecurring), over the rows counted through `end`.
      const rows = s.windowRows.filter((r) => s.dayOf(r) <= d.end);
      figureCents = recurringThrough(s, d.end, d.start, rows).find((c) => c.key === d.merchantKey)?.last12Cents ?? 0;
      mine = rows.filter((r) => isMine(r) && r.amountCents < 0 && r.date >= d.start).map((row) => ({ row, periodIndex: Math.max(0, at(s.dayOf(row))), share: 1, cents: row.amountCents }));
      if (!figureCents && mine.length) merchantNotes.push("This merchant isn't a recurring charge through this date, so the Recurring tab shows no figure for it.");
    } else {
      // The merchant's own rows, each in its period: what merchantsIn groups for this one merchant (a net of zero is no figure, so zero either way).
      mine = (byMerchant(s.inScope).get(`${lane}|${d.merchantKey}`) ?? []).flatMap((row) => {
        const i = at(s.dayOf(row));
        return i < 0 ? [] : [{ row, periodIndex: i, share: 1, cents: row.amountCents }];
      });
      merchantPeriods = periods.map(() => 0);
      for (const x of mine) merchantPeriods[x.periodIndex]! += lane === "EXPENSE" ? -x.row.amountCents : x.row.amountCents;
      figureCents = merchantPeriods.reduce((t, v) => t + v, 0);
    }
    const from = periods[0]?.start ?? d.start;
    const to = periods.at(-1)?.end ?? d.end;
    const reversed = s.reversed.filter((r) => isMine(r) && s.dayOf(r) >= (d.merchantBasis === "charges" ? s.from ?? from : from) && s.dayOf(r) <= to);
    if (reversed.length)
      merchantNotes.push(
        `${reversed.length} row${reversed.length === 1 ? "" : "s"} left out: ${reversed.length === 2 ? "a charge and its exact refund" : "charges and their exact refunds"} on the same account within a week cancel, so the merchant views show neither (${reversed.map((r) => `${r.date} ${formatUsdFromCents(r.amountCents)}`).join(", ")}).`,
      );
    if (s.from && s.to && (from < s.from || to > s.to)) merchantNotes.push(`Merchant figures cover the proven months the Merchants tab shows (${s.from} – ${s.to}); rows outside them aren't counted.`);
    return { mine, figureCents };
  };

  const section = (part: Part): CashFlowSection => {
    const m = d.merchantKey ? merchantPart(part) : null;
    const mine =
      m?.mine ??
      contributions.filter((c) => c.row.lane === part.lane && (!d.category || c.row.category === d.category) && !(dropOneOffs && isOneOff(c.row)) && (!band || band.kindOf(c.row) === d.spendingKind));
    // Excluding one-offs: the report's figure less each one-off row, whole, as the spending report counts them.
    const oneOffCents = dropOneOffs ? contributions.filter((c) => c.row.lane === "EXPENSE" && isOneOff(c.row) && (!d.category || c.row.category === d.category)).reduce((t, c) => t - c.cents, 0) : 0;
    const figureCents =
      m?.figureCents ??
      band?.perPeriod.reduce((t, v) => t + v, 0) ??
      periods.reduce((t, p) => t + (d.category ? (part.cats(p).find((c) => c.category === d.category)?.cents ?? 0) : part.pick(p)), 0) - Math.round(oneOffCents);
    // Re-added from the rows alone: each period's rows summed, then rounded once (as the report does).
    const perPeriod = periods.map(() => 0);
    for (const c of mine) perPeriod[c.periodIndex]! += part.sign * c.cents;
    const rowsCents = perPeriod.reduce((t, v) => t + Math.round(v), 0);

    // One line per row, its periods' shares combined.
    const rows = new Map<string, { row: BookRow; share: number; cents: number }>();
    for (const c of mine) {
      const cur = rows.get(c.row.id) ?? { row: c.row, share: 0, cents: 0 };
      cur.share += c.share;
      cur.cents += part.sign * c.cents;
      rows.set(c.row.id, cur);
    }
    const groups = new Map<string, ProofGroup>();
    for (const { row: r, share, cents } of rows.values()) {
      let g = groups.get(r.statementImportId);
      if (!g) {
        const s = statementById.get(r.statementImportId);
        g = {
          statement: {
            id: r.statementImportId,
            account: accountName.get(r.accountId) ?? "Account",
            institution: book.accounts.find((a) => a.id === r.accountId)?.institution ?? null,
            periodStart: s?.periodStart ?? r.statement.start,
            periodEnd: s?.periodEnd ?? r.statement.end,
            documentTitle: s?.documentTitle ?? "",
            status: s?.status ?? "COMMITTED",
          },
          subtotalCents: 0,
          rows: [],
        };
        groups.set(r.statementImportId, g);
      }
      g.subtotalCents += cents;
      const counted = r.precision === "EXACT" ? dayOf(r) : r.bookedOn;
      const row: ProofRow = {
        id: r.id,
        date: r.date,
        bookedOn: r.bookedOn,
        ...(counted !== r.bookedOn ? { movedTo: { date: counted, why: rent.has(r.id) ? ("rent" as const) : ("bill" as const) } } : {}),
        payee: r.payee,
        category: r.category,
        account: accountName.get(r.accountId) ?? "Account",
        amountCents: r.amountCents,
        countedCents: cents,
        share,
        precision: r.precision,
        ...(r.partOf ? { piece: true } : {}),
      };
      g.rows.push(row);
    }
    const byCat = new Map<string, number>();
    // The report's category amounts are already in the figure's sign (spending positive).
    if (band) for (const c of mine) byCat.set(c.row.category, (byCat.get(c.row.category) ?? 0) + part.sign * c.cents);
    else if (!d.merchantKey) for (const p of periods) for (const c of part.cats(p)) if (!d.category || c.category === d.category) byCat.set(c.category, (byCat.get(c.category) ?? 0) + c.cents);
    for (const [k, v] of byCat) byCat.set(k, Math.round(v));
    const byCategory = [...byCat].map(([category, cents]) => ({ category, cents })).filter((c) => c.cents !== 0).sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents));
    return {
      label: part.label,
      figureCents,
      rowsCents,
      ...(merchantNotes.length || band?.note ? { note: [...merchantNotes, band?.note].filter(Boolean).join(" ") } : {}),
      groups: [...groups.values()]
        .map((g) => ({ ...g, subtotalCents: Math.round(g.subtotalCents), rows: g.rows.sort((a, b) => (a.bookedOn < b.bookedOn ? -1 : a.bookedOn > b.bookedOn ? 1 : 0)) }))
        .sort((a, b) => Math.abs(b.subtotalCents) - Math.abs(a.subtotalCents)),
      byCategory,
      categoryRoundingCents: figureCents - byCategory.reduce((t, c) => t + c.cents, 0),
    };
  };

  const sections = d.metric === "net" ? [section(PARTS.income), section(PARTS.spending)] : [section(PARTS[d.metric])];
  const combine = (f: (s: CashFlowSection) => number) => (d.metric === "net" ? f(sections[0]!) - f(sections[1]!) : f(sections[0]!));
  const figureCents = combine((s) => s.figureCents);
  const rowsCents = combine((s) => s.rowsCents);

  const from = periods[0]?.start ?? d.start;
  const to = periods.at(-1)?.end ?? d.end;
  const { checks, withheld } = checksFor(book, { affects: "CASH_FLOW", from, to, accountIds: d.accountIds }, CASH_FLOW_CHECKS);
  const listed = new Set(sections.flatMap((s) => s.groups.flatMap((g) => g.rows.map((r) => r.id))));
  const estimates = estimatesFor(book, { rowIds: listed, from, to, accountIds: d.accountIds });

  const periodCents = (p: CashFlowPeriod) => {
    const one = (part: Part) => (d.category ? (part.cats(p).find((c) => c.category === d.category)?.cents ?? 0) : part.pick(p));
    return d.metric === "net" ? one(PARTS.income) - one(PARTS.spending) : one(PARTS[d.metric]);
  };

  return {
    descriptor: d,
    describes: describe(d, book, periods),
    figureCents,
    rowsCents,
    selfCheck: { ok: figureCents === rowsCents, deltaCents: rowsCents - figureCents },
    sections,
    // A charges sum picks rows by statement date, not by month: it has no split by period.
    periods:
      d.merchantBasis === "charges"
        ? []
        : periods.map((p, i) => ({ label: p.label, start: p.start, end: p.end, through: p.through, cents: d.merchantKey ? merchantPeriods[i]! : band ? band.perPeriod[i]! : periodCents(p) })),
    withheld,
    checks,
    estimates,
    through: book.horizon.cashFlow,
    today: book.today,
  };
}

/**
 * The cash-flow proof as drawer blocks: the figure by period and by category, each part
 * linking to its own proof, then each section's rows by statement.
 */
export function cashFlowToProof(p: CashFlowProof): Proof {
  const d = p.descriptor;
  const rowCount = p.sections.reduce((t, s) => t + s.groups.reduce((u, g) => u + g.rows.length, 0), 0);
  const blocks: ProofBlock[] = [];
  if (p.periods.length > 1)
    blocks.push({
      kind: "breakdown",
      title: `By ${d.granularity}`,
      items: p.periods.map((x) => ({
        label: x.label,
        sub: x.through ? `to ${x.through}` : undefined,
        value: { cents: x.cents },
        link: { label: x.label, descriptor: { ...d, start: x.start, end: x.end } },
      })),
    });
  for (const s of p.sections) {
    const net = p.sections.length > 1;
    if (!d.category && !d.merchantKey && s.byCategory.length > 1)
      blocks.push({
        kind: "breakdown",
        title: `By category${net ? ` · ${s.label}` : ""}`,
        items: s.byCategory.map((c) => ({
          label: c.category,
          value: { cents: c.cents },
          // A band has no figure per category: its categories are listed, not linked.
          link: d.spendingKind ? undefined : { label: c.category, descriptor: { ...d, metric: net ? (s.label === "Income" ? "income" : "spending") : d.metric, category: c.category } },
        })),
        note:
          s.categoryRoundingCents !== 0
            ? `The categories add up to ${formatUsdFromCents(s.figureCents - s.categoryRoundingCents)}: each is rounded to the cent on its own, so they can differ from the total by ${formatUsdFromCents(Math.abs(s.categoryRoundingCents))}.`
            : undefined,
      });
    blocks.push({ kind: "rows", title: `How it adds up${net ? ` · ${s.label}` : ""}`, figureCents: s.figureCents, groups: s.groups, ...(s.note ? { note: s.note } : {}) });
  }
  // A calendar year's saved from take-home is where the Annual statement's saved incl. retirement starts (profile/savedBridge.ts).
  const whole = p.periods.length === 1 && d.granularity === "year" && d.start.endsWith("-01-01") && !d.category && !d.merchantKey && !d.accountIds?.length && !d.oneOffs;
  if (d.metric === "net" && whole) {
    const year = Number(d.start.slice(0, 4));
    blocks.push({
      kind: "facts",
      title: "On the Annual statement",
      items: [
        {
          label: "Saved incl. retirement",
          text: "Starts from this figure, then adds 401(k) and HSA deferrals, employer money, brokerage dividends and pay that never reached a tracked account.",
          link: { label: `Saved incl. retirement, ${year}`, descriptor: { report: "annual", figure: "cash", year, line: "saved" } },
        },
      ],
    });
  }
  return {
    report: "cash-flow",
    descriptor: d,
    describes: p.describes,
    figure: { cents: p.figureCents },
    selfCheck: sumCheck(
      p.figureCents,
      p.rowsCents,
      `The ${rowCount} row${rowCount === 1 ? "" : "s"} below add up to ${formatUsdFromCents(p.rowsCents)}${p.sections.length > 1 ? " (income less spending)" : ""}`,
    ),
    withheld: p.withheld,
    blocks,
    checks: p.checks,
    estimates: p.estimates,
    through: p.through,
    today: p.today,
  };
}

export const cashFlowKind: ProofKind<CashFlowDescriptor> = {
  report: "cash-flow",
  parse: parseCashFlowDescriptor,
  build: async ({ book, db }, d) => {
    const settings = d.oneOffs || d.spendingKind ? await loadProfileSettings(db) : undefined;
    return cashFlowToProof(buildCashFlowProof(book, d, settings && d.oneOffs ? oneOffTest(settings, book.rowById) : undefined, settings));
  },
};

/**
 * A band's figure per period, read from the spending report (as the page shows it), and
 * the rule that says which rows are in it. Everyday is what's left of each month's
 * spending after bills and big charges, so a row the report sets apart (a charge and its
 * exact refund) can make the rows differ from it: the note says so.
 */
function kindView(book: Book, d: CashFlowDescriptor, settings: Pick<FinancialProfileSettings, "oneOffs" | "nonRecurringCategories">, periods: CashFlowPeriod[]) {
  const report = spendingReportFor(book, settings, { accountIds: d.accountIds });
  const rule = spendingKindRule(book, settings, report.recurring);
  // A charge and its exact credit (reversals) stay out of the bills and big bands, so their
  // figures never hold them; everyday is the rest of the month's spending, so it does.
  const reversed = new Set(spendingRows(book, d.accountIds).reversed.map((r) => r.id));
  const kindOf = (r: BookRow): SpendingKind => (reversed.has(r.id) ? "everyday" : rule(r));
  const months = [...report.months, ...(report.current ? [report.current] : [])];
  const key = ({ bill: "billCents", big: "bigCents", everyday: "everydayCents" } as const)[d.spendingKind!];
  const perPeriod = periods.map((p) => months.filter((m) => m.start >= p.start && m.end <= p.end).reduce((t, m) => t + m.kinds[key], 0));
  const outside = periods.some((p) => !months.some((m) => m.start >= p.start && m.end <= p.end));
  const note = [
    d.spendingKind === "everyday" ? "Everyday is each month's spending less its bills and big charges, so it takes in anything the other two bands don't." : "",
    "A refund or reimbursement counts in the band of what it pays back; tax payments are never everyday, and tax refunds are income, never a credit to spending.",
    outside ? "Some of these months are outside the proven months Cash flow shows, so the page has no band figure for them." : "",
  ]
    .filter(Boolean)
    .join(" ");
  return { kindOf, perPeriod, note };
}

function describe(d: CashFlowDescriptor, book: Book, periods: CashFlowPeriod[]): string {
  const what = { income: "Income", spending: "Spending", external: "Outside money", net: "Income minus spending" }[d.metric];
  const accounts = d.accountIds?.length
    ? `, ${d.accountIds.map((id) => book.accounts.find((a) => a.id === id)?.name ?? "an account").join(", ")} only`
    : "";
  if (d.merchantKey && d.merchantBasis === "charges") return `Charges at ${merchantName(d.merchantKey)} dated ${d.start} or later, counted through ${d.end}${accounts}`;
  const span = periods.length === 0 ? `${d.start} – ${d.end}` : periods.length === 1 ? periods[0]!.label : `${periods[0]!.label} – ${periods.at(-1)!.label}`;
  const cut = periods.at(-1)?.through ? ` (through ${periods.at(-1)!.through})` : "";
  const who = d.merchantKey ? ` ${d.metric === "income" ? "from" : "at"} ${merchantName(d.merchantKey)}` : "";
  return `${d.spendingKind ? SPENDING_KIND_LABEL[d.spendingKind] : what}${who}${d.category ? ` · ${d.category}` : ""}${d.oneOffs ? " excluding one-offs" : ""}, ${span}${cut}${accounts}`;
}
