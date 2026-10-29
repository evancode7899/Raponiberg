import { addDays } from "../../dates/isoDate.ts";
import { formatPercentRatio, formatUsdFromCents } from "../../formatMoney.ts";
import { buildAnnualProfile, transfersInTransit, type AnnualProfileReport, type PersonYear, type YearCash, type YearProfile } from "../../profile/buildAnnualProfile.ts";
import { bucketForGroup } from "../../profile/annualMath.ts";
import { rollTotalValue, rollValue, type RollLine, type RollTotalLine } from "../../profile/rollLines.ts";
import { buildAccountRollforwards, type AccountRollforward, type RollYear } from "../../profile/rollforwards.ts";
import { BUCKETS, loadProfileSettings, type NetWorthBucket } from "../../profile/settings.ts";
import type { BlockerQuery } from "../blockers.ts";
import { accountIdForNumber, investmentIncomeByAccount } from "../investments.ts";
import type { Book } from "../load.ts";
import { personPayYear } from "../pay.ts";
import type { BlockerRef } from "../reports/blockerRef.ts";
import { buildCashFlowReport, type CashFlowPeriod } from "../reports/cashFlow.ts";
import { buildNetWorth } from "../reports/netWorth.ts";
import { taxRows } from "../taxPayments.ts";
import type { CheckId } from "../types.ts";
import { CASH_FLOW_CHECKS, type CashFlowDescriptor } from "./cashFlowProof.ts";
import { checksFor, estimatesFor, perBook, sumCheck } from "./common.ts";
import { buildNetWorthProof, NET_WORTH_CHECKS, type NetWorthDescriptor } from "./netWorthProof.ts";
import { buildPayProof, groupRows, PAY_CHECKS, type PayDescriptor, type PayLine } from "./payProof.ts";
import type { ChainLine, Proof, ProofBlock, ProofCheck, ProofContext, ProofEstimate, ProofKind, ProofLink } from "./types.ts";

/**
 * The proof behind a line of the Annual statement (Annual › Statement) and of Net worth ›
 * Account roll-forwards. Those pages show the annual profile's own arithmetic: a year's
 * cash waterfall (gross pay → taxes → deductions → living → saved), year-end net worth by
 * bucket, the bridge from what was saved to the change in net worth, and each investment
 * account's year. Each proof re-derives its line through buildAnnualProfile (or
 * buildAccountRollforwards) and lays it out as a chain that re-adds exactly, every part
 * linking to the proof it is read from: pay to the pay stubs, spending and income to Cash
 * flow, balances and changes to Net worth.
 *
 * The profile counts each row whole on the day the ledger books it (so the bridge to net
 * worth has no slippage); Cash flow counts rent in the month it pays for and spreads a
 * statement's period totals over its days. Where the two differ for the same lines the
 * difference is a labelled line of the chain, never folded into another.
 */

export type AnnualCashLine =
  | "other-income"
  | "gross"
  | "withholding"
  | "taxes-paid"
  | "refunds"
  | "deductions"
  | "employer"
  | "partner-kept"
  | "net-cash"
  | "living"
  | "one-offs"
  | "saved"
  | "reimbursements"
  | "tax-rate"
  | "savings-of-gross"
  | "savings-of-net";
export type AnnualNetWorthLine = "net-worth" | "assets" | "debt" | "liquid" | "illiquid" | "in-transit" | "change" | "change-pct";
export type AnnualBridgeLine = "cashSaved" | "investmentGrowth" | "outsideMoney" | "newlyTracked" | "inTransit" | "unexplainedSavings" | "total";
export type { RollLine, RollTotalLine };

export type AnnualDescriptor =
  | { report: "annual"; figure: "cash"; year: number; line: AnnualCashLine }
  | { report: "annual"; figure: "category"; year: number; category: string }
  | { report: "annual"; figure: "net-worth"; year: number; line: AnnualNetWorthLine }
  | { report: "annual"; figure: "bucket"; year: number; bucket: NetWorthBucket }
  | { report: "annual"; figure: "bridge"; year: number; line: AnnualBridgeLine }
  | { report: "annual"; figure: "rollforward"; year: number; accountId: string; line: RollLine }
  | { report: "annual"; figure: "rollforward-total"; year: number; line: RollTotalLine };

const CASH_LINES: AnnualCashLine[] = [
  "other-income",
  "gross",
  "withholding",
  "taxes-paid",
  "refunds",
  "deductions",
  "employer",
  "partner-kept",
  "net-cash",
  "living",
  "one-offs",
  "saved",
  "reimbursements",
  "tax-rate",
  "savings-of-gross",
  "savings-of-net",
];
const NW_LINES: AnnualNetWorthLine[] = ["net-worth", "assets", "debt", "liquid", "illiquid", "in-transit", "change", "change-pct"];
const BRIDGE_LINES: AnnualBridgeLine[] = ["cashSaved", "investmentGrowth", "outsideMoney", "newlyTracked", "inTransit", "unexplainedSavings", "total"];
const ROLL_LINES: RollLine[] = ["opening", "employee", "employer", "deposits", "withdrawals", "after-contributions", "income", "market", "fees", "closing", "return"];
const ROLL_TOTAL_LINES: RollTotalLine[] = ["closing", "contributions", "growth"];

export function parseAnnualDescriptor(d: Record<string, unknown>): AnnualDescriptor | { error: string } {
  if (typeof d.year !== "number" || !Number.isInteger(d.year) || d.year < 1900 || d.year > 2999) return { error: "year must be a calendar year." };
  const year = d.year;
  const one = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);
  switch (d.figure) {
    case "cash":
      return one(CASH_LINES, d.line) ? { report: "annual", figure: "cash", year, line: d.line } : { error: `line must be one of: ${CASH_LINES.join(", ")}.` };
    case "category":
      return typeof d.category === "string" && d.category ? { report: "annual", figure: "category", year, category: d.category } : { error: "category must be a name." };
    case "net-worth":
      return one(NW_LINES, d.line) ? { report: "annual", figure: "net-worth", year, line: d.line } : { error: `line must be one of: ${NW_LINES.join(", ")}.` };
    case "bucket": {
      const ids = BUCKETS.map((b) => b.id);
      return one(ids, d.bucket) ? { report: "annual", figure: "bucket", year, bucket: d.bucket } : { error: `bucket must be one of: ${ids.join(", ")}.` };
    }
    case "bridge":
      return one(BRIDGE_LINES, d.line) ? { report: "annual", figure: "bridge", year, line: d.line } : { error: `line must be one of: ${BRIDGE_LINES.join(", ")}.` };
    case "rollforward":
      if (typeof d.accountId !== "string" || !d.accountId) return { error: "accountId must be an account id." };
      return one(ROLL_LINES, d.line) ? { report: "annual", figure: "rollforward", year, accountId: d.accountId, line: d.line } : { error: `line must be one of: ${ROLL_LINES.join(", ")}.` };
    case "rollforward-total":
      return one(ROLL_TOTAL_LINES, d.line) ? { report: "annual", figure: "rollforward-total", year, line: d.line } : { error: `line must be one of: ${ROLL_TOTAL_LINES.join(", ")}.` };
  }
  return { error: "figure must be cash, category, net-worth, bucket, bridge, rollforward or rollforward-total." };
}

// ---------------------------------------------------------------------------

const money = (c: number) => (c === 0 ? "$0.00" : formatUsdFromCents(c));
const pct = (r: number) => formatPercentRatio(r, 2);
const BOOKED_DAY =
  "Cash flow counts rent in the month it pays for and spreads a statement's period totals over its days; the annual statement takes each row whole on the day the ledger books it.";

type Built = Omit<Proof, "report" | "descriptor" | "today">;
type Ctx = { book: Book; profile: AnnualProfileReport };

const cashLink = (label: string, year: number, line: AnnualCashLine): ProofLink => ({ label, descriptor: { report: "annual", figure: "cash", year, line } });
const nwLink = (label: string, year: number, line: AnnualNetWorthLine): ProofLink => ({ label, descriptor: { report: "annual", figure: "net-worth", year, line } });
const bucketLink = (label: string, year: number, bucket: NetWorthBucket): ProofLink => ({ label, descriptor: { report: "annual", figure: "bucket", year, bucket } });
const bridgeLink = (label: string, year: number, line: AnnualBridgeLine): ProofLink => ({ label, descriptor: { report: "annual", figure: "bridge", year, line } });
const balanceLink = (label: string, date: string, accountIds?: string[]): ProofLink => ({ label, descriptor: { report: "net-worth", metric: "balance", date, ...(accountIds?.length ? { accountIds } : {}) } satisfies NetWorthDescriptor });

/** A money line; a signed adjustment shows "+" or "−" by its sign with the value positive. */
const line = (op: ChainLine["op"], label: string, cents: number, source: ChainLine["source"], extra: Partial<ChainLine> = {}): ChainLine => ({ op, label, value: { cents }, source, ...extra });
const signed = (cents: number, label: string, source: ChainLine["source"], extra: Partial<ChainLine> = {}): ChainLine => line(cents < 0 ? "−" : "+", label, Math.abs(cents), source, extra);

/** The first line of a chain starts it (no op). */
function startChain(lines: ChainLine[]): ChainLine[] {
  if (lines[0]?.op === "+") lines[0] = { ...lines[0], op: undefined };
  return lines;
}

/** What the money lines before a chain's closing "=" add up to (the self-check's parts). */
function partsBeforeTotal(lines: ChainLine[]): number {
  let acc = 0;
  for (const l of lines.slice(0, -1)) {
    if (!("cents" in l.value)) continue;
    if (l.op === "=") acc = l.value.cents;
    else if (l.op === "−") acc -= l.value.cents;
    else acc += l.value.cents;
  }
  return acc;
}

/** A proof whose figure is a chain's closing "=" line. */
function chainProof(describes: string, figureCents: number, title: string, lines: ChainLine[], rest: Omit<Built, "describes" | "figure" | "selfCheck" | "blocks"> & { blocks?: ProofBlock[]; note?: string }): Built {
  const parts = partsBeforeTotal(lines);
  const { blocks = [], note, ...more } = rest;
  return {
    describes,
    figure: { cents: figureCents },
    selfCheck: sumCheck(figureCents, parts, `The lines above the total add up to ${money(parts)}`),
    blocks: [{ kind: "chain", title, lines, ...(note ? { note } : {}) }, ...blocks],
    ...more,
  };
}

/** A ratio worked out from two proven figures. */
/** `noRatio`: why the page shows no ratio though the parts would give one (a rule, such as too little money to measure a return on). */
function ratioProof(describes: string, ratio: number | null, num: ChainLine[], den: ChainLine, rest: Omit<Built, "describes" | "figure" | "selfCheck" | "blocks">, noRatio?: string): Built {
  const n = partsBeforeTotal([...num, line("=", "", 0, "derived")]);
  const d = "cents" in den.value ? den.value.cents : 0;
  const recomputed = d > 0 ? n / d : null;
  const lines: ChainLine[] = [...num];
  if (num.length > 1) lines.push(line("=", "Numerator", n, "derived"));
  lines.push({ ...den, op: "÷" }, { op: "=", label: describes, value: ratio == null ? { text: "—" } : { ratio }, source: "derived" });
  const ok = recomputed === ratio || (recomputed != null && ratio != null && Math.abs(recomputed - ratio) < 1e-12) || (ratio == null && noRatio != null);
  const worked = recomputed == null ? "The denominator is zero: no ratio" : `${money(n)} ÷ ${money(d)} = ${pct(recomputed)}`;
  return {
    describes,
    figure: ratio == null ? { text: "—" } : { ratio },
    selfCheck: { ok, deltaCents: 0, explain: ratio == null && noRatio != null ? `${worked}, but ${noRatio}` : worked },
    blocks: [{ kind: "chain", title: describes, lines }],
    ...rest,
  };
}

function notFound(why: string, through = ""): Built {
  return { describes: why, figure: { text: "—" }, selfCheck: null, blocks: [], checks: [], estimates: [], withheld: true, through };
}

function withheld(describes: string, blockers: BlockerRef[], through: string): Built {
  return {
    describes,
    figure: { text: "Withheld" },
    selfCheck: null,
    withheld: true,
    blocks: [{ kind: "breakdown", title: "What withholds it", items: blockers.map((b) => ({ label: b.title, value: { text: b.status } })) }],
    checks: [],
    estimates: [],
    through,
  };
}

/** Every check over a year's cash and pay (the statement's cash section is withheld by either). */
/**
 * Every check over a year's cash and pay (the statement's cash section is withheld by
 * either), and what in that year stands on an inference rather than a printed line (rows
 * awaiting review, inferred pay, idle card cycles): the same list the Cash flow proof gives.
 */
function cashChecks(c: Ctx, y: YearProfile, extra: BlockerQuery[] = [], ids: CheckId[] = []): { checks: ProofCheck[]; withheld: boolean; estimates: ProofEstimate[] } {
  const from = `${y.year}-01-01`;
  const qs: BlockerQuery[] = [{ affects: "CASH_FLOW", from, to: y.asOf }, ...c.profile.persons.map((p) => ({ affects: "PAY" as const, from, to: y.asOf, personId: p.id })), ...extra];
  const rowIds = new Set(c.book.rows.filter((r) => r.bookedOn >= from && r.bookedOn <= y.asOf && (r.lane === "INCOME" || r.lane === "EXPENSE" || r.lane === "EXTERNAL_TRANSFER")).map((r) => r.id));
  return { ...checksFor(c.book, qs, [...new Set([...CASH_FLOW_CHECKS, ...PAY_CHECKS, ...ids])]), estimates: estimatesFor(c.book, { rowIds, from, to: y.asOf }) };
}

/** Checks over net worth in a window, and what in it is inferred (market change derived from balances, idle card cycles). */
function nwChecks(c: Ctx, from: string, to: string, accountIds?: string[]) {
  return { ...checksFor(c.book, { affects: "NET_WORTH", from, to, ...(accountIds ? { accountIds } : {}) }, NET_WORTH_CHECKS), estimates: estimatesFor(c.book, { rowIds: new Set(), from, to, accountIds }) };
}

/** The year on Cash flow (one period, Jan 1 through the statement's cash edge). */
function cashFlowYear(c: Ctx, y: YearProfile): { period: CashFlowPeriod | null; d: (metric: CashFlowDescriptor["metric"], category?: string) => CashFlowDescriptor } {
  const start = `${y.year}-01-01`;
  const period = buildCashFlowReport(c.book, { granularity: "year", from: start, to: y.asOf }).periods.find((p) => p.start === start) ?? null;
  return { period, d: (metric, category) => ({ report: "cash-flow", metric, granularity: "year", start, end: y.asOf, ...(category ? { category } : {}) }) };
}

const NOT_OTHER = new Set(["Paycheck", "P2P & reimbursements"]);

// ------------------------------------------------------------------- cash

function cashProof(c: Ctx, y: YearProfile, cash: YearCash, ln: AnnualCashLine): Built {
  const { book } = c;
  const w = cash.waterfall;
  const yr = y.year;
  const start = `${yr}-01-01`;
  const people = (y.people ?? []).filter((p) => p.hasPay);
  const fromOf = new Map(people.map((p) => [p.personId, p.from]));
  // A partner's year from the merge: the checks paid from then on, not the stub's year to date.
  const payD = (personId: string, l: PayLine): PayDescriptor => {
    const from = fromOf.get(personId);
    return from ? { report: "pay", basis: "paid", personId, start: from, end: y.asOf, lines: [l] } : { report: "pay", basis: "ytd", personId, year: yr, through: y.asOf, lines: [l] };
  };
  const payOf = (p: PersonYear) => personPayYear(book, p.personId, yr, y.asOf, p.from ?? undefined);
  const base = { ...cashChecks(c, y), through: y.asOf };
  const label = `${y.label}`;

  /** Each person's pay stubs (their gross pay proof), for lines read off the stubs. */
  const stubsBlock = (): ProofBlock => ({
    kind: "breakdown",
    title: "The pay stubs these are read from",
    items: people.map((p) => {
      const d = payD(p.personId, "gross");
      const f = buildPayProof(book, d).figure;
      return { label: `${p.name}'s gross pay, ${p.employers.join(" + ")}`, value: f, link: { label: `${p.name}'s stubs`, descriptor: d } };
    }),
  });
  /** A pay-stub figure, per person and employer, from each employer's year-to-date on its latest stub. */
  const stubLines = (pick: (b: ReturnType<typeof personPayYear>["totals"]) => number, what: string): ChainLine[] =>
    startChain(
      people.flatMap((p) =>
        payOf(p).employers.map((e) =>
          line("+", `${p.name} · ${e.employer}`, pick(e.breakdown), "proven", {
            note: p.from ? `${what}, check by check on the stubs paid ${p.from} – ${e.lastPayDate} (from the merge)` : `${what}, year to date on the ${e.lastPayDate} stub`,
          }),
        ),
      ),
    );

  /** Cash flow's saved from take-home → this year's saved incl. retirement, line by line (profile/savedBridge.ts). */
  const takeHomeBlock = (): ProofBlock => {
    const b = cash.savedBridge;
    const cf = cashFlowYear(c, y);
    // Where the undeposited pay went: each stub's printed deposit account.
    const notDeposited = new Map<string, number>();
    for (const p of people)
      for (const e of payOf(p).employers)
        for (const s of e.stubs) if (!s.depositTransactionId) for (const d of s.deposits) notDeposited.set(d.last4 ?? "?", (notDeposited.get(d.last4 ?? "?") ?? 0) + 1);
    const to = [...notDeposited].map(([last4, n]) => `••${last4} (${n} stub${n === 1 ? "" : "s"})`).join(", ");
    const lines: ChainLine[] = [line(undefined, "Saved from take-home on Cash flow", b.takeHome, "proven", { link: { label: `Saved from take-home, ${label}`, descriptor: cf.d("net") } })];
    for (const p of people) {
      const d = payOf(p).totals.deferrals;
      if (d) lines.push(line("+", `${p.name}: 401(k) and HSA deferrals`, d, "proven", { link: { label: `${p.name}'s deferrals`, descriptor: payD(p.personId, "deferrals") }, note: "Taken from pay before it's deposited." }));
    }
    if (b.employer) lines.push(line("+", "Employer retirement & HSA money", b.employer, "proven", { link: cashLink("Employer money", yr, "employer") }));
    if (b.dividends) lines.push(line("+", "Brokerage dividends & distributions", b.dividends, "proven", { link: cashLink("Investment & other income", yr, "other-income"), note: "Income on brokerage statements, not bank rows." }));
    if (b.payYtdOnly) lines.push(signed(b.payYtdOnly, "Net pay known only from year-to-date totals", "proven", { note: "Paychecks before the first stub on file, carried in the next stub's year-to-date figures." }));
    if (b.payNotDeposited) lines.push(signed(b.payNotDeposited, "Net pay to accounts with no statements", "proven", { note: to ? `Deposited to ${to}.` : "Part of a paycheck deposited outside the tracked accounts." }));
    if (b.payOtherYear) lines.push(signed(b.payOtherYear, "Net pay on this year's stubs, deposited in another year", "proven", { note: "Or the deposit is filed as other income, not as a paycheck." }));
    if (b.depositsWithoutStub) lines.push(signed(-b.depositsWithoutStub, "Paycheck deposits with no stub this year", "proven"));
    if (b.partnerKept) lines.push(signed(-b.partnerKept, "A partner's net pay kept in their own accounts", "proven", { link: cashLink("Partner pay kept", yr, "partner-kept") }));
    if (b.taxTiming) lines.push(signed(b.taxTiming, "Tax payments and refunds: bank date vs. Cash flow's month", "derived", { note: BOOKED_DAY }));
    if (b.unexplained) lines.push(signed(b.unexplained, "Not explained by the lines above", "derived"));
    lines.push(line("=", "Saved incl. retirement", b.saved, "derived"));
    return { kind: "chain", title: "From Cash flow's saved from take-home", lines };
  };

  switch (ln) {
    case "other-income": {
      const cf = cashFlowYear(c, y);
      const cats = (cf.period?.incomeByCategory ?? []).filter((x) => !NOT_OTHER.has(x.category) && x.cents !== 0);
      const lines: ChainLine[] = cats.map((x) => line("+", `${x.category} on Cash flow`, x.cents, "proven", { link: { label: `${x.category}, ${label}`, descriptor: cf.d("income", x.category) } }));
      const tax = cash.taxRowsByCategory.income.filter((x) => !NOT_OTHER.has(x.category));
      for (const t of tax) lines.push(line("−", `${t.category}: tax-authority rows`, t.cents, "proven", { note: "A refund from a tax authority counts on the Plus: tax refunds line, not as income." }));
      const onStatements = cash.otherIncomeDetail.interest + cash.otherIncomeDetail.other;
      const diff = onStatements - (cats.reduce((s, x) => s + x.cents, 0) - tax.reduce((s, x) => s + x.cents, 0));
      if (diff) lines.push(signed(diff, "Counted by the day the ledger books each row", "derived", { note: BOOKED_DAY }));
      lines.push(line("=", "Bank interest and other income on statements", onStatements, "derived"));
      for (const v of investmentIncomeByAccount(book, yr, y.asOf).values()) {
        if (v.kind !== "TAXABLE") continue;
        const id = accountIdForNumber(book, v.accountNumber);
        const name = book.accounts.find((a) => a.id === id)?.name ?? "A brokerage account";
        lines.push(line("+", `${name}: dividends & distributions`, v.cents, "proven", { note: `Year-to-date income printed on its ${v.asOf} statement.` }));
      }
      lines.push(line("=", "Investment & other income", w.otherIncome, "derived"));
      return chainProof(`Investment & other income · ${label}`, w.otherIncome, "Interest + other income + dividends", startChain(lines), {
        ...base,
        blocks: [
          {
            kind: "breakdown",
            title: "As the statement's tooltip splits it",
            items: [
              { label: "Bank interest", value: { cents: cash.otherIncomeDetail.interest } },
              { label: "Brokerage dividends & distributions", value: { cents: cash.otherIncomeDetail.dividends } },
              { label: "Other", value: { cents: cash.otherIncomeDetail.other } },
            ],
          },
        ],
      });
    }
    case "gross": {
      const lines: ChainLine[] = [];
      for (const p of people) {
        lines.push(line("+", `${p.name} — salary`, p.salary, "proven", { link: { label: `${p.name}'s salary`, descriptor: payD(p.personId, "base") } }));
        if (p.bonus) lines.push(line("+", `${p.name} — bonus`, p.bonus, "proven", { link: { label: `${p.name}'s bonus`, descriptor: payD(p.personId, "bonus") } }));
      }
      lines.push(line("+", "Investment & other income", w.otherIncome, "derived", { link: cashLink("Investment & other income", yr, "other-income") }));
      lines.push(line("=", "Total gross cash paid", w.grossCash, "derived"));
      return chainProof(`Total gross cash paid · ${label}`, w.grossCash, "Pay + other income", startChain(lines), base);
    }
    case "withholding": {
      const lines = [...stubLines((b) => b.withholding, "Taxes withheld"), line("=", "Taxes withheld", w.withholding, "derived")];
      return chainProof(`Taxes withheld · ${label}`, w.withholding, "Withheld on pay stubs", lines, { ...base, blocks: [stubsBlock()], note: "Federal, Social Security, Medicare, state and local tax and state payroll programs." });
    }
    case "deductions": {
      const lines = [...stubLines((b) => b.benefits + b.afterTax, "Benefit premiums, FSAs and after-tax deductions"), line("=", "Benefits & other deductions", w.otherDeductions, "derived")];
      return chainProof(`Benefits & other deductions · ${label}`, w.otherDeductions, "Deducted on pay stubs", lines, { ...base, blocks: [stubsBlock()], note: "401(k) and HSA deferrals aren't subtracted: they're savings." });
    }
    case "employer": {
      const lines = [...stubLines((b) => b.employerRetirement + b.employerHsa, "Employer 401(k) and HSA money"), line("=", "Employer retirement & HSA money", w.employer, "derived")];
      return chainProof(`Employer retirement & HSA money · ${label}`, w.employer, "On pay stubs", lines, { ...base, blocks: [stubsBlock()] });
    }
    case "partner-kept": {
      const lines: ChainLine[] = [];
      for (const p of people.filter((x) => x.keptOwn)) {
        lines.push(line("+", `${p.name}: net pay, year to date`, p.net, "proven", { link: { label: `${p.name}'s net pay`, descriptor: payD(p.personId, "net") } }));
        lines.push(line("−", `${p.name}: deposits into tracked accounts`, p.net - p.keptOwn, "proven", { note: "Each stub's linked deposit row, once." }));
        lines.push(line("=", `${p.name}: kept in their own accounts`, p.keptOwn, "derived"));
      }
      lines.push(line("=", "A partner's pay kept in their own accounts", w.partnerKept, "derived"));
      return chainProof(`A partner's pay kept in their own accounts · ${label}`, w.partnerKept, "Net pay − deposits reaching household accounts", startChain(lines), {
        ...base,
        blocks: [stubsBlock()],
        note: `A partner's pay counts from the ${book.ledger.mergeDate} merge. What of it went to an account that stayed theirs was theirs, not the household's; what they moved in later counts as outside money in the net-worth bridge.`,
      });
    }
    case "taxes-paid":
    case "refunds": {
      const paid = ln === "taxes-paid";
      const rows = taxRows(book, start, y.asOf).filter((r) => (paid ? r.amountCents < 0 : r.amountCents >= 0));
      const sign = paid ? -1 : 1;
      const groups = groupRows(book, rows).map((g) => ({ ...g, subtotalCents: sign * g.subtotalCents, rows: g.rows.map((r) => ({ ...r, countedCents: sign * r.amountCents })) }));
      const figure = paid ? w.additionalTaxes : w.refunds;
      const re = rows.reduce((s, r) => s + sign * r.amountCents, 0);
      const byAuthority = new Map<string, number>();
      for (const r of rows) byAuthority.set(r.authority, (byAuthority.get(r.authority) ?? 0) + sign * r.amountCents);
      return {
        describes: `${paid ? "Additional taxes paid" : "Tax refunds"} · ${label}`,
        figure: { cents: figure },
        selfCheck: sumCheck(figure, re, `The ${rows.length} bank row${rows.length === 1 ? "" : "s"} below add up to ${money(re)}`),
        blocks: [
          ...(byAuthority.size > 1 ? [{ kind: "breakdown" as const, title: "By tax authority", items: [...byAuthority].map(([a, cents]) => ({ label: a, value: { cents } })) }] : []),
          {
            kind: "rows",
            title: paid ? "Payments to tax authorities" : "Refunds from tax authorities",
            figureCents: figure,
            groups,
            note: "Every bank row whose payee is a tax authority (IRS / EFTPS, state), whatever it's filed under: taxes, not living or income.",
          },
        ],
        ...base,
      };
    }
    case "net-cash": {
      const lines = startChain([
        line("+", "Total gross cash paid", w.grossCash, "derived", { link: cashLink("Gross cash", yr, "gross") }),
        line("−", "Taxes withheld", w.withholding, "proven", { link: cashLink("Taxes withheld", yr, "withholding") }),
        line("−", "Additional taxes paid", w.additionalTaxes, "proven", { link: cashLink("Taxes paid", yr, "taxes-paid") }),
        line("+", "Tax refunds", w.refunds, "proven", { link: cashLink("Refunds", yr, "refunds") }),
        line("−", "Benefits & other deductions", w.otherDeductions, "proven", { link: cashLink("Deductions", yr, "deductions") }),
        line("+", "Employer retirement & HSA money", w.employer, "proven", { link: cashLink("Employer money", yr, "employer") }),
        line("−", "A partner's pay kept in their own accounts", w.partnerKept, "proven", { link: cashLink("Partner pay kept", yr, "partner-kept") }),
        line("=", "Total net cash", w.netCash, "derived"),
      ]);
      return chainProof(`Total net cash · ${label}`, w.netCash, "Gross → net", lines, base);
    }
    case "saved": {
      const lines = startChain([
        line("+", "Total net cash", w.netCash, "derived", { link: cashLink("Net cash", yr, "net-cash") }),
        line("−", "Living expenses", w.living, "derived", { link: cashLink("Living expenses", yr, "living") }),
        line("−", "One-off expenses", w.nonRecurring, "proven", { link: cashLink("One-offs", yr, "one-offs") }),
        line("=", "Saved incl. retirement", w.saved, "derived"),
      ]);
      return chainProof(`Saved incl. retirement · ${label}`, w.saved, "Net cash − living − one-offs", lines, { ...base, blocks: [takeHomeBlock()] });
    }
    case "living": {
      const t = cash.livingTrail;
      const cf = cashFlowYear(c, y);
      const cfCents = cf.period?.spendingCents ?? 0;
      const oneOffs = t.oneOffs.reduce((s, o) => s + o.cents, 0) + t.oneOffCategories.reduce((s, o) => s + o.cents, 0);
      const booked = t.spending + t.taxPayments + oneOffs;
      const lines: ChainLine[] = [line(undefined, `Spending on Cash flow, ${start} – ${y.asOf}`, cfCents, "proven", { link: { label: `Spending, ${label}`, descriptor: cf.d("spending") } })];
      if (booked !== cfCents) lines.push(signed(booked - cfCents, "Counted by the day the ledger books each row", "derived", { note: BOOKED_DAY }));
      if (t.taxPayments) lines.push(line("−", "Tax payments (taxes, not living)", t.taxPayments, "proven", { link: cashLink("Taxes paid", yr, "taxes-paid") }));
      if (oneOffs) lines.push(line("−", "One-off expenses", oneOffs, "proven", { link: cashLink("One-offs", yr, "one-offs") }));
      if (cash.reimbursements)
        lines.push(
          line("=", "Spending counted as living", t.spending, "derived"),
          line("−", "Reimbursements received", cash.reimbursements, "proven", { link: cashLink("Reimbursements", yr, "reimbursements") }),
        );
      lines.push(line("=", "Living expenses", w.living, "derived"));
      const blocks: ProofBlock[] = [
        {
          kind: "breakdown",
          title: "Spending counted as living, by category",
          items: cash.spending.map((s) => ({ label: s.category, value: { cents: s.cents }, link: { label: `${s.category}, ${label}`, descriptor: { report: "annual", figure: "category", year: yr, category: s.category } } })),
        },
      ];
      if (c.profile.seeds?.baseYear === yr && c.profile.seeds.living.LAST_YEAR)
        blocks.push({ kind: "breakdown", title: "In the forecast", items: [{ label: c.profile.seeds.living.LAST_YEAR.label, value: { cents: c.profile.seeds.living.LAST_YEAR.cents }, link: { label: "Living cost seed", descriptor: { report: "forecast", figure: "seed", which: "living", basis: "LAST_YEAR" } } }] });
      return chainProof(`Living expenses · ${label}`, w.living, "Spending less taxes, one-offs, reimbursements and a partner's pre-merge share", lines, { ...base, blocks });
    }
    case "one-offs": {
      const t = cash.livingTrail;
      const lines: ChainLine[] = [
        ...t.oneOffs.map((o) => line("+", `${o.date} ${o.payee}`, o.cents, "proven", { note: [o.category, o.account, o.label && `“${o.label}”`, "tagged by you as a one-off"].filter(Boolean).join(" · ") })),
        ...t.oneOffCategories.map((o) => line("+", `${o.category} (${o.rows} row${o.rows === 1 ? "" : "s"})`, o.cents, "proven", { note: "A category you count as one-offs." })),
      ];
      lines.push(line("=", "One-off expenses", w.nonRecurring, "derived"));
      return chainProof(`One-off expenses · ${label}`, w.nonRecurring, "Charges tagged one-off", startChain(lines), {
        ...base,
        note: "Tagged on Annual › One-off expenses or Cash flow › Spending. They count toward what was saved, only not toward living expenses.",
      });
    }
    case "reimbursements": {
      const t = cash.livingTrail;
      const cf = cashFlowYear(c, y);
      const cat = "P2P & reimbursements";
      const cfCents = cf.period?.incomeByCategory.find((x) => x.category === cat)?.cents ?? 0;
      const tax = cash.taxRowsByCategory.income.find((x) => x.category === cat)?.cents ?? 0;
      const lines: ChainLine[] = [line(undefined, `${cat} on Cash flow`, cfCents, "proven", { link: { label: `${cat}, ${label}`, descriptor: cf.d("income", cat) } })];
      if (tax) lines.push(line("−", "Tax-authority rows (counted as refunds)", tax, "proven"));
      const diff = t.reimbursements - (cfCents - tax);
      if (diff) lines.push(signed(diff, "Counted by the day the ledger books each row", "derived", { note: BOOKED_DAY }));
      lines.push(line("=", "Received by Zelle, Venmo…", t.reimbursements, "derived"));
      for (const p of people) if (p.reimbursements) lines.push(line("+", `${p.name}: reimbursed inside paychecks`, p.reimbursements, "proven", { note: "Non-taxable reimbursement lines, year to date on the latest stub." }));
      if (cash.payLinked)
        lines.push(
          line("−", "Linked to the charges they paid back", cash.payLinked, "proven", {
            note: "Paycheck reimbursements you tied to specific charges (Paid back on Transactions): counted as a credit in each charge's category instead.",
          }),
        );
      lines.push(line("=", "Reimbursements received", cash.reimbursements, "derived"));
      return chainProof(`Reimbursements received · ${label}`, cash.reimbursements, "Reimbursements offset spending", lines, { ...base, blocks: people.some((p) => p.reimbursements) ? [stubsBlock()] : [] });
    }
    case "tax-rate":
      return ratioProof(
        `Cash tax rate · ${label}`,
        w.cashTaxRate,
        startChain([
          line("+", "Taxes withheld", w.withholding, "proven", { link: cashLink("Taxes withheld", yr, "withholding") }),
          line("+", "Additional taxes paid", w.additionalTaxes, "proven", { link: cashLink("Taxes paid", yr, "taxes-paid") }),
          line("−", "Tax refunds", w.refunds, "proven", { link: cashLink("Refunds", yr, "refunds") }),
        ]),
        line(undefined, "Total gross cash paid", w.grossCash, "derived", { link: cashLink("Gross cash", yr, "gross") }),
        base,
      );
    case "savings-of-gross":
    case "savings-of-net": {
      const gross = ln === "savings-of-gross";
      return ratioProof(
        `Savings % of ${gross ? "gross" : "net"} pay · ${label}`,
        gross ? w.savingsOfGross : w.savingsOfNet,
        [line(undefined, "Saved incl. retirement", w.saved, "derived", { link: cashLink("Saved incl. retirement", yr, "saved") })],
        gross
          ? line(undefined, "Total gross cash paid", w.grossCash, "derived", { link: cashLink("Gross cash", yr, "gross") })
          : line(undefined, "Total net cash", w.netCash, "derived", { link: cashLink("Net cash", yr, "net-cash") }),
        base,
      );
    }
  }
}

function categoryProof(c: Ctx, y: YearProfile, cash: YearCash, category: string): Built {
  const cents = cash.spending.find((s) => s.category === category)?.cents;
  if (cents == null) return notFound(`No ${category} spending counted as living in ${y.label}.`, y.asOf);
  const cf = cashFlowYear(c, y);
  const cfCents = cf.period?.spendingByCategory.find((x) => x.category === category)?.cents ?? 0;
  const tax = cash.taxRowsByCategory.spending.find((x) => x.category === category)?.cents ?? 0;
  const t = cash.livingTrail;
  const tagged = t.oneOffs.filter((o) => o.category === category);
  const wholeCategory = t.oneOffCategories.find((o) => o.category === category);
  const oneOffs = tagged.reduce((s, o) => s + o.cents, 0) + (wholeCategory?.cents ?? 0);
  const lines: ChainLine[] = [line(undefined, `${category} on Cash flow`, cfCents, "proven", { link: { label: `${category}, ${y.label}`, descriptor: cf.d("spending", category) } })];
  const diff = cents + tax + oneOffs - cfCents;
  if (diff) lines.push(signed(diff, "Counted by the day the ledger books each row", "derived", { note: BOOKED_DAY }));
  if (tax) lines.push(line("−", "Tax payments filed here (taxes, not living)", tax, "proven", { link: cashLink("Taxes paid", y.year, "taxes-paid") }));
  for (const o of tagged) lines.push(line("−", `${o.date} ${o.payee}`, o.cents, "proven", { note: [o.label && `“${o.label}”`, "tagged by you as a one-off"].filter(Boolean).join(" · ") }));
  lines.push(line("=", category, cents, "derived"));
  return chainProof(`${category} · ${y.label}`, cents, "Cash flow's category, as the annual statement counts it", lines, { ...cashChecks(c, y), through: y.asOf });
}

// ------------------------------------------------------------------- net worth

type NwCtx = Ctx & { y: YearProfile; prev: YearProfile | undefined };

function nwPeriod(c: Ctx, year: number) {
  return buildNetWorth(c.book, { granularity: "year" }).periods.find((p) => p.start === `${year}-01-01`) ?? null;
}

const signedBucket = (n: NonNullable<YearProfile["netWorth"]>, b: NetWorthBucket) => (BUCKETS.find((x) => x.id === b)!.debt ? -n.buckets[b] : n.buckets[b]);
const bucketLabel = (b: NetWorthBucket) => BUCKETS.find((x) => x.id === b)!.label;

function bucketProof(c: NwCtx, bucket: NetWorthBucket): Built {
  const { book, y } = c;
  const n = y.netWorth!;
  const period = nwPeriod(c, y.year);
  if (!period) return notFound(`No statements cover ${y.year}.`, y.netWorthAsOf);
  const groupBucket = new Map(book.ledger.accounts.map((a) => [a.id, bucketForGroup(a.group)]));
  const ids = book.ledger.accounts.filter((a) => groupBucket.get(a.id) === bucket).map((a) => a.id);
  const onStatements = period.byGroup.filter((g) => bucketForGroup(g.group) === bucket).reduce((s, g) => s + g.closingCents, 0);
  const transit = transfersInTransit(book, y.netWorthAsOf).filter((t) => t.bucket === bucket).reduce((s, t) => s + t.cents, 0);
  const figure = signedBucket(n, bucket);
  const lines: ChainLine[] = [line(undefined, `Accounts on statements, ${y.netWorthAsOf}`, onStatements, "proven", ids.length ? { link: balanceLink(`${bucketLabel(bucket)} accounts`, y.netWorthAsOf, ids) } : {})];
  if (transit) lines.push(signed(transit, "Transfers in transit, headed to these accounts", "proven", { link: nwLink("Transfers in transit", y.year, "in-transit") }));
  lines.push(line("=", bucketLabel(bucket), figure, "derived"));
  const name = new Map(book.accounts.map((a) => [a.id, a.name]));
  const accounts = period.byAccount.filter((a) => groupBucket.get(a.accountId) === bucket && a.closingCents !== 0);
  return chainProof(`${bucketLabel(bucket)} · ${y.netWorthAsOf}`, figure, "Statements + transfers in transit", lines, {
    ...nwChecks(c, y.netWorthAsOf, y.netWorthAsOf, ids.length ? ids : undefined),
    through: y.netWorthAsOf,
    note: BUCKETS.find((x) => x.id === bucket)!.debt ? "Debts are negative: what's owed." : undefined,
    blocks: accounts.length
      ? [{ kind: "breakdown", title: "By account", items: accounts.map((a) => ({ label: name.get(a.accountId) ?? a.accountId, value: { cents: a.closingCents }, link: balanceLink(name.get(a.accountId) ?? "Account", y.netWorthAsOf, [a.accountId]) })) }]
      : [],
  });
}

function netWorthProof(c: NwCtx, ln: AnnualNetWorthLine): Built {
  const { book, y, prev } = c;
  const n = y.netWorth!;
  const yr = y.year;
  const at = y.netWorthAsOf;
  const base = { ...nwChecks(c, at, at), through: at };
  const bucketLines = (ids: NetWorthBucket[]) =>
    startChain(ids.filter((b) => n.buckets[b] !== 0).map((b) => signed(signedBucket(n, b), bucketLabel(b), "derived", { link: bucketLink(bucketLabel(b), yr, b) })));
  const assets = BUCKETS.filter((b) => !b.debt).map((b) => b.id);
  const debts = BUCKETS.filter((b) => b.debt).map((b) => b.id);
  switch (ln) {
    case "net-worth": {
      const period = nwPeriod(c, yr);
      const onStatements = period ? period.byGroup.reduce((s, g) => s + g.closingCents, 0) : 0;
      const lines: ChainLine[] = [line(undefined, `Net worth on statements, ${at}`, onStatements, "proven", { link: balanceLink("Every account", at) })];
      if (n.inTransit) lines.push(signed(n.inTransit, "Transfers in transit", "proven", { link: nwLink("Transfers in transit", yr, "in-transit") }));
      lines.push(line("=", "Net worth", n.netWorth, "derived"));
      return chainProof(`Net worth · ${at}`, n.netWorth, "Statements + transfers in transit", lines, {
        ...base,
        blocks: [{ kind: "breakdown", title: "By bucket", items: BUCKETS.filter((b) => n.buckets[b.id] !== 0).map((b) => ({ label: b.label, value: { cents: signedBucket(n, b.id) }, link: bucketLink(b.label, yr, b.id) })) }],
      });
    }
    case "assets":
      return chainProof(`Gross assets · ${at}`, n.grossAssets, "Every asset bucket", [...bucketLines(assets), line("=", "Gross assets", n.grossAssets, "derived")], base);
    case "debt":
      return chainProof(`Gross debt · ${at}`, -n.grossDebt, "Every debt bucket (owed, negative)", [...bucketLines(debts), line("=", "Gross debt", -n.grossDebt, "derived")], base);
    case "liquid":
      return chainProof(`Liquid net worth · ${at}`, n.liquid, "Cash + taxable investments − card debt", [...bucketLines(BUCKETS.filter((b) => b.liquid).map((b) => b.id)), line("=", "Liquid net worth", n.liquid, "derived")], base);
    case "illiquid":
      return chainProof(`Illiquid net worth · ${at}`, n.illiquid, "Everything else", [...bucketLines(BUCKETS.filter((b) => !b.liquid).map((b) => b.id)), line("=", "Illiquid net worth", n.illiquid, "derived")], base);
    case "in-transit": {
      const name = new Map(book.accounts.map((a) => [a.id, a.name]));
      const ts = transfersInTransit(book, at);
      const sum = ts.reduce((s, t) => s + t.cents, 0);
      return {
        describes: `Transfers in transit · ${at}`,
        figure: { cents: n.inTransit },
        selfCheck: sumCheck(n.inTransit, sum, `The ${ts.length} transfer${ts.length === 1 ? "" : "s"} below add up to ${money(sum)}`),
        blocks: [
          {
            kind: "breakdown",
            title: "Matched transfers between your accounts, mid-move at the end of the day",
            items: ts.map((t) => ({
              label: `${[...new Set(t.left.map((l) => name.get(l.accountId) ?? "Account"))].join(", ")} → ${name.get(t.lands.accountId) ?? "Account"}`,
              sub: `left ${t.left.map((l) => l.date).join(", ")} · lands ${t.lands.date} · counts in ${bucketLabel(t.bucket)}`,
              value: { cents: t.cents },
            })),
            note: "Money that has left one of your accounts and lands in another after the day, counted in the bucket it was headed for.",
          },
        ],
        ...base,
      };
    }
    case "change":
    case "change-pct": {
      if (!y.change || !prev?.netWorth) return withheld(`Change in net worth · ${y.label}`, y.blockers.change, at);
      const p = prev.netWorth;
      const checks = nwChecks(c, addDays(`${yr}-01-01`, -1), at);
      if (ln === "change-pct")
        return ratioProof(
          `Change in net worth (%) · ${y.label}`,
          y.change.pct,
          [line(undefined, "Change in net worth", y.change.cents, "derived", { link: nwLink("Change in net worth", yr, "change") })],
          line(undefined, `Net worth, ${prev.netWorthAsOf}`, p.netWorth, "derived", { link: nwLink("Net worth a year earlier", prev.year, "net-worth") }),
          { ...checks, through: at },
        );
      const period = nwPeriod(c, yr);
      const h = period?.household;
      const statements = h ? h.closingCents - h.openingCents : 0;
      const nwChange: NetWorthDescriptor = { report: "net-worth", metric: "change", granularity: "year", start: `${yr}-01-01`, end: at };
      const again: ChainLine[] = [line(undefined, "Change on statements", statements, "proven", { link: { label: `Net worth change, ${y.label}`, descriptor: nwChange } })];
      if (n.inTransit) again.push(signed(n.inTransit, `Transfers in transit, ${at}`, "proven", { link: nwLink("In transit", yr, "in-transit") }));
      if (p.inTransit) again.push(signed(-p.inTransit, `Transfers in transit, ${prev.netWorthAsOf}`, "proven", { link: nwLink("In transit a year earlier", prev.year, "in-transit") }));
      again.push(line("=", "Change in net worth", y.change.cents, "derived"));
      const reAgain = partsBeforeTotal(again);
      return chainProof(
        `Change in net worth · ${y.label}`,
        y.change.cents,
        "Closing − opening",
        startChain([
          line("+", `Net worth, ${at}`, n.netWorth, "derived", { link: nwLink("Net worth", yr, "net-worth") }),
          line("−", `Net worth, ${prev.netWorthAsOf}`, p.netWorth, "derived", { link: nwLink("Net worth a year earlier", prev.year, "net-worth") }),
          line("=", "Change in net worth", y.change.cents, "derived"),
        ]),
        {
          ...checks,
          through: at,
          blocks: [{ kind: "chain", title: "The same change, from the net-worth statements", lines: again, note: reAgain === y.change.cents ? undefined : `These lines add up to ${money(reAgain)}.` }],
        },
      );
    }
  }
}

// ------------------------------------------------------------------- bridge

function bridgeProof(c: NwCtx, ln: AnnualBridgeLine): Built {
  const { y, prev } = c;
  const b = y.bridge!;
  const yr = y.year;
  const period = nwPeriod(c, yr);
  if (!period || !prev?.netWorth || !y.cash) return notFound(`No bridge for ${y.label}.`, y.netWorthAsOf);
  const h = period.household;
  const cash = y.cash;
  const dividends = cash.otherIncomeDetail.dividends;
  const nwChange: NetWorthDescriptor = { report: "net-worth", metric: "change", granularity: "year", start: `${yr}-01-01`, end: y.netWorthAsOf };
  const nwChangeLink = (what: string): ProofLink => ({ label: `${what} in the net-worth change, ${y.label}`, descriptor: nwChange });
  const cf = cashFlowYear(c, y);
  const changeQ = { affects: "NET_WORTH" as const, from: addDays(`${yr}-01-01`, -1), to: y.netWorthAsOf };
  const base = { ...cashChecks(c, y, [changeQ], NET_WORTH_CHECKS), through: y.netWorthAsOf };
  const estimated = h.quality !== "EXACT";
  const LABEL: Record<AnnualBridgeLine, string> = {
    cashSaved: "Saved incl. retirement",
    investmentGrowth: "Investment growth, net of fees",
    outsideMoney: "Money from outside the tracked accounts",
    newlyTracked: "Balances first on file",
    inTransit: "Transfers in transit",
    unexplainedSavings: "Statements vs. paycheck math (timing)",
    total: "Change in net worth",
  };
  const parts = BRIDGE_LINES.filter((l) => l !== "total");
  const whole: ProofBlock = {
    kind: "chain",
    title: "The whole bridge",
    lines: [
      ...startChain(parts.map((l) => signed(b[l], LABEL[l], "derived", l === ln ? {} : { link: bridgeLink(LABEL[l], yr, l) }))),
      line("=", "Change in net worth", b.total, "derived", ln === "total" ? {} : { link: bridgeLink("The bridge", yr, "total") }),
    ],
  };
  const describes = `${LABEL[ln]} · ${y.label}`;
  switch (ln) {
    case "cashSaved":
      return chainProof(describes, b.cashSaved, "From the paycheck math", [line(undefined, "Saved incl. retirement", cash.waterfall.saved, "derived", { link: cashLink("Saved incl. retirement", yr, "saved") }), line("=", LABEL[ln], b.cashSaved, "derived")], { ...base, blocks: [whole] });
    case "investmentGrowth":
      return chainProof(
        describes,
        b.investmentGrowth,
        "Market change less dividends already counted",
        startChain([
          line("+", "Market change net of fees, every account", h.growthNetOfFeesCents, estimated ? "estimate" : "proven", { link: nwChangeLink("Market change"), note: h.feesCents ? `Fees ${money(h.feesCents)}.` : undefined }),
          line("−", "Brokerage dividends counted as income above", dividends, "proven", { link: cashLink("Investment & other income", yr, "other-income") }),
          line("=", LABEL[ln], b.investmentGrowth, "derived"),
        ]),
        { ...base, blocks: [whole] },
      );
    case "outsideMoney": {
      const cfCents = (cf.period?.externalByCategory ?? []).reduce((s, x) => s + x.cents, 0);
      const lines: ChainLine[] = [line(undefined, "Outside money on Cash flow", cfCents, "proven", { link: { label: `Outside money, ${y.label}`, descriptor: cf.d("external") } })];
      if (h.externalCents !== cfCents) lines.push(signed(h.externalCents - cfCents, "Counted by the day the ledger books each row", "derived", { note: BOOKED_DAY }));
      lines.push(line("=", LABEL[ln], b.outsideMoney, "derived"));
      return chainProof(describes, b.outsideMoney, "Partner money, untracked accounts, international transfers", lines, { ...base, blocks: [whole] });
    }
    case "newlyTracked": {
      const name = new Map(c.book.accounts.map((a) => [a.id, a.name]));
      const lines = startChain(period.byAccount.filter((a) => a.newlyTrackedCents !== 0).map((a) => signed(a.newlyTrackedCents, name.get(a.accountId) ?? a.accountId, "proven", { note: "What it held when its first statement on file begins." })));
      lines.push(line("=", LABEL[ln], b.newlyTracked, "derived", { link: nwChangeLink("Balances first on file") }));
      return chainProof(describes, b.newlyTracked, "Accounts first on file this year", lines, { ...base, blocks: [whole] });
    }
    case "inTransit": {
      const lines: ChainLine[] = startChain([
        signed(h.transferResidualCents, "Between your own accounts, mid-move across the year's ends", "proven", { link: nwChangeLink("Transfers in transit") }),
        signed(h.unexplainedCents, "Not explained by statements", "estimate"),
        signed(y.netWorth!.inTransit, `Matched transfers in flight, ${y.netWorthAsOf}`, "proven", { link: nwLink("In transit", yr, "in-transit") }),
        signed(-prev.netWorth.inTransit, `Matched transfers in flight, ${prev.netWorthAsOf}`, "proven", { link: nwLink("In transit a year earlier", prev.year, "in-transit") }),
      ]);
      lines.push(line("=", LABEL[ln], b.inTransit, "derived"));
      return chainProof(describes, b.inTransit, "A transfer whose other leg lands in the next year", lines, { ...base, blocks: [whole] });
    }
    case "unexplainedSavings": {
      const lines: ChainLine[] = startChain([
        line("+", "Income on statements", h.incomeCents, "proven", { link: nwChangeLink("Income") }),
        signed(h.spendingCents, "Spending on statements", "proven", { link: nwChangeLink("Spending") }),
        line("+", "Retirement contributions from pay", h.retirementEmployeeCents, "proven"),
        line("+", "Employer retirement contributions", h.retirementEmployerCents, "proven"),
        line("=", "Saved according to statements", b.savedPerStatements, "derived"),
        line("+", "Brokerage dividends (income on brokerage statements, not bank rows)", dividends, "proven", { link: cashLink("Investment & other income", yr, "other-income") }),
        line("−", "Saved incl. retirement, by the paycheck math", b.cashSaved, "derived", { link: cashLink("Saved incl. retirement", yr, "saved") }),
        line("=", LABEL[ln], b.unexplainedSavings, "derived"),
      ]);
      const timing = cash.timing ?? 0;
      const split: ProofBlock[] = timing
        ? [
            {
              kind: "chain",
              title: "Of which",
              lines: startChain([
                signed(timing, "Rent and bills booked this year that Cash flow counts in the month they pay for", "proven", { note: "The cash figures above follow Cash flow; net worth follows the day each row is booked." }),
                signed(b.unexplainedSavings - timing, "Contributions posted after the year's last paycheck, and other timing", "derived"),
              ]).concat([line("=", LABEL[ln], b.unexplainedSavings, "derived")]),
            },
          ]
        : [];
      return chainProof(describes, b.unexplainedSavings, "Statements − paycheck math", lines, {
        ...base,
        blocks: [...split, whole],
        note: "With every check passing this is timing: a 401(k) or HSA contribution posted after the year's last paycheck.",
      });
    }
    case "total":
      return chainProof(describes, b.total, whole.title, whole.lines, {
        ...base,
        blocks: [{ kind: "chain", title: "Against the change in net worth", lines: [line(undefined, "Change in net worth", y.change?.cents ?? 0, "derived", { link: nwLink("Change in net worth", yr, "change") })] }],
      });
  }
}

// ------------------------------------------------------------------- roll-forwards

const ROLL_LABEL: Record<RollLine, string> = {
  opening: "Opening balance",
  employee: "Your contributions",
  employer: "Employer contributions",
  deposits: "Deposits & transfers in",
  withdrawals: "Withdrawals & transfers out",
  "after-contributions": "Balance after net contributions",
  income: "Dividends & interest",
  market: "Net change in market value",
  fees: "Fees",
  closing: "Closing balance",
  return: "Rate of return",
};

function rollWindow(c: Ctx, year: number) {
  const to = `${year}-12-31` < c.book.horizon.netWorth ? `${year}-12-31` : c.book.horizon.netWorth;
  return { from: `${year}-01-01`, to };
}

function rollforwardProof(c: Ctx, a: AccountRollforward, x: RollYear, ln: RollLine): Built {
  const { from, to } = rollWindow(c, x.year);
  const describes = `${a.name} · ${ROLL_LABEL[ln]} · ${x.year === Number(c.book.today.slice(0, 4)) ? `${x.year} YTD` : x.year}`;
  if (x.blockers.length) return withheld(describes, x.blockers, to);
  const base = { ...nwChecks(c, addDays(from, -1), to, [a.id]), through: to };
  const estimated = x.quality !== "EXACT";
  const rl = (l: RollLine) => (l === ln ? {} : { link: { label: ROLL_LABEL[l], descriptor: { report: "annual", figure: "rollforward", year: x.year, accountId: a.id, line: l } satisfies AnnualDescriptor } });
  const other = x.closing - rollValue(x, "after-contributions") - (x.income ?? 0) - x.marketChange - x.fees - x.unexplained;
  const lines: ChainLine[] = [
    line(undefined, ROLL_LABEL.opening, x.opening, "proven", {
      ...(x.firstOnFile ? { note: "The balance already in the account when its first statement on file begins." } : { link: balanceLink(`${a.name}, ${addDays(from, -1)}`, addDays(from, -1), [a.id]) }),
    }),
  ];
  for (const l of ["employee", "employer", "deposits", "withdrawals"] as const) if (x[l] || l === ln) lines.push(signed(x[l], ROLL_LABEL[l], "proven", rl(l)));
  lines.push(line("=", ROLL_LABEL["after-contributions"], rollValue(x, "after-contributions"), "derived", rl("after-contributions")));
  if (x.income != null) lines.push(signed(x.income, ROLL_LABEL.income, "proven", { ...rl("income"), note: "Year-to-date income printed on the year's last statement." }));
  lines.push(signed(x.marketChange, ROLL_LABEL.market, estimated ? "estimate" : "proven", { ...rl("market"), ...(x.income != null ? { note: "Change in value less the dividends and interest above." } : {}) }));
  if (x.fees || ln === "fees") lines.push(signed(x.fees, ROLL_LABEL.fees, "proven", rl("fees")));
  if (x.unexplained) lines.push(signed(x.unexplained, "Not explained by statements", "estimate", { note: "Coverage missing inside the year: not on the page's lines." }));
  if (other) lines.push(signed(other, "Other money in or out", "proven", { note: "Flows in lanes the page doesn't list." }));
  lines.push(line("=", ROLL_LABEL.closing, x.closing, estimated ? "estimate" : "proven", { link: balanceLink(`${a.name}, ${to}`, to, [a.id]) }));
  const change: NetWorthDescriptor = { report: "net-worth", metric: "change", granularity: "year", start: from, end: to, accountIds: [a.id] };
  // Net worth counts an account first on file this year from $0 (its opening is a balance first on file).
  const blocks: ProofBlock[] = [
    {
      kind: "breakdown",
      title: "In the net-worth proof",
      items: [{ label: `Change over ${x.year}`, ...(x.firstOnFile ? { sub: "from $0: the opening is a balance first on file" } : {}), value: buildNetWorthProof(c.book, change).figure, link: { label: `${a.name}, ${x.year}`, descriptor: change } }],
    },
  ];
  if (ln === "return") {
    const { gainCents, capitalCents } = x.dietz;
    const r = ratioProof(
      describes,
      x.returnRatio,
      [line(undefined, "Gain: closing − opening − money moved in or out", gainCents, estimated ? "estimate" : "proven")],
      line(undefined, "Capital: opening + money moved, each weighted by the share of the year it was invested", capitalCents, "derived"),
      base,
      "under $1,000 invested the page shows no return (too little to measure)",
    );
    return {
      ...r,
      blocks: [...r.blocks, { kind: "chain", title: "The year", lines }, ...blocks],
      ...(x.returnRatio == null ? { describes: `${describes} (under $1,000 invested: no return)` } : {}),
    };
  }
  const figure = rollValue(x, ln);
  if (ln === "closing") return chainProof(describes, figure, "Opening → contributions → market → closing", lines, { ...base, blocks });
  // A part: its own line of the year's chain, and the chain re-adding to the closing balance.
  const own = lines.find((l) => l.label === ROLL_LABEL[ln]);
  const ownCents = own && "cents" in own.value ? (own.op === "−" ? -own.value.cents : own.value.cents) : 0;
  const reAdded = partsBeforeTotal(lines);
  return {
    describes,
    figure: { cents: figure },
    selfCheck:
      reAdded === x.closing
        ? sumCheck(figure, ownCents, `The year's lines re-add to the closing balance, ${money(x.closing)}, and this one is ${money(ownCents)}`)
        : sumCheck(x.closing, reAdded, `The year's lines add up to ${money(reAdded)}, not the closing balance`),
    blocks: [
      { kind: "chain", title: "Opening → contributions → market → closing", lines, note: own ? `${ROLL_LABEL[ln]}: ${money(figure)}.` : undefined },
      ...blocks,
    ],
    ...base,
  };
}

function rollTotalProof(c: Ctx, year: number, ln: RollTotalLine, accounts: AccountRollforward[]): Built {
  const { to } = rollWindow(c, year);
  const label = { closing: "Total invested", contributions: "Contributions (you + employer)", growth: "Income + market change" }[ln];
  const ys = accounts.flatMap((a) => (a.years.some((x) => x.year === year) ? [{ a, x: a.years.find((x) => x.year === year)! }] : []));
  const blockers = [...new Map(ys.flatMap(({ x }) => x.blockers).map((b) => [b.id, b])).values()];
  if (blockers.length) return withheld(`${label} · ${year}`, blockers, to);
  const figure = ys.reduce((s, { x }) => s + rollTotalValue(x, ln), 0);
  const line1 = (l: RollLine) => (x: RollYear, a: AccountRollforward): ProofLink => ({ label: a.name, descriptor: { report: "annual", figure: "rollforward", year, accountId: a.id, line: l } });
  const pick = ln === "closing" ? line1("closing") : ln === "contributions" ? line1("employee") : line1("market");
  const lines = startChain(ys.map(({ a, x }) => signed(rollTotalValue(x, ln), a.name, "proven", { link: pick(x, a) })));
  lines.push(line("=", label, figure, "derived"));
  return chainProof(`${label} · ${year}`, figure, "Every investment account", lines, {
    ...nwChecks(c, addDays(`${year}-01-01`, -1), to, ys.map(({ a }) => a.id)),
    through: to,
    note: ln === "growth" ? "Dividends & interest + market change + fees, each account." : ln === "contributions" ? "Your and your employer's contributions, each account." : undefined,
  });
}

// -------------------------------------------------------------------

export async function loadAnnualProfile(ctx: ProofContext): Promise<AnnualProfileReport> {
  return perBook(ctx, "annual-profile", async () => buildAnnualProfile(ctx.book, await loadProfileSettings(ctx.db), ctx.book.taxProfile.dependents));
}

/** `profile`: the annual profile (roll-forwards don't need it). */
export function buildAnnualProof(book: Book, profile: AnnualProfileReport | null, d: AnnualDescriptor): Proof {
  const wrap = (b: Built): Proof => ({ report: "annual", descriptor: d, today: book.today, ...b, through: b.through || book.horizon.netWorth });
  if (!profile && !d.figure.startsWith("rollforward")) return wrap(notFound("The annual profile isn't loaded."));
  const c = { book, profile } as Ctx;
  if (d.figure === "rollforward" || d.figure === "rollforward-total") {
    const r = buildAccountRollforwards(book);
    if (d.figure === "rollforward-total") return wrap(rollTotalProof(c, d.year, d.line, r.accounts));
    const a = r.accounts.find((x) => x.id === d.accountId);
    const x = a?.years.find((v) => v.year === d.year);
    return wrap(a && x ? rollforwardProof(c, a, x, d.line) : notFound(`No roll-forward for that account in ${d.year}.`));
  }
  const years = profile!.years;
  const i = years.findIndex((y) => y.year === d.year);
  const y = years[i];
  if (!y) return wrap(notFound(`${d.year} isn't on the annual statement.`));
  const nc: NwCtx = { ...c, y, prev: years[i - 1] };
  switch (d.figure) {
    case "cash":
      return wrap(y.cash ? cashProof(c, y, y.cash, d.line) : withheld(`${y.label}: cash flow`, y.blockers.cash, y.asOf));
    case "category":
      return wrap(y.cash ? categoryProof(c, y, y.cash, d.category) : withheld(`${d.category} · ${y.label}`, y.blockers.cash, y.asOf));
    case "net-worth":
      if (d.line === "change" || d.line === "change-pct") return wrap(y.netWorth ? netWorthProof(nc, d.line) : withheld(`Change in net worth · ${y.label}`, y.blockers.change, y.netWorthAsOf));
      return wrap(y.netWorth ? netWorthProof(nc, d.line) : withheld(`${y.label}: net worth`, y.blockers.netWorth, y.netWorthAsOf));
    case "bucket":
      return wrap(y.netWorth ? bucketProof(nc, d.bucket) : withheld(`${bucketLabel(d.bucket)} · ${y.label}`, y.blockers.netWorth, y.netWorthAsOf));
    case "bridge":
      return wrap(y.bridge ? bridgeProof(nc, d.line) : withheld(`${y.label}: what changed net worth`, [...new Map([...y.blockers.cash, ...y.blockers.change].map((b) => [b.id, b])).values()], y.netWorthAsOf));
  }
}

export const annualKind: ProofKind<AnnualDescriptor> = {
  report: "annual",
  parse: parseAnnualDescriptor,
  build: async (ctx, d) => buildAnnualProof(ctx.book, d.figure.startsWith("rollforward") ? null : await loadAnnualProfile(ctx), d),
};
