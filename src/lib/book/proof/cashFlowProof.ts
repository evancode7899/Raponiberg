import type { Granularity } from "../../dates/isoDate.ts";
import { acceptedFor, blockersFor, passesFor, type BlockerQuery } from "../blockers.ts";
import type { Book, BookRow } from "../load.ts";
import { countsOn, rentPayments } from "../rent.ts";
import { buildCashFlowReport, cashFlowContributions, type CashFlowPeriod } from "../reports/cashFlow.ts";
import { CHECKS, type AcceptedFinding, type CheckId, type Finding } from "../types.ts";

/**
 * The proof behind a cash-flow figure: exactly which rows add up to it, grouped by the
 * statement each was read from, and every integrity check that covers it. The page sends
 * the figure's recipe (a descriptor), not the figure: the proof re-derives it from the
 * Book through the same selection step the report uses (cashFlowContributions), then
 * re-adds the listed rows on their own and says whether they come to the same number.
 */

export type CashFlowMetric = "income" | "spending" | "external" | "net";

export type ProofDescriptor = {
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
};

export type ProofRow = {
  id: string;
  /** The date the statement prints. */
  date: string;
  /** Where the ledger books it (date clamped into its statement). */
  bookedOn: string;
  /** Where the figure counts it, when that differs from bookedOn: rent in the month it pays for, a bill charge on its own day. */
  movedTo?: { date: string; why: "rent" | "bill" };
  payee: string;
  category: string;
  account: string;
  /** As the statement prints it (signed). */
  amountCents: number;
  /** The part of it that counts in this figure, in the figure's sign (spending positive). Unrounded. */
  countedCents: number;
  /** 1 for an exact row; the fraction of a period total that falls in the figure's periods. */
  share: number;
  precision: "EXACT" | "PERIOD";
  /** A further piece of a bill payment split across bank payments (the row it's part of was printed as one line). */
  piece?: boolean;
};

export type ProofStatement = {
  id: string;
  account: string;
  institution: string | null;
  periodStart: string;
  periodEnd: string;
  documentTitle: string;
  status: string;
};

export type ProofGroup = { statement: ProofStatement; subtotalCents: number; rows: ProofRow[] };

export type ProofSection = {
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
};

export type ProofCheck = {
  id: CheckId;
  title: string;
  description: string;
  state: "passed" | "open" | "accepted" | "none";
  passed: number;
  /** What it passed on (capped; `passed` is the full count). */
  subjects: string[];
  open: Pick<Finding, "id" | "status" | "title" | "detail" | "fix">[];
  accepted: Pick<AcceptedFinding, "id" | "status" | "title" | "detail" | "note" | "acceptedAt">[];
};

export type ProofEstimate = { id: string; title: string; detail: string };

export type CashFlowProof = {
  descriptor: ProofDescriptor;
  /** Plain words: what the figure is. */
  describes: string;
  figureCents: number;
  rowsCents: number;
  selfCheck: { ok: boolean; deltaCents: number };
  sections: ProofSection[];
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

/** The checks that can withhold a cash-flow figure, in the order the panel lists them. */
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

const SUBJECT_CAP = 200;
const isIso = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** A descriptor from the request body, or why it's not one. */
export function parseDescriptor(body: unknown): ProofDescriptor | { error: string } {
  if (!body || typeof body !== "object") return { error: "Expected a JSON object." };
  const d = body as Record<string, unknown>;
  if (d.report !== "cash-flow") return { error: 'report must be "cash-flow".' };
  if (!["income", "spending", "external", "net"].includes(d.metric as string)) return { error: "metric must be income, spending, external or net." };
  if (!["month", "quarter", "year"].includes(d.granularity as string)) return { error: "granularity must be month, quarter or year." };
  if (!isIso(d.start) || !isIso(d.end)) return { error: "start and end must be YYYY-MM-DD." };
  if ((d.start as string) > (d.end as string)) return { error: "start is after end." };
  if (d.category != null && (typeof d.category !== "string" || !d.category)) return { error: "category must be a name." };
  if (d.category != null && d.metric === "net") return { error: "net has no category." };
  if (d.accountIds != null && (!Array.isArray(d.accountIds) || d.accountIds.some((x) => typeof x !== "string"))) return { error: "accountIds must be a list of ids." };
  return {
    report: "cash-flow",
    metric: d.metric as CashFlowMetric,
    granularity: d.granularity as Granularity,
    start: d.start as string,
    end: d.end as string,
    ...(d.category ? { category: d.category as string } : {}),
    ...((d.accountIds as string[] | undefined)?.length ? { accountIds: d.accountIds as string[] } : {}),
  };
}

/** Whether rows re-added per period come to the figure. Exported so the comparison itself is tested. */
export function selfCheck(figureCents: number, rowsCents: number) {
  return { ok: figureCents === rowsCents, deltaCents: rowsCents - figureCents };
}

type Part = { lane: "INCOME" | "EXPENSE" | "EXTERNAL_TRANSFER"; label: string; sign: 1 | -1; pick: (p: CashFlowPeriod) => number; cats: (p: CashFlowPeriod) => { category: string; cents: number }[] };

const PARTS: Record<"income" | "spending" | "external", Part> = {
  income: { lane: "INCOME", label: "Income", sign: 1, pick: (p) => p.incomeCents, cats: (p) => p.incomeByCategory },
  spending: { lane: "EXPENSE", label: "Spending", sign: -1, pick: (p) => p.spendingCents, cats: (p) => p.spendingByCategory },
  external: { lane: "EXTERNAL_TRANSFER", label: "Outside money", sign: 1, pick: (p) => p.externalByCategory.reduce((t, c) => t + c.cents, 0), cats: (p) => p.externalByCategory },
};

export function buildCashFlowProof(book: Book, d: ProofDescriptor): CashFlowProof {
  const report = buildCashFlowReport(book, { granularity: d.granularity, from: d.start, to: d.end, accountIds: d.accountIds });
  const periods = report.periods;
  const accountFilter = d.accountIds?.length ? new Set(d.accountIds) : null;
  const contributions = cashFlowContributions(book, periods, accountFilter);
  const accountName = new Map(book.accounts.map((a) => [a.id, a.name]));
  const statementById = new Map(book.statements.map((s) => [s.id, s]));
  const rent = new Set(rentPayments(book.rows, book.accounts, book.household.merchantRules).map((p) => p.rowId));
  const dayOf = countsOn(book.rows, book.accounts, book.household.merchantRules);

  const section = (part: Part): ProofSection => {
    const mine = contributions.filter((c) => c.row.lane === part.lane && (!d.category || c.row.category === d.category));
    const figureCents = periods.reduce(
      (t, p) => t + (d.category ? (part.cats(p).find((c) => c.category === d.category)?.cents ?? 0) : part.pick(p)),
      0,
    );
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
      g.rows.push({
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
      });
    }
    const byCat = new Map<string, number>();
    // The report's category amounts are already in the figure's sign (spending positive).
    for (const p of periods) for (const c of part.cats(p)) if (!d.category || c.category === d.category) byCat.set(c.category, (byCat.get(c.category) ?? 0) + c.cents);
    const byCategory = [...byCat].map(([category, cents]) => ({ category, cents })).filter((c) => c.cents !== 0).sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents));
    return {
      label: part.label,
      figureCents,
      rowsCents,
      groups: [...groups.values()]
        .map((g) => ({ ...g, subtotalCents: Math.round(g.subtotalCents), rows: g.rows.sort((a, b) => (a.bookedOn < b.bookedOn ? -1 : a.bookedOn > b.bookedOn ? 1 : 0)) }))
        .sort((a, b) => Math.abs(b.subtotalCents) - Math.abs(a.subtotalCents)),
      byCategory,
      categoryRoundingCents: figureCents - byCategory.reduce((t, c) => t + c.cents, 0),
    };
  };

  const sections = d.metric === "net" ? [section(PARTS.income), section(PARTS.spending)] : [section(PARTS[d.metric])];
  const combine = (f: (s: ProofSection) => number) => (d.metric === "net" ? f(sections[0]!) - f(sections[1]!) : f(sections[0]!));
  const figureCents = combine((s) => s.figureCents);
  const rowsCents = combine((s) => s.rowsCents);

  const from = periods[0]?.start ?? d.start;
  const to = periods.at(-1)?.end ?? d.end;
  const q: BlockerQuery = { affects: "CASH_FLOW", from, to, accountIds: d.accountIds };
  const open = blockersFor(book, q);
  const accepted = acceptedFor(book, q);
  const passes = passesFor(book, q);
  const checks: ProofCheck[] = CASH_FLOW_CHECKS.map((id) => {
    const def = CHECKS.find((c) => c.id === id)!;
    const mine = passes.filter((p) => p.check === id);
    const o = open.filter((f) => f.check === id);
    const a = accepted.filter((f) => f.check === id);
    const passed = mine.reduce((t, p) => t + p.n, 0);
    return {
      id,
      title: def.title,
      description: def.description,
      state: o.length ? "open" : a.length ? "accepted" : passed ? "passed" : "none",
      passed,
      subjects: mine.slice(0, SUBJECT_CAP).map((p) => p.subject),
      open: o.map((f) => ({ id: f.id, status: f.status, title: f.title, detail: f.detail, fix: f.fix })),
      accepted: a.map((f) => ({ id: f.id, status: f.status, title: f.title, detail: f.detail, note: f.note, acceptedAt: f.acceptedAt })),
    };
  });

  // What stands on an inference rather than a printed line: idle card cycles counted as
  // $0, provably empty gaps, inferred rows; spread period totals show as shares in the rows.
  const listed = new Set(sections.flatMap((s) => s.groups.flatMap((g) => g.rows.map((r) => r.id))));
  const inScope = (accountId: string) => !accountFilter || accountFilter.has(accountId);
  const estimates: ProofEstimate[] = [
    ...book.integrity.inferences
      .filter((i) => i.rowIds?.some((id) => listed.has(id)))
      .map((i) => ({ id: i.id, title: i.title, detail: i.detail })),
    ...book.idle.proven
      .filter((w) => inScope(w.accountId) && w.from <= to && w.to >= from)
      .map((w) => ({
        id: `idle:${w.accountId}:${w.from}`,
        title: `${accountName.get(w.accountId) ?? "A card"}: no statement ${w.from} – ${w.to}, counted as $0`,
        detail: "The issuer sends no statement for a cycle without activity; the paying bank's statements prove nothing happened.",
      })),
  ];

  const parts = (cents: (p: CashFlowPeriod) => number) => periods.map((p) => ({ label: p.label, start: p.start, end: p.end, through: p.through, cents: cents(p) }));
  const periodCents = (p: CashFlowPeriod) => {
    const one = (part: Part) => (d.category ? (part.cats(p).find((c) => c.category === d.category)?.cents ?? 0) : part.pick(p));
    return d.metric === "net" ? one(PARTS.income) - one(PARTS.spending) : one(PARTS[d.metric]);
  };

  return {
    descriptor: d,
    describes: describe(d, book, periods),
    figureCents,
    rowsCents,
    selfCheck: selfCheck(figureCents, rowsCents),
    sections,
    periods: parts(periodCents),
    withheld: open.length > 0,
    checks,
    estimates,
    through: book.horizon.cashFlow,
    today: book.today,
  };
}

function describe(d: ProofDescriptor, book: Book, periods: CashFlowPeriod[]): string {
  const what = { income: "Income", spending: "Spending", external: "Outside money", net: "Income minus spending" }[d.metric];
  const span = periods.length === 0 ? `${d.start} – ${d.end}` : periods.length === 1 ? periods[0]!.label : `${periods[0]!.label} – ${periods.at(-1)!.label}`;
  const cut = periods.at(-1)?.through ? ` (through ${periods.at(-1)!.through})` : "";
  const accounts = d.accountIds?.length
    ? `, ${d.accountIds.map((id) => book.accounts.find((a) => a.id === id)?.name ?? "an account").join(", ")} only`
    : "";
  return `${what}${d.category ? ` · ${d.category}` : ""}, ${span}${cut}${accounts}`;
}
