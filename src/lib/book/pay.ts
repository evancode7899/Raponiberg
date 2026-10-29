import { amountsFromLines, ZERO_AMOUNTS, type PayrollAmounts } from "../ingest/payroll/index.ts";
import { CASH_EARNING_KINDS, WITHHELD_KINDS, type StubLine } from "../ingest/payroll/types.ts";
import { blockersFor } from "./blockers.ts";
import type { Book, BookRow, BookStub } from "./load.ts";
import type { Finding, Inference } from "./types.ts";

/**
 * Pay, from the stored stubs. A person's year with one employer is the latest stub of
 * that year's year-to-date figures; the integrity checks prove that stub is the last one
 * (no later paycheck deposited), that the stubs before it carry their totals (or that
 * paychecks without a stub are explained by the deposits), and that the year's net pay
 * equals what the bank received.
 */

export const UNKNOWN_PERSON = "?";

/** Stubs grouped by person | employer | year, each group in pay order. */
export function stubGroups(book: Book): Map<string, BookStub[]> {
  const out = new Map<string, BookStub[]>();
  for (const s of book.stubs) {
    const k = `${s.personId ?? UNKNOWN_PERSON}|${s.employerKey}|${s.payDate.slice(0, 4)}`;
    out.set(k, [...(out.get(k) ?? []), s]);
  }
  for (const g of out.values()) g.sort((a, b) => a.payDate.localeCompare(b.payDate) || netYtd(a) - netYtd(b));
  return out;
}

/** Year-to-date net pay: printed, else gross YTD − withheld YTD from the lines. */
export function netYtd(s: BookStub): number {
  if (s.printed.netYtd != null) return s.printed.netYtd;
  const sum = (kinds: ReadonlySet<string>) => s.lines.filter((l) => kinds.has(l.kind)).reduce((t, l) => t + (l.ytd ?? 0), 0);
  return (s.printed.grossYtd ?? sum(CASH_EARNING_KINDS)) - (s.printed.withheldYtd ?? sum(WITHHELD_KINDS));
}

/**
 * Bank rows that are paychecks from an employer: the deposits its stubs are linked to,
 * plus any other income row with the same payee key (a paycheck whose stub is missing).
 */
export function employerDeposits(book: Book, employerKey: string): BookRow[] {
  const linked = book.stubs.filter((s) => s.employerKey === employerKey && s.depositTransactionId).map((s) => book.rowById.get(s.depositTransactionId!)).filter((r): r is BookRow => !!r);
  const keys = new Set(linked.map((r) => r.merchantKey).filter((k): k is string => !!k));
  const ids = new Set(linked.map((r) => r.id));
  return book.rows.filter((r) => ids.has(r.id) || (r.lane === "INCOME" && r.amountCents > 0 && r.merchantKey != null && keys.has(r.merchantKey)));
}

/**
 * A year's pay by what it is, from a stub's year-to-date lines. Satisfies
 * salary + bonus + reimbursements − withholding − benefits − afterTax − deferrals = net.
 */
export type PayBreakdown = {
  salary: number;
  bonus: number;
  /** Non-taxable expense reimbursements paid with the paycheck. */
  reimbursements: number;
  /** Every tax withheld: federal, FICA, state, local, state payroll programs. */
  withholding: number;
  /** Pre-tax benefit premiums, FSAs. */
  benefits: number;
  /** After-tax deductions (insurance and the like). */
  afterTax: number;
  /** Employee 401(k) (pre-tax + Roth) and HSA deferrals: savings inside gross pay. */
  deferrals: number;
  employerRetirement: number;
  employerHsa: number;
  net: number;
};

export const ZERO_BREAKDOWN: PayBreakdown = { salary: 0, bonus: 0, reimbursements: 0, withholding: 0, benefits: 0, afterTax: 0, deferrals: 0, employerRetirement: 0, employerHsa: 0, net: 0 };

/** From a stub's year-to-date lines (default), or its own check's ("current"). */
export function payBreakdown(lines: StubLine[], which: "ytd" | "current" = "ytd"): PayBreakdown {
  const a = amountsFromLines(lines, which);
  const afterTax = lines.filter((l) => l.kind === "AFTER_TAX").reduce((t, l) => t + (l[which] ?? 0), 0);
  const b: PayBreakdown = {
    salary: a.regular,
    bonus: a.bonus,
    reimbursements: a.nonTaxable,
    withholding: a.federalWithheld + a.ssWithheld + a.medicareWithheld + a.stateWithheld + a.otherStateWithheld + a.statePayroll,
    benefits: a.section125 + a.dependentCareFsa,
    afterTax,
    deferrals: a.retirementPretax + a.retirementRoth + a.hsa,
    employerRetirement: a.employerRetirement,
    employerHsa: a.employerHsa,
    net: 0,
  };
  b.net = b.salary + b.bonus + b.reimbursements - b.withholding - b.benefits - b.afterTax - b.deferrals;
  return b;
}

export type EmployerYear = {
  employer: string;
  employerKey: string;
  stubCount: number;
  firstPayDate: string;
  lastPayDate: string;
  /** Year-to-date figures on the latest stub of the year (through the cutoff). */
  ytd: PayrollAmounts;
  breakdown: PayBreakdown;
  /** Stubs through the cutoff, in pay order (for projections). */
  stubs: BookStub[];
};

export type PersonPayYear = {
  personId: string;
  year: number;
  employers: EmployerYear[];
  totals: PayBreakdown;
  /** Latest pay date the figures run through. */
  through: string | null;
  /** Findings that make these figures unprovable (empty = proven). */
  blockers: Finding[];
  /** Parts of the year taken from year-to-date totals only (shown, labelled partial). */
  partial: Inference[];
};

/**
 * A person's pay for a calendar year, from stubs paid on or before `through` (default: year
 * end). With `from` inside the year (a partner's pay counts only from the merge), only the
 * checks paid from then on, added check by check (the pay proof's "paid" basis).
 */
export function personPayYear(book: Book, personId: string, year: number, through = `${year}-12-31`, from?: string): PersonPayYear {
  const start = from && from > `${year}-01-01` ? from : `${year}-01-01`;
  const byCheck = start !== `${year}-01-01`;
  const employers: EmployerYear[] = [];
  for (const [k, all] of stubGroups(book)) {
    const [p, employerKey, y] = k.split("|");
    if (p !== personId || Number(y) !== year) continue;
    const stubs = all.filter((s) => s.payDate >= start && s.payDate <= through);
    if (!stubs.length) continue;
    const last = stubs.at(-1)!;
    employers.push({
      employer: last.employer,
      employerKey: employerKey!,
      stubCount: stubs.length,
      firstPayDate: stubs[0]!.payDate,
      lastPayDate: last.payDate,
      ytd: amountsFromLines(last.lines, "ytd"),
      breakdown: byCheck ? sumBreakdowns(stubs.map((s) => payBreakdown(s.lines, "current"))) : payBreakdown(last.lines),
      stubs,
    });
  }
  const totals = sumBreakdowns(employers.map((e) => e.breakdown));
  return {
    personId,
    year,
    employers: employers.sort((a, b) => a.firstPayDate.localeCompare(b.firstPayDate)),
    totals,
    through: employers.map((e) => e.lastPayDate).sort().at(-1) ?? null,
    blockers: start > through ? [] : blockersFor(book, { affects: "PAY", personId, from: start, to: through }),
    // Added check by check, a year's totals aren't read off year-to-date figures: only what's
    // found about the checks from `from` on bears on them.
    partial:
      start > through
        ? []
        : book.integrity.inferences.filter((i) => i.partial && i.scope?.personId === personId && i.scope.from <= through && (byCheck ? i.scope.from >= start : i.scope.to >= start)),
  };
}

function sumBreakdowns(bs: PayBreakdown[]): PayBreakdown {
  const totals = { ...ZERO_BREAKDOWN };
  for (const b of bs) for (const key of Object.keys(ZERO_BREAKDOWN) as (keyof PayBreakdown)[]) totals[key] += b[key];
  return totals;
}

export { ZERO_AMOUNTS };
