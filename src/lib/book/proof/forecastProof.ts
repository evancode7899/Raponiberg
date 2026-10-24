import { addDays, startOfMonth } from "../../dates/isoDate.ts";
import { formatPercentRatio, formatUsdFromCents } from "../../formatMoney.ts";
import { buildForecast, type Forecast } from "../../forecast/forecast.ts";
import { monthPeriods, yearPeriods, type Flows, type Period } from "../../forecast/periods.ts";
import type { AnnualProfileReport } from "../../profile/buildAnnualProfile.ts";
import { grow, monthlyReturn, type OutlookMonth } from "../../profile/outlook.ts";
import { forecastInputs, loadForecastData, type ForecastData } from "../../forecast/load.ts";
import { bucketForGroup } from "../../profile/annualMath.ts";
import { resolveBasePay, type DeferralParts, type LivingTrail, type OutlookSeeds, type ResolvedBasePay } from "../../profile/basePay.ts";
import { BUCKETS, DEFAULT_PERSON_OUTLOOK, type LivingBasis, type OutlookAssumptions, type PaycheckBasis } from "../../profile/settings.ts";
import { TAX_YEARS } from "../../tax/params.ts";
import { chainReturns } from "../../ledger/timeline.ts";
import { inclusiveDays } from "../../dates/isoDate.ts";
import type { Book } from "../load.ts";
import { buildNetWorth } from "../reports/netWorth.ts";
import { buildCashFlowProof, CASH_FLOW_CHECKS, type CashFlowDescriptor } from "./cashFlowProof.ts";
import { checksFor, perBook, sumCheck } from "./common.ts";
import { buildNetWorthProof, NET_WORTH_CHECKS, type NetWorthDescriptor } from "./netWorthProof.ts";
import { PAY_CHECKS, type PayDescriptor } from "./payProof.ts";
import type { BonusesDescriptor } from "./bonusesProof.ts";
import type { ChainLine, Proof, ProofBlock, ProofCheck, ProofEstimate, ProofKind, ProofLink } from "./types.ts";

/**
 * The proof behind the figures the forecast starts from (its seeds, buildAnnualProfile →
 * OutlookSeeds), each as a chain re-derived through the same code the Forecast page runs
 * (loadForecastData, resolveBasePay, buildForecast), never a copy:
 *
 *  - start: the latest proven net worth, liquid and illiquid, each side opening the
 *    net-worth proof of those accounts on that day, plus transfers in flight.
 *  - pay: one person's base salary (a paycheck × paychecks a year, the check opening its
 *    pay proof), this year's 401(k)/HSA deferrals to Dec 31 and the employer's money.
 *  - deferrals / employer: the household's figures the drivers show, person by person.
 *  - take-home: base salary less tax under the law year used, less benefit deductions.
 *  - living: Cash flow's spending over the basis's window, less tax payments, tagged
 *    one-offs and reimbursements (the year in progress then annualized).
 *  - return: the realized portfolio return, year by year, each opening its change proof.
 *  - bonus: what the forecast pays as bonuses: on stubs, scheduled by letters, estimated.
 *
 * What the owner typed on the Forecast page (a salary, a living cost, rates) is marked
 * "assumption" where it enters a seed-derived figure, beside the seed; the saved drivers
 * are used (the page's unsaved edits aren't on the server).
 *
 * `figure: "seed"` names a starting figure; `figure: "month"` one cell of the forecast
 * ledger (see LedgerLine).
 */

export type ForecastSeed = "start" | "pay" | "deferrals" | "employer" | "take-home" | "living" | "return" | "bonus";

/**
 * The lines of the forecast ledger (ForecastLedger.tsx), named as lib/forecast/periods.ts
 * Flows names them, plus the closing balances. Money in the figure's own sign: outflows
 * (taxes, living, bonusSpent, oneOffs) are positive amounts the page shows negated.
 *
 *  - salary: base salary · bonus: bonuses, gross · otherIncome: interest & other (actual only, 0 in the forecast)
 *  - taxes: income tax, FICA and payroll deductions · employer: employer 401(k) & HSA money
 *  - living: living cost · bonusSpent: bonus kept after tax but not saved · oneOffs: one-off expenses
 *  - saved: income − taxes + employer − spending · toRetirement: deferrals + employer money · toLiquid: saved − toRetirement
 *  - growth: investment returns (actual: the change not explained by saved) · change: change in net worth
 *  - netWorth / liquid / illiquid: balances at the end of the column
 */
export type LedgerLine =
  | "salary"
  | "bonus"
  | "otherIncome"
  | "taxes"
  | "employer"
  | "living"
  | "bonusSpent"
  | "oneOffs"
  | "saved"
  | "toRetirement"
  | "toLiquid"
  | "growth"
  | "change"
  | "netWorth"
  | "liquid"
  | "illiquid";

export const LEDGER_LINES: Record<LedgerLine, string> = {
  salary: "Base salary",
  bonus: "Bonuses",
  otherIncome: "Interest & other",
  taxes: "Taxes & deductions",
  employer: "Employer 401(k) & HSA",
  living: "Living cost",
  bonusSpent: "Bonus spent",
  oneOffs: "One-offs",
  saved: "Saved",
  toRetirement: "Saved to retirement",
  toLiquid: "Saved to liquid",
  growth: "Growth & other",
  change: "Change in net worth",
  netWorth: "Net worth",
  liquid: "Liquid",
  illiquid: "Illiquid",
};

export type ForecastDescriptor =
  | { report: "forecast"; figure: "seed"; which: "start" | "return" | "bonus" }
  | { report: "forecast"; figure: "seed"; which: "pay"; personId: string; paycheck: PaycheckBasis }
  /** `paycheck`: each person's paycheck choice on the page (the saved one for anyone not listed). */
  | { report: "forecast"; figure: "seed"; which: "deferrals" | "employer" | "take-home"; paycheck?: Record<string, PaycheckBasis> }
  | { report: "forecast"; figure: "seed"; which: "living"; basis: LivingBasis }
  /**
   * One cell of the forecast ledger, on the saved drivers: `line` over the column that
   * runs from `month` through `through` (YYYY-MM; omitted for a single month). The columns
   * the ledger draws (lib/forecast/periods.ts yearPeriods / monthPeriods):
   *  - a forecast month (after the start): { month: "2027-08" } — projected;
   *  - a forecast year or the rest of the year in progress: { month: "2027-01", through: "2027-12" } / { month: "2026-04", through: "2026-12" };
   *  - the year in progress' total, actual to date + forecast rest: { month: "2026-01", through: "2026-12" };
   *  - an actual (proven) year, or the year to date: { month: "2025-01", through: "2025-12" } / { month: "2026-01", through: "2026-03" }.
   * Any other span isn't a column: the proof says so.
   */
  | { report: "forecast"; figure: "month"; month: string; through?: string; line: LedgerLine };

const BASES: PaycheckBasis[] = ["LATEST", "TYPICAL"];
const LIVING: LivingBasis[] = ["TRAILING_12", "LAST_YEAR", "THIS_YEAR"];
const isMonth = (v: unknown): v is string => typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

export function parseForecastDescriptor(d: Record<string, unknown>): ForecastDescriptor | { error: string } {
  if (d.figure === "month") {
    if (!isMonth(d.month)) return { error: "month must be YYYY-MM." };
    if (d.through != null && (!isMonth(d.through) || d.through < d.month)) return { error: "through must be YYYY-MM, at or after month." };
    if (typeof d.line !== "string" || !Object.hasOwn(LEDGER_LINES, d.line)) return { error: `line must be one of: ${Object.keys(LEDGER_LINES).join(", ")}.` };
    return { report: "forecast", figure: "month", month: d.month, ...(d.through && d.through !== d.month ? { through: d.through as string } : {}), line: d.line as LedgerLine };
  }
  if (d.figure !== "seed") return { error: "figure must be seed or month." };
  switch (d.which) {
    case "start":
    case "return":
    case "bonus":
      return { report: "forecast", figure: "seed", which: d.which };
    case "pay":
      if (typeof d.personId !== "string" || !d.personId) return { error: "personId must be an id." };
      if (!BASES.includes(d.paycheck as PaycheckBasis)) return { error: "paycheck must be LATEST or TYPICAL." };
      return { report: "forecast", figure: "seed", which: "pay", personId: d.personId, paycheck: d.paycheck as PaycheckBasis };
    case "deferrals":
    case "employer":
    case "take-home": {
      if (d.paycheck != null && (typeof d.paycheck !== "object" || Array.isArray(d.paycheck) || Object.values(d.paycheck).some((v) => !BASES.includes(v as PaycheckBasis))))
        return { error: "paycheck must map person ids to LATEST or TYPICAL." };
      const paycheck = d.paycheck as Record<string, PaycheckBasis> | undefined;
      return { report: "forecast", figure: "seed", which: d.which, ...(paycheck && Object.keys(paycheck).length ? { paycheck } : {}) };
    }
    case "living":
      if (!LIVING.includes(d.basis as LivingBasis)) return { error: `basis must be one of: ${LIVING.join(", ")}.` };
      return { report: "forecast", figure: "seed", which: "living", basis: d.basis as LivingBasis };
  }
  return { error: "which must be start, pay, deferrals, employer, take-home, living, return or bonus." };
}

// ---------------------------------------------------------------------------

const money = (c: number) => (c === 0 ? "$0.00" : formatUsdFromCents(c));
const pct = (r: number) => formatPercentRatio(r, 2);
const dsum = (d: DeferralParts) => d.k401Pretax + d.k401Roth + d.hsa;
const dnote = (d: DeferralParts) =>
  [d.k401Pretax && `401(k) pre-tax ${money(d.k401Pretax)}`, d.k401Roth && `Roth ${money(d.k401Roth)}`, d.hsa && `HSA ${money(d.hsa)}`].filter(Boolean).join(" · ") || "none";
const BASIS_WORD: Record<PaycheckBasis, string> = { LATEST: "Latest", TYPICAL: "Typical" };
const SAVED = "The forecast uses the saved drivers: edits not saved on the Forecast page aren't in this proof.";

/** A signed adjustment as a chain line: "+" or "−" by its sign, the value shown positive. */
const signed = (cents: number, line: Omit<ChainLine, "op" | "value">): ChainLine => ({ ...line, op: cents < 0 ? "−" : "+", value: { cents: Math.abs(cents) } });

type Ctx = { book: Book; data: ForecastData; seeds: OutlookSeeds; a: OutlookAssumptions };

type Built = Omit<Proof, "report" | "descriptor" | "today" | "checks" | "withheld"> & { checks?: ProofCheck[]; withheld?: boolean };

/** The drivers with each listed person's paycheck choice put in. */
function withPaychecks(a: OutlookAssumptions, seeds: OutlookSeeds, paycheck: Record<string, PaycheckBasis> = {}): OutlookAssumptions {
  const people = { ...a.people };
  for (const p of seeds.people) if (paycheck[p.personId]) people[p.personId] = { ...DEFAULT_PERSON_OUTLOOK, ...people[p.personId], paycheck: paycheck[p.personId]! };
  return { ...a, people };
}

const resolve = (c: Ctx, a: OutlookAssumptions): ResolvedBasePay => resolveBasePay(c.seeds, a, TAX_YEARS[c.seeds.taxYear]!);

// ------------------------------------------------------------------- start

/**
 * One side of net worth on a day (liquid or illiquid) as a chain: the net-worth proof of
 * that side's accounts, plus transfers in flight to it, = the side's figure.
 */
function balanceSide(book: Book, date: string, want: boolean, transit: { liquid: number; illiquid: number }, cents: number): { block: ProofBlock; parts: number } {
  const liquid = new Set(BUCKETS.filter((b) => b.liquid).map((b) => b.id));
  const accountIds = book.ledger.accounts.filter((x) => liquid.has(bucketForGroup(x.group)) === want).map((x) => x.id);
  let acc = { cents: 0, link: undefined as ProofLink | undefined };
  if (accountIds.length) {
    const descriptor: NetWorthDescriptor = { report: "net-worth", metric: "balance", date, accountIds };
    const p = buildNetWorthProof(book, descriptor);
    acc = { cents: "cents" in p.figure ? p.figure.cents : 0, link: { label: `${want ? "Liquid" : "Illiquid"} accounts on ${date}`, descriptor } };
  }
  const t = want ? transit.liquid : transit.illiquid;
  const lines: ChainLine[] = [
    {
      label: want ? "Cash and taxable investments, less card balances" : "Retirement, HSA and everything else, less long-term debt",
      value: { cents: acc.cents },
      source: "proven",
      note: `Every such account's balance at the end of ${date}, read off its statements.`,
      ...(acc.link ? { link: acc.link } : {}),
    },
  ];
  if (t) lines.push(signed(t, { label: "Transfers in flight to these accounts", source: "derived", note: "Matched transfers that had left one account but not reached the other count on the side they were going to." }));
  lines.push({ op: "=", label: want ? "Liquid" : "Illiquid", value: { cents }, source: "derived" });
  return { block: { kind: "chain", title: want ? "Liquid" : "Illiquid", lines }, parts: acc.cents + t };
}

function startProof(c: Ctx): Built {
  const { book, seeds } = c;
  const s = seeds.start;
  const transit = s.inTransit ?? { liquid: 0, illiquid: 0 };
  const l = balanceSide(book, s.asOf, true, transit, s.liquid);
  const i = balanceSide(book, s.asOf, false, transit, s.illiquid);
  const total = s.liquid + s.illiquid;
  const parts = l.parts + i.parts;
  const sum: ProofBlock = {
    kind: "chain",
    title: "Starting net worth",
    lines: [
      { label: "Liquid", value: { cents: s.liquid }, source: "derived" },
      { op: "+", label: "Illiquid", value: { cents: s.illiquid }, source: "derived" },
      { op: "=", label: `Net worth at the end of ${s.asOf}`, value: { cents: total }, source: "proven", note: s.note },
    ],
    note: "The forecast grows liquid money (savings, bonuses kept) and illiquid money (401(k)/HSA, employer money) separately from here.",
  };
  const { checks, withheld } = checksFor(book, { affects: "NET_WORTH", from: s.asOf, to: s.asOf }, NET_WORTH_CHECKS);
  return {
    describes: `The forecast's starting net worth, end of ${s.asOf}`,
    figure: { cents: total },
    selfCheck: sumCheck(total, parts, `The accounts' balances on ${s.asOf} (each side opens its net-worth proof) and transfers in flight add up to ${money(parts)}`),
    blocks: [sum, l.block, i.block],
    checks,
    withheld,
    estimates: [],
    through: s.asOf,
  };
}

// ------------------------------------------------------------------- pay

const payLink = (label: string, d: PayDescriptor): ProofLink => ({ label, descriptor: d });

function payProof(c: Ctx, personId: string, basis: PaycheckBasis): Built {
  const { seeds, book } = c;
  const seed = seeds.people.find((p) => p.personId === personId);
  if (!seed) return notFound(`No one in the household has the id ${personId}.`);
  const a = withPaychecks(c.a, seeds, { [personId]: basis });
  const p = resolve(c, a).people.find((x) => x.personId === personId)!;
  const check = p.paycheck;
  const t = seed.trail;
  if (!check || !t) {
    return {
      describes: `${seed.name} · base salary from the stubs`,
      figure: { cents: 0 },
      selfCheck: sumCheck(0, 0, "No paycheck on file: the forecast's base salary for this person is $0"),
      blocks: [{ kind: "chain", title: "Base salary", lines: [{ label: seed.note, value: { cents: 0 }, source: "proven" }] }],
      estimates: [],
      through: book.horizon.cashFlow,
    };
  }
  const who = { personId, employerKeys: [t.employerKey] };
  const paidOn = (date: string): PayDescriptor => ({ report: "pay", basis: "paid", ...who, lines: ["base"], start: date, end: date });
  const fromCheck = check.regular * p.perYear;
  // The check resolveBasePay took (the other one when the chosen basis has none).
  const usedBasis: PaycheckBasis = check === seed.typical ? "TYPICAL" : "LATEST";
  const blocks: ProofBlock[] = [
    {
      kind: "chain",
      title: "Base salary",
      lines: [
        {
          label: `${BASIS_WORD[usedBasis]} regular check, ${check.payDate}`,
          value: { cents: check.regular },
          source: "proven",
          note: `${t.employer}: regular earnings on the stub, no bonus.`,
          link: payLink(`${check.payDate} paycheck`, paidOn(check.payDate)),
        },
        {
          op: "×",
          label: `Paychecks a year (${(seed.frequency ?? "").toLowerCase()})`,
          value: { text: String(p.perYear) },
          source: "derived",
          note: `Read off the pay period on the ${t.frequencyFrom.payDate} stub${t.frequencyFrom.periodStart ? ` (${t.frequencyFrom.periodStart} – ${t.frequencyFrom.periodEnd})` : ""}.`,
        },
        { op: "=", label: "Base salary from the check", value: { cents: fromCheck }, source: "derived" },
      ],
      note: seed.note,
    },
  ];
  if (usedBasis === "TYPICAL" && t.recent.length > 1)
    blocks.push({
      kind: "breakdown",
      title: "The last regular checks (typical = the median by gross)",
      items: t.recent.map((r) => ({
        label: r.payDate,
        sub: r.payDate === check.payDate ? "the typical check" : `gross ${money(r.gross)}`,
        value: { cents: r.regular },
        link: payLink(`${r.payDate} paycheck`, paidOn(r.payDate)),
      })),
    });

  // This year's deferrals to Dec 31 on the chosen check.
  const def = t.deferrals[p.basis];
  const ytd = dsum(def.ytd);
  const rest = def.checks * dsum(def.perCheck);
  const limit = dsum(def.projected) - ytd - rest;
  const deferralLines: ChainLine[] = [
    {
      label: `Year to date on the ${def.throughStub} stub`,
      value: { cents: ytd },
      source: "proven",
      note: dnote(def.ytd),
      link: payLink(`${t.employer} deferrals, ${t.payYear}`, { report: "pay", basis: "ytd", ...who, lines: ["deferrals"], year: t.payYear, through: def.throughStub }),
    },
  ];
  if (def.checks) deferralLines.push({ op: "+", label: `${def.checks} more paychecks to Dec 31 × ${money(dsum(def.perCheck))}`, value: { cents: rest }, source: "estimate", note: `The ${BASIS_WORD[p.basis].toLowerCase()} check's ${dnote(def.perCheck)}, repeated.` });
  if (limit) deferralLines.push(signed(limit, { label: `Payroll stops them at the ${seeds.taxYear} annual limits`, source: "law" }));
  for (const o of def.others)
    deferralLines.push({
      op: "+",
      label: `${o.employer}, year to date (${o.through})`,
      value: { cents: dsum(o.d) },
      source: "proven",
      note: dnote(o.d),
      link: payLink(`${o.employer} deferrals`, { report: "pay", basis: "ytd", personId, employerKeys: [o.employerKey], lines: ["deferrals"], year: t.payYear, through: o.through }),
    });
  const seedDeferrals = dsum(seed.deferrals[p.basis]);
  deferralLines.push({ op: "=", label: `401(k) and HSA deferrals, ${t.payYear}`, value: { cents: seedDeferrals }, source: "derived" });
  if (p.deferrals !== seedDeferrals) deferralLines.push({ label: "Held to 90% of base salary in the forecast", value: { cents: p.deferrals }, source: "derived" });
  blocks.push({ kind: "chain", title: "Your 401(k) and HSA deferrals", lines: deferralLines, note: t.payYear === seeds.currentYear ? "To Dec 31: the stubs so far, then the chosen check repeated for every pay date left." : `No ${seeds.currentYear} stubs yet: ${t.payYear}'s year to date.` });

  // Employer money rides on each check (scaled when a salary is typed).
  const employerFromCheck = Math.round(check.employer * p.perYear);
  const employerLines: ChainLine[] = [
    { label: `Employer 401(k) and HSA money on the ${check.payDate} check`, value: { cents: check.employer }, source: "proven", note: "As the stub prints it." },
    { op: "×", label: "Paychecks a year", value: { text: String(p.perYear) }, source: "derived" },
    { op: "=", label: "Employer money a year", value: { cents: employerFromCheck }, source: "derived" },
  ];
  if (p.salaryTyped && p.employer !== employerFromCheck)
    employerLines.push({ op: "×", label: "Scaled by the salary you typed ÷ the salary from the check", value: { ratio: fromCheck > 0 ? p.salary / fromCheck : 0 }, source: "assumption" }, { op: "=", label: "Employer money in the forecast", value: { cents: p.employer }, source: "derived" });
  blocks.push({ kind: "chain", title: "Employer 401(k) and HSA money", lines: employerLines });

  const drivers: ChainLine[] = [];
  if (p.salaryTyped) drivers.push({ label: "Base salary you typed", value: { cents: p.salary }, source: "assumption", note: `From the check it would be ${money(fromCheck)}.` });
  drivers.push({ label: "Raise / yr", value: { ratio: c.a.salaryGrowth }, source: "assumption", note: `Applied each January from ${seeds.start.year + 1} to base salary and the 401(k)/HSA money riding on it.` });
  blocks.push({ kind: "chain", title: "In the forecast", lines: drivers, note: SAVED });

  const { checks, withheld } = checksFor(book, { affects: "PAY", from: `${t.payYear}-01-01`, to: def.throughStub, personId, employerKeys: [t.employerKey] }, PAY_CHECKS);
  const estimates: ProofEstimate[] = def.checks
    ? [{ id: `forecast.deferrals:${personId}`, title: `${seed.name}'s deferrals for the ${def.checks} pay dates left in ${t.payYear}`, detail: "The chosen check's 401(k) and HSA lines, repeated until the annual limits." }]
    : [];
  return {
    describes: `${seed.name} · base salary from the ${BASIS_WORD[p.basis].toLowerCase()} check`,
    figure: { cents: fromCheck },
    selfCheck: sumCheck(fromCheck, check.regular * Number(p.perYear), `${money(check.regular)} × ${p.perYear} paychecks is ${money(check.regular * p.perYear)}`),
    blocks,
    checks,
    withheld,
    estimates,
    through: def.throughStub,
  };
}

// ------------------------------------------------------------------- household pay figures

function householdPay(c: Ctx, which: "deferrals" | "employer", paycheck?: Record<string, PaycheckBasis>): Built {
  const pay = resolve(c, withPaychecks(c.a, c.seeds, paycheck));
  const word = which === "deferrals" ? "401(k) and HSA deferrals" : "Employer 401(k) and HSA money";
  const lines: ChainLine[] = pay.people.map((p, i) => ({
    op: i ? ("+" as const) : undefined,
    label: p.name,
    value: { cents: which === "deferrals" ? p.deferrals : p.employer },
    source: "derived" as const,
    note: `From the ${BASIS_WORD[p.basis].toLowerCase()} check's stubs.`,
    link: { label: `${p.name}'s pay`, descriptor: { report: "forecast", figure: "seed", which: "pay", personId: p.personId, paycheck: p.basis } },
  }));
  const fromStubs = lines.reduce((t, l) => t + ("cents" in l.value ? l.value.cents : 0), 0);
  lines.push({ op: "=", label: `Household ${word.toLowerCase()} a year`, value: { cents: fromStubs }, source: "derived" });
  const typed = which === "deferrals" ? pay.deferralsTyped : pay.employerTyped;
  const blocks: ProofBlock[] = [{ kind: "chain", title: word, lines }];
  if (typed) blocks.push({ kind: "chain", title: "In the forecast", lines: [{ label: `${word} you typed`, value: { cents: which === "deferrals" ? pay.deferrals : pay.employer }, source: "assumption", note: `From the stubs it would be ${money(fromStubs)}.` }], note: SAVED });
  return {
    describes: `${word}, from the stubs`,
    figure: { cents: fromStubs },
    selfCheck: sumCheck(fromStubs, pay.people.reduce((t, p) => t + (which === "deferrals" ? p.deferrals : p.employer), 0), `Each person's figure (each opens their pay proof) adds up to ${money(fromStubs)}`),
    blocks,
    estimates: [],
    through: c.book.horizon.cashFlow,
  };
}

function takeHomeProof(c: Ctx, paycheck?: Record<string, PaycheckBasis>): Built {
  const { seeds } = c;
  const pay = resolve(c, withPaychecks(c.a, seeds, paycheck));
  const t = pay.tax;
  const lines: ChainLine[] = pay.people.map((p, i) => ({
    op: i ? ("+" as const) : undefined,
    label: `${p.name}'s base salary`,
    value: { cents: p.salary },
    source: p.salaryTyped ? ("assumption" as const) : ("derived" as const),
    ...(p.salaryTyped ? { note: "Typed on the Forecast page." } : {}),
    link: { label: `${p.name}'s pay`, descriptor: { report: "forecast", figure: "seed", which: "pay", personId: p.personId, paycheck: p.basis } },
  }));
  lines.push(
    { op: "=", label: "Household base salary", value: { cents: pay.salary }, source: "derived" },
    { op: "−", label: "Federal income tax", value: { cents: t.federal }, source: "law", note: `${seeds.taxYear} brackets, filing jointly, standard deduction ${money(seeds.tax.standardDeduction)}.` },
    { op: "−", label: "Connecticut income tax", value: { cents: t.ct }, source: "law" },
    { op: "−", label: "Social Security", value: { cents: t.socialSecurity }, source: "law" },
    { op: "−", label: "Medicare", value: { cents: t.medicare }, source: "law" },
    { op: "−", label: "CT paid leave", value: { cents: t.pfml }, source: "law" },
    { op: "−", label: "Health, FSA and dependent-care deductions (pre-tax)", value: { cents: pay.section125 }, source: "derived", note: "Each person's check × paychecks a year." },
    { op: "−", label: "After-tax deductions", value: { cents: pay.afterTax }, source: "derived", note: "Each person's check × paychecks a year." },
    { op: "=", label: "Take-home from base pay", value: { cents: pay.takeHome }, source: "derived", note: "401(k)/HSA deferrals stay in: they're savings." },
    { op: "÷", label: "Household base salary", value: { cents: pay.salary }, source: "derived" },
    { op: "=", label: "Kept after tax", value: { ratio: pay.computedRate }, source: "derived" },
  );
  const law: ChainLine[] = [
    { label: "Tax law year", value: { text: String(seeds.taxYear) }, source: "law", note: `Today's law: the latest year on file through ${seeds.currentYear}. Pay and the retirement brackets both use it.` },
    { label: "Dependents", value: { text: String(seeds.dependents.length) }, source: "assumption", note: "From Settings › tax profile." },
    { label: "Inflation / yr", value: { ratio: c.a.inflation }, source: "assumption", note: "Indexes the standard deduction and brackets in retirement." },
    { label: "State tax on retirement draws", value: c.a.stateTaxRate == null ? { text: "Connecticut's brackets" } : { ratio: c.a.stateTaxRate }, source: c.a.stateTaxRate == null ? "law" : "assumption" },
    { label: "Withdrawal rate once retired", value: { ratio: c.a.withdrawalRate }, source: "assumption" },
  ];
  const blocks: ProofBlock[] = [{ kind: "chain", title: "Base pay after tax", lines }];
  if (pay.rateTyped) blocks.push({ kind: "chain", title: "In the forecast", lines: [{ label: "Kept after tax you typed", value: { ratio: pay.takeHomeRate }, source: "assumption", note: `Computed it would be ${pct(pay.computedRate)}.` }], note: SAVED });
  blocks.push({ kind: "chain", title: "Law and settings", lines: law });
  const parts = pay.salary - t.federal - t.ct - t.socialSecurity - t.medicare - t.pfml - pay.section125 - pay.afterTax;
  return {
    describes: "Share of base salary kept after tax",
    figure: { ratio: pay.computedRate },
    selfCheck: sumCheck(pay.takeHome, parts, `Base salary less each tax and deduction comes to ${money(parts)} of take-home`),
    blocks,
    estimates: [],
    through: c.book.horizon.cashFlow,
  };
}

// ------------------------------------------------------------------- living cost

/**
 * A living-cost window's lines: Cash flow's spending over it (linked), the booking-day
 * difference, less tax payments, tagged one-offs and reimbursements, = the window's
 * living cost. `recomputed`: what those parts re-add to.
 */
function livingLines(book: Book, t: LivingTrail): { lines: ChainLine[]; recomputed: number } {
  const calendar = t.from.endsWith("-01-01");
  const cf: CashFlowDescriptor = { report: "cash-flow", metric: "spending", granularity: calendar ? "year" : "month", start: calendar ? t.from : startOfMonth(t.from), end: t.to };
  const cfCents = buildCashFlowProof(book, cf).figureCents;
  const oneOffs = t.oneOffs.reduce((s, o) => s + o.cents, 0) + t.oneOffCategories.reduce((s, o) => s + o.cents, 0);
  const booked = t.spending + t.taxPayments + oneOffs;
  const lines: ChainLine[] = [
    { label: `Spending on Cash flow, ${cf.start} – ${t.to}`, value: { cents: cfCents }, source: "proven", link: { label: "Spending", descriptor: cf } },
  ];
  if (booked !== cfCents)
    lines.push(
      signed(booked - cfCents, {
        label: "Counted by the day the ledger books each row",
        source: "derived",
        note: [
          "Cash flow counts rent in the month it pays for and spreads a statement's period totals over its days; this figure takes each row whole on the day it's booked.",
          calendar ? "" : `Rows ${cf.start} – ${addDays(t.from, -1)} are before the window.`,
        ]
          .filter(Boolean)
          .join(" "),
      }),
    );
  if (t.taxPayments) lines.push({ op: "−", label: "Tax payments (taxes, not living)", value: { cents: t.taxPayments }, source: "proven" });
  for (const o of t.oneOffs)
    lines.push({ op: "−", label: `${o.date} ${o.payee}`, value: { cents: o.cents }, source: "proven", note: [o.category, o.account, o.label && `“${o.label}”`, "tagged by you as a one-off"].filter(Boolean).join(" · ") });
  for (const o of t.oneOffCategories)
    lines.push({ op: "−", label: `${o.category} (${o.rows} row${o.rows === 1 ? "" : "s"})`, value: { cents: o.cents }, source: "proven", note: "A category you count as one-offs." });
  if (t.reimbursements) lines.push(signed(-t.reimbursements, { label: "Reimbursements received (Zelle, Venmo…)", source: "proven" }));
  if (t.payReimbursements) lines.push(signed(-t.payReimbursements, { label: "Reimbursements paid inside paychecks", source: "proven" }));
  lines.push({ op: "=", label: `Living cost, ${t.from} – ${t.to}`, value: { cents: t.windowCents }, source: "derived" });
  return { lines, recomputed: cfCents + (booked - cfCents) - t.taxPayments - oneOffs - t.reimbursements - t.payReimbursements };
}

function livingProof(c: Ctx, basis: LivingBasis): Built {
  const { book, seeds } = c;
  const seed = seeds.living[basis];
  if (!seed?.trail) return notFound(`There's no ${basis} living-cost figure: its window isn't proven.`);
  const t = seed.trail;
  const living = livingLines(book, t);
  const lines = living.lines;
  let recomputed = living.recomputed;
  if (t.rest) {
    // The rest of the year as it went last year, its own window re-added the same way.
    const rest = livingLines(book, t.rest);
    lines.push(
      { op: "+", label: `The rest of the year as last year, ${t.rest.from} – ${t.rest.to}`, value: { cents: t.rest.windowCents }, source: "proven", note: "Last year's actual months for the part of the year still to come." },
      { op: "=", label: "This year, so far + the rest", value: { cents: seed.cents }, source: "derived" },
    );
    recomputed += rest.recomputed;
  }
  const blocks: ProofBlock[] = [{ kind: "chain", title: seed.label, lines, note: seed.detail }];
  const others = LIVING.filter((b) => b !== basis && seeds.living[b]);
  if (others.length)
    blocks.push({
      kind: "breakdown",
      title: "The other bases",
      items: others.map((b) => ({ label: seeds.living[b]!.label, value: { cents: seeds.living[b]!.cents }, link: { label: seeds.living[b]!.label, descriptor: { report: "forecast", figure: "seed", which: "living", basis: b } } })),
    });
  const drivers: ChainLine[] = [];
  if (c.a.livingCost != null && c.a.livingBasis === basis) drivers.push({ label: "Living cost you typed", value: { cents: c.a.livingCost }, source: "assumption", note: `The ${seed.label.toLowerCase()} figure above is ${money(seed.cents)}.` });
  drivers.push({ label: "Living growth / yr", value: { ratio: c.a.livingGrowth }, source: "assumption", note: `Applied each January from ${seeds.start.year + 1}.` });
  blocks.push({ kind: "chain", title: "In the forecast", lines: drivers, note: SAVED });
  const { checks, withheld } = checksFor(book, { affects: "CASH_FLOW", from: t.from, to: t.to }, CASH_FLOW_CHECKS);
  return {
    describes: `Living cost · ${seed.label}`,
    figure: { cents: seed.cents },
    selfCheck: sumCheck(seed.cents, recomputed, `Spending less tax payments, one-offs and reimbursements comes to ${money(recomputed)}`),
    blocks,
    checks,
    withheld,
    estimates: [],
    through: t.to,
  };
}

// ------------------------------------------------------------------- realized return

function returnProof(c: Ctx): Built {
  const { book, seeds } = c;
  // The same report the seed reads (buildAnnualProfile: yearly net worth, its chained portfolio return).
  const nw = buildNetWorth(book, { granularity: "year" });
  const measured = nw.periods.filter((p) => p.household.portfolioReturn != null);
  const investmentIds = nw.accounts.filter((x) => x.isInvestment).map((x) => x.id);
  const chained = chainReturns(measured.map((p) => ({ r: p.household.portfolioReturn!, days: inclusiveDays(p.start, p.end) })));
  const days = measured.reduce((t, p) => t + inclusiveDays(p.start, p.end), 0);
  const lines: ChainLine[] = measured.map((p, i) => ({
    op: i ? ("×" as const) : undefined,
    label: `${p.label}${p.through ? ` (to ${p.through})` : ""}: 1 + return`,
    value: { ratio: p.household.portfolioReturn! },
    source: "derived" as const,
    note: "Market change ÷ money invested (time-weighted for money in and out), across the investment accounts.",
    link: { label: `Investments, ${p.label}`, descriptor: { report: "net-worth", metric: "change", granularity: "year", start: p.start, end: p.end, ...(investmentIds.length ? { accountIds: investmentIds } : {}) } },
  }));
  lines.push({ op: "=", label: `Growth, ${measured[0]?.start ?? "—"} – ${measured.at(-1)?.end ?? "—"}`, value: { ratio: chained.total }, source: "derived" });
  if (chained.annualized != null) lines.push({ op: "=", label: `A year, over ${days} days`, value: { ratio: chained.annualized }, source: "derived", note: "(1 + growth) ^ (365 ÷ days) − 1." });
  const blocks: ProofBlock[] = [
    { kind: "chain", title: "Realized portfolio return", lines, note: "Years with under $1,000 invested are left out: rounding, not performance." },
    { kind: "chain", title: "In the forecast", lines: [{ label: "Return / yr", value: { ratio: c.a.returnRate }, source: "assumption", note: seeds.realizedReturn != null ? `Your realized return is ${pct(seeds.realizedReturn)}.` : undefined }], note: SAVED },
  ];
  const from = measured[0]?.start ?? book.horizon.netWorth;
  const to = measured.at(-1)?.end ?? book.horizon.netWorth;
  const { checks, withheld } = checksFor(book, { affects: "NET_WORTH", from, to, accountIds: investmentIds }, NET_WORTH_CHECKS);
  return {
    describes: "Realized return on investments",
    figure: seeds.realizedReturn != null ? { ratio: seeds.realizedReturn } : { text: "Under a year measured" },
    selfCheck: null,
    blocks,
    checks,
    withheld,
    estimates: [],
    through: to,
  };
}

// ------------------------------------------------------------------- bonuses

function bonusProof(c: Ctx): Built {
  const { seeds, data } = c;
  const inputs = forecastInputs(data)!;
  const f = buildForecast(inputs, c.a);
  const paid = f.schedule.filter((b) => b.source === "PAID");
  const letters = f.schedule.filter((b) => b.source === "LETTER");
  const est = f.schedule.filter((b) => b.source === "ESTIMATE");
  const firstEst = est.find((b) => b.counted);
  const blocks: ProofBlock[] = [];
  if (paid.length)
    blocks.push({
      kind: "breakdown",
      title: "Paid on stubs after the start (proven)",
      items: paid.map((b) => ({
        label: b.date!,
        sub: b.personName,
        value: { cents: b.gross },
        link: { label: `${b.personName}'s bonus, ${b.date}`, descriptor: { report: "pay", basis: "paid", personId: b.personId, lines: ["bonus"], start: b.date!, end: b.date! } satisfies PayDescriptor },
      })),
    });
  if (letters.length)
    blocks.push({
      kind: "breakdown",
      title: "Scheduled by award letters",
      items: letters.map((b) => ({
        label: b.label,
        sub: `${b.personName} · ${b.key}`,
        value: { cents: b.gross },
        ...(b.window ? { link: { label: b.label, descriptor: { report: "bonuses", figure: "window", window: b.window, measure: "scheduled" } satisfies BonusesDescriptor } } : {}),
      })),
      note: "Read off the award letters on file (Bonuses page): the amounts are the letters', the dates their vesting windows.",
    });
  const pay = f.pay;
  const lines: ChainLine[] = [{ label: "Estimate awards", value: { text: { NEXT_PAYOUT: "from the next payout", AFTER_NEAR_TERM: `from ${f.nearTermThrough + 1}`, NONE: "never" }[c.a.bonus.estimates] }, source: "assumption" }];
  for (const p of pay.people)
    lines.push({
      label: `${p.name}'s bonus, % of base salary`,
      value: { ratio: p.bonusPct },
      source: p.bonusPctTyped ? "assumption" : "derived",
      note: p.bonusPctTyped ? `Typed. Default: ${p.bonusDefault.label} (${pct(p.bonusDefault.pct)}).` : `Default: ${p.bonusDefault.label}, from the stubs.`,
    });
  for (const pat of data.bonusFacts.patterns)
    lines.push({ label: `Payout pattern, ${pat.employer} ${pat.fromYear} letter`, value: { text: pat.parts.map((x) => x.label).join(", ") }, source: "estimate" });
  for (const b of est.filter((x) => x.counted).slice(0, 6)) lines.push({ label: `${b.personName}: ${b.label}`, value: { cents: b.gross }, source: "estimate", note: `Paid ${b.key}.` });
  lines.push({ label: "Bonus kept after tax", value: { ratio: pay.bonus.keepRate }, source: pay.bonus.keepTyped ? "assumption" : "law" }, { label: "Bonus saved", value: { ratio: c.a.bonus.savedShare }, source: "assumption" });
  blocks.push({ kind: "chain", title: "Estimated awards", lines, note: `${SAVED} The first estimates are listed; the Forecast page's bonus table has every one.` });
  const parts = [`${paid.length} on stubs`, `${letters.length} from letters`, firstEst ? `estimates from ${firstEst.key.slice(0, 4)}` : "no estimates"];
  return {
    describes: "Bonuses the forecast pays",
    figure: { text: parts.join(" · ") },
    selfCheck: null,
    blocks,
    estimates: firstEst ? [{ id: "forecast.bonus-estimates", title: `Bonus awards no stub or letter shows yet, from ${firstEst.key}`, detail: "A share of that year's base salary, paid on the latest letter's pattern (or the usual bonus month)." }] : [],
    through: seeds.start.asOf,
  };
}

// ------------------------------------------------------------------- ledger cells

type CellDescriptor = Extract<ForecastDescriptor, { figure: "month" }>;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const keyWord = (key: string) => `${MON[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const BALANCES = new Set<LedgerLine>(["netWorth", "liquid", "illiquid"]);

/** A ledger cell's descriptor: `line` over the months from `month` through `through`. */
const cellOf = (month: string, through: string, line: LedgerLine): CellDescriptor => ({ report: "forecast", figure: "month", month, ...(through !== month ? { through } : {}), line });
const colCell = (p: Period, line: LedgerLine) => cellOf(p.from, p.through.slice(0, 7), line);

/** A line's value in a column, as the ledger reads it (ForecastLedger ROWS). */
export function ledgerValue(x: Flows, line: LedgerLine): number | null {
  if (line === "toLiquid") return x.saved == null || x.toRetirement == null ? null : x.saved - x.toRetirement;
  if (line === "netWorth" || line === "liquid" || line === "illiquid") return x.close?.[line] ?? null;
  return x[line];
}

/** Every column the ledger can draw that touches `year`: the year columns and that year's months. */
function columnsOf(f: Forecast, r: AnnualProfileReport, year: number): Period[] {
  return [...yearPeriods(f, r, { actualYears: r.years.length, throughYear: year }), ...monthPeriods(f, r, year)];
}

const at = (p: Period, line: LedgerLine) => ledgerValue(p.flows, line) ?? 0;
const cents = (l: ChainLine) => ("cents" in l.value ? l.value.cents : 0);

type CellCtx = Ctx & { f: Forecast; r: AnnualProfileReport; col: Period; line: LedgerLine; figure: number };

/**
 * A line as one of the parts of a sum, linking to that line's cell in the same column.
 * `op` signs it into the sum.
 */
function partOf(x: CellCtx, line: LedgerLine, op: "+" | "−" | undefined, opts: Partial<ChainLine> = {}): ChainLine {
  return { op, label: LEDGER_LINES[line], value: { cents: at(x.col, line) }, source: "derived", link: { label: `${LEDGER_LINES[line]}, ${colWord(x.col)}`, descriptor: colCell(x.col, line) }, ...opts };
}

const colWord = (p: Period) => (p.from === p.through.slice(0, 7) ? keyWord(p.from) : p.kind === "ACTUAL" && p.id.endsWith("-ytd") ? `${p.label} ${p.year}` : p.label.includes(String(p.year)) ? p.label : `${p.label} ${p.year}`);

/** A chain of signed parts closing on the figure, and the sum check over it. */
function sumChain(title: string, parts: ChainLine[], total: { label: string; cents: number }, note?: string): { block: ProofBlock; sum: number } {
  const sum = parts.reduce((t, l, i) => t + (l.op === "−" ? -cents(l) : i === 0 || l.op === "+" ? cents(l) : 0), 0);
  return { block: { kind: "chain", title, lines: [...parts, { op: "=", label: total.label, value: { cents: total.cents }, source: "derived" }], ...(note ? { note } : {}) }, sum };
}

/** The flows that make up saved, each linking to its cell. */
function savedParts(x: CellCtx): ChainLine[] {
  const nz = (line: LedgerLine) => at(x.col, line) !== 0;
  const parts: ChainLine[] = [partOf(x, "salary", undefined)];
  if (nz("bonus")) parts.push(partOf(x, "bonus", "+"));
  if (nz("otherIncome")) parts.push(partOf(x, "otherIncome", "+"));
  parts.push(partOf(x, "taxes", "−"), partOf(x, "employer", "+"), partOf(x, "living", "−"));
  if (nz("bonusSpent")) parts.push(partOf(x, "bonusSpent", "−"));
  if (nz("oneOffs")) parts.push(partOf(x, "oneOffs", "−"));
  return parts;
}

/** An annual amount's share for month `m`: Jan–m less Jan–(m−1), each to the cent (the engine's whole-cent split). */
function monthShare(annual: number, m: number, word: string, total: number): { block: ProofBlock; sum: number } {
  const to = Math.round((annual * m) / 12);
  const before = Math.round((annual * (m - 1)) / 12);
  const lines: ChainLine[] = [{ label: `${word}, Jan${m > 1 ? `–${MON[m - 1]}` : ""}: the year × ${m} ÷ 12, to the cent`, value: { cents: to }, source: "derived" }];
  if (m > 1) lines.push({ op: "−", label: `${word}, Jan${m > 2 ? `–${MON[m - 2]}` : ""}: the year × ${m - 1} ÷ 12`, value: { cents: before }, source: "derived" });
  lines.push({ op: "=", label: `${word}, ${MON[m - 1]}`, value: { cents: total }, source: "derived" });
  return { block: { kind: "chain", title: `${MON[m - 1]}'s twelfth`, lines, note: "Each month takes its twelfth to the cent, so the twelve add back up to the year exactly." }, sum: to - before };
}

/** An annual figure at the start grown by `rate` for the years since the start. */
function grown(startLines: ChainLine[], startTotal: { label: string; cents: number } | null, years: number, rate: number, rateLabel: string, year: number, annual: number, title: string, note?: string): ProofBlock {
  const lines = [...startLines];
  if (startTotal) lines.push({ op: "=", label: startTotal.label, value: { cents: startTotal.cents }, source: "derived" });
  if (years > 0)
    lines.push(
      { op: "×", label: `(1 + ${pct(rate)} ${rateLabel}) ^ ${years} year${years === 1 ? "" : "s"}`, value: { ratio: (1 + rate) ** years }, source: "assumption", note: `${rateLabel[0]!.toUpperCase()}${rateLabel.slice(1)} applies each January after the start.` },
      { op: "=", label: `A year in ${year}`, value: { cents: Math.round(annual) }, source: "derived" },
    );
  return { kind: "chain", title, lines, ...(note ? { note } : {}) };
}

const seedLink = (label: string, descriptor: ForecastDescriptor): ProofLink => ({ label, descriptor });

/** A projected month's cell, re-derived from the seeds and drivers the engine ran on. */
function projectedMonth(x: CellCtx, m: OutlookMonth): Built {
  const { f, line, figure } = x;
  const pl = f.plan;
  const pay = f.pay;
  const i = m.year - pl.start.year;
  const idx = f.months.indexOf(m);
  const prev = idx > 0 ? f.months[idx - 1]! : null;
  const word = keyWord(m.key);
  // The engine's figures for the year (outlook.ts projectOutlook), from the same plan.
  const salaryY = grow(pl.salary, pl.salaryGrowth, i);
  const scale = pl.salary > 0 ? salaryY / pl.salary : 1;
  const livingY = grow(pl.livingCost, pl.livingGrowth, i);
  const paycheck = Object.fromEntries(pay.people.map((p) => [p.personId, p.basis]));
  const blocks: ProofBlock[] = [];
  let parts = figure;
  let note: string | undefined;

  const open = (side: "netWorth" | "liquid" | "illiquid"): ChainLine => {
    const v = prev ? prev[side] : side === "netWorth" ? pl.start.liquid + pl.start.illiquid : pl.start[side];
    return {
      label: prev ? `${LEDGER_LINES[side]} at the end of ${keyWord(prev.key)}` : `${LEDGER_LINES[side]} at the start (${x.seeds.start.asOf}, proven)`,
      value: { cents: v },
      source: prev ? "derived" : "proven",
      link: prev ? { label: `${LEDGER_LINES[side]}, ${keyWord(prev.key)}`, descriptor: cellOf(prev.key, prev.key, side) } : seedLink("The forecast's starting net worth", { report: "forecast", figure: "seed", which: "start" }),
    };
  };
  const rm = monthlyReturn(pl, i);
  const growthSide = (liquid: boolean): { block: ProofBlock; sum: number } => {
    const flow = liquid ? m.saved - m.deferrals - m.employerMatch : m.deferrals + m.employerMatch;
    const o = open(liquid ? "liquid" : "illiquid");
    const basis = cents(o) + flow / 2;
    const g = liquid ? m.liquidGrowth : m.growth - m.liquidGrowth;
    return {
      block: {
        kind: "chain",
        title: `Growth on ${liquid ? "liquid" : "illiquid"} money`,
        lines: [
          o,
          { op: "+", label: `Half the month's saving into it (${money(flow)} ÷ 2)`, value: { cents: flow / 2 }, source: "derived", note: "Money saved during the month earns for half of it on average.", link: { label: `${LEDGER_LINES[liquid ? "toLiquid" : "toRetirement"]}, ${word}`, descriptor: cellOf(m.key, m.key, liquid ? "toLiquid" : "toRetirement") } },
          { op: "=", label: "Invested over the month, on average", value: { cents: basis }, source: "derived" },
          { op: "×", label: `A month's return: (1 + ${pct(pl.returnRate)}) ^ (1/12) − 1`, value: { ratio: rm }, source: "assumption", note: "Return / yr, a driver: compounded monthly." },
          { op: "=", label: `Growth, to the cent`, value: { cents: g }, source: "derived" },
        ],
      },
      sum: Math.round(rm * basis),
    };
  };

  switch (line) {
    case "salary": {
      const people: ChainLine[] = pay.people.map((p, k) => ({
        op: k ? ("+" as const) : undefined,
        label: `${p.name}'s base salary`,
        value: { cents: p.salary },
        source: p.salaryTyped ? ("assumption" as const) : ("derived" as const),
        note: p.salaryTyped ? "Typed on the Forecast page." : `From the ${BASIS_WORD[p.basis].toLowerCase()} check.`,
        link: seedLink(`${p.name}'s pay`, { report: "forecast", figure: "seed", which: "pay", personId: p.personId, paycheck: p.basis }),
      }));
      blocks.push(grown(people, { label: "Household base salary at the start", cents: pl.salary }, i, pl.salaryGrowth, "raise", m.year, salaryY, `Base salary in ${m.year}`));
      const s = monthShare(salaryY, m.month, "Base salary", figure);
      blocks.push(s.block);
      parts = s.sum;
      break;
    }
    case "employer": {
      const start: ChainLine = {
        label: "Employer 401(k) and HSA money a year at the start",
        value: { cents: pl.employerMatch },
        source: pay.employerTyped ? "assumption" : "derived",
        link: seedLink("Employer money, from the stubs", { report: "forecast", figure: "seed", which: "employer", paycheck }),
      };
      blocks.push(grown([start], null, i, pl.salaryGrowth, "raise", m.year, pl.employerMatch * scale, `Employer money in ${m.year}`, "It rides on base salary, so it grows with the raise."));
      const s = monthShare(pl.employerMatch * scale, m.month, "Employer money", figure);
      blocks.push(s.block);
      parts = s.sum;
      break;
    }
    case "living": {
      const seed = x.seeds.living[x.a.livingBasis];
      const start: ChainLine = {
        label: "Living cost a year at the start",
        value: { cents: pl.livingCost },
        source: x.a.livingCost != null ? "assumption" : "derived",
        note: x.a.livingCost != null ? "Typed on the Forecast page." : seed ? `${seed.label}.` : undefined,
        ...(seed ? { link: seedLink(`Living cost · ${seed.label}`, { report: "forecast", figure: "seed", which: "living", basis: x.a.livingBasis }) } : {}),
      };
      blocks.push(grown([start], null, i, pl.livingGrowth, "living growth", m.year, livingY, `Living cost in ${m.year}`));
      const s = monthShare(livingY, m.month, "Living cost", figure);
      blocks.push(s.block);
      parts = s.sum;
      break;
    }
    case "bonus": {
      const paid = f.schedule.filter((b) => b.counted && b.key === m.key);
      const lines: ChainLine[] = paid.map((b, k) => {
        const op = k ? ("+" as const) : undefined;
        if (b.source === "PAID")
          return { op, label: `${b.personName}: ${b.label}`, value: { cents: b.gross }, source: "proven" as const, note: `On the ${b.date} stub.`, link: { label: `${b.personName}'s bonus, ${b.date}`, descriptor: { report: "pay", basis: "paid", personId: b.personId, lines: ["bonus"], start: b.date!, end: b.date! } satisfies PayDescriptor } };
        if (b.source === "LETTER")
          return {
            op,
            label: `${b.personName}: ${b.label}`,
            value: { cents: b.gross },
            source: "proven" as const,
            note: "The award letter's amount, paid in its vesting window: not paid yet.",
            ...(b.window ? { link: { label: b.label, descriptor: { report: "bonuses", figure: "window", window: b.window, measure: "scheduled" } satisfies BonusesDescriptor } } : {}),
          };
        return { op, label: `${b.personName}: ${b.label}`, value: { cents: b.gross }, source: "estimate" as const, note: "No stub or letter shows it yet: a share of base salary.", link: seedLink("Bonuses the forecast pays", { report: "forecast", figure: "seed", which: "bonus" }) };
      });
      if (!lines.length) lines.push({ label: "No bonus is paid this month", value: { cents: 0 }, source: "derived", link: seedLink("Bonuses the forecast pays", { report: "forecast", figure: "seed", which: "bonus" }) });
      const s = sumChain(`Bonuses paid in ${word}`, lines, { label: "Bonuses, gross", cents: figure }, "Paid on a stub after the start, scheduled by an award letter, or estimated (Forecast › Bonus payments).");
      blocks.push(s.block);
      parts = s.sum;
      break;
    }
    case "otherIncome":
      blocks.push({ kind: "chain", title: "Interest & other", lines: [{ label: "Interest and dividends", value: { cents: 0 }, source: "derived", note: "The forecast counts them in growth, not as income." }] });
      parts = 0;
      break;
    case "taxes": {
      const s = sumChain(
        `Taxes & deductions, ${word}`,
        [
          partOf(x, "salary", undefined),
          {
            op: "−",
            label: "Base pay after tax and deductions",
            value: { cents: m.takeHome },
            source: "derived",
            note: `Base salary × ${pct(pl.takeHomeRate)} kept after tax, this month's twelfth (401(k)/HSA deferrals stay in: they're savings).`,
          },
          ...(m.bonusGross ? [partOf(x, "bonus", "+"), { op: "−" as const, label: `Bonus kept after tax (× ${pct(pl.bonus?.keepRate ?? 0)})`, value: { cents: m.bonusKept }, source: pay.bonus.keepTyped ? ("assumption" as const) : ("law" as const), note: "Rounded to the cent." }] : []),
        ],
        { label: "Taxes & deductions", cents: figure },
      );
      blocks.push(s.block);
      blocks.push(
        grown(
          [
            { label: "Base salary this year", value: { cents: Math.round(salaryY) }, source: "derived" },
            { op: "×", label: "Kept after tax and deductions", value: { ratio: pl.takeHomeRate }, source: pay.rateTyped ? "assumption" : "law", note: pay.rateTyped ? "Typed on the Forecast page." : `${x.seeds.taxYear} tax law on the household's base pay.`, link: seedLink("Share of base salary kept after tax", { report: "forecast", figure: "seed", which: "take-home", paycheck }) },
            { op: "=", label: `Take-home a year in ${m.year}`, value: { cents: Math.round(salaryY * pl.takeHomeRate) }, source: "derived" },
          ],
          null,
          0,
          0,
          "",
          m.year,
          0,
          "Base pay after tax",
        ),
      );
      const share = monthShare(salaryY * pl.takeHomeRate, m.month, "Take-home", m.takeHome);
      blocks.push(share.block);
      parts = s.sum;
      if (share.sum !== m.takeHome) parts = Number.NaN;
      break;
    }
    case "bonusSpent": {
      const lines: ChainLine[] = [
        partOf(x, "bonus", undefined),
        { op: "×", label: "Kept after tax", value: { ratio: pl.bonus?.keepRate ?? 0 }, source: pay.bonus.keepTyped ? "assumption" : "law" },
        { op: "=", label: "Bonus kept, to the cent", value: { cents: m.bonusKept }, source: "derived" },
        { op: "−", label: `Saved (${pct(pl.bonus?.savedShare ?? 0)} of it, to the cent)`, value: { cents: m.bonusSaved }, source: "assumption", note: "Bonus saved, a driver." },
        { op: "=", label: "Bonus spent", value: { cents: figure }, source: "derived" },
      ];
      blocks.push({ kind: "chain", title: `Bonus spent, ${word}`, lines });
      parts = m.bonusKept - m.bonusSaved;
      break;
    }
    case "oneOffs": {
      const planned = pl.plannedExpenses.filter((e) => e.year === m.year && (e.month ?? 6) === m.month);
      const lines: ChainLine[] = planned.map((e, k) => ({ op: k ? ("+" as const) : undefined, label: e.label || "Planned one-off", value: { cents: e.amount }, source: "assumption" as const, note: e.month ? undefined : "No month set: June." }));
      if (!lines.length) lines.push({ label: "No one-off planned this month", value: { cents: 0 }, source: "derived" });
      const s = sumChain(`One-offs planned for ${word}`, lines, { label: "One-offs", cents: figure }, "Planned on Annual › One-off expenses.");
      blocks.push(s.block);
      parts = s.sum;
      break;
    }
    case "saved": {
      const s = sumChain(`Saved, ${word}`, savedParts(x), { label: "Saved", cents: figure });
      blocks.push(s.block);
      parts = s.sum;
      break;
    }
    case "toRetirement": {
      const deferralsY = pl.deferrals * scale;
      const split = Math.round((deferralsY * m.month) / 12) - Math.round((deferralsY * (m.month - 1)) / 12);
      const s = sumChain(
        `Saved to retirement, ${word}`,
        [
          {
            label: "Your 401(k) and HSA deferrals",
            value: { cents: m.deferrals },
            source: pay.deferralsTyped ? "assumption" : "derived",
            note: `${money(Math.round(deferralsY))} a year (grown with the raise), this month's twelfth${split !== m.deferrals ? `, held to the month's take-home ${money(m.takeHome)}` : ""}.`,
            link: seedLink("Deferrals, from the stubs", { report: "forecast", figure: "seed", which: "deferrals", paycheck }),
          },
          partOf(x, "employer", "+"),
        ],
        { label: "Saved to retirement", cents: figure },
      );
      blocks.push(s.block);
      parts = s.sum;
      if (Math.min(m.takeHome, split) !== m.deferrals) parts = Number.NaN;
      break;
    }
    case "toLiquid": {
      const s = sumChain(`Saved to liquid, ${word}`, [partOf(x, "saved", undefined), partOf(x, "toRetirement", "−")], { label: "Saved to liquid", cents: figure }, "What lands in (or leaves) cash and brokerage.");
      blocks.push(s.block);
      parts = s.sum;
      break;
    }
    case "growth": {
      const l = growthSide(true);
      const il = growthSide(false);
      const s = sumChain(`Growth, ${word}`, [{ label: "On liquid money", value: { cents: m.liquidGrowth }, source: "derived" }, { op: "+", label: "On illiquid money", value: { cents: m.growth - m.liquidGrowth }, source: "derived" }], { label: "Growth", cents: figure });
      blocks.push(s.block, l.block, il.block);
      parts = l.sum + il.sum;
      break;
    }
    case "change": {
      const a = sumChain(`Change in net worth, ${word}`, [partOf(x, "netWorth", undefined, { label: `Net worth at the end of ${word}` }), { ...open("netWorth"), op: "−" }], { label: "Change in net worth", cents: figure });
      const b = sumChain("Made of", [partOf(x, "saved", undefined), partOf(x, "growth", "+")], { label: "Change in net worth", cents: figure });
      blocks.push(a.block, b.block);
      parts = a.sum === b.sum ? a.sum : Number.NaN;
      break;
    }
    case "netWorth": {
      const a = sumChain(`Net worth, end of ${word}`, [open("netWorth"), partOf(x, "saved", "+"), partOf(x, "growth", "+")], { label: `Net worth at the end of ${word}`, cents: figure });
      const b = sumChain("Split", [partOf(x, "liquid", undefined), partOf(x, "illiquid", "+")], { label: "Net worth", cents: figure });
      blocks.push(a.block, b.block);
      parts = a.sum === b.sum ? a.sum : Number.NaN;
      break;
    }
    case "liquid":
    case "illiquid": {
      const liquid = line === "liquid";
      const g = liquid ? m.liquidGrowth : m.growth - m.liquidGrowth;
      const s = sumChain(
        `${LEDGER_LINES[line]}, end of ${word}`,
        [open(line), partOf(x, liquid ? "toLiquid" : "toRetirement", "+"), { op: "+", label: `Growth on ${line} money`, value: { cents: g }, source: "derived", link: { label: `Growth, ${word}`, descriptor: cellOf(m.key, m.key, "growth") } }],
        { label: `${LEDGER_LINES[line]} at the end of ${word}`, cents: figure },
        liquid ? "Cash and brokerage, less card balances." : "Retirement accounts, HSA, everything else: deferrals and employer money land here.",
      );
      blocks.push(s.block);
      parts = s.sum;
      break;
    }
  }
  if (f.nearTermThrough >= m.year && x.a.bonus.estimates === "AFTER_NEAR_TERM") note = `Near term (through ${f.nearTermThrough}): no estimated bonus is paid.`;
  const est = f.schedule.filter((b) => b.counted && b.key === m.key && b.source === "ESTIMATE");
  return {
    describes: `${LEDGER_LINES[line]} · ${word}, projected`,
    figure: { cents: figure },
    selfCheck: sumCheck(figure, Number.isNaN(parts) ? figure + 1 : parts, Number.isNaN(parts) ? "The steps above don't re-derive the engine's figure" : `Re-derived from the seeds and drivers, the steps above come to ${money(parts)}`),
    blocks: note ? [...blocks.slice(0, 1).map((b) => ({ ...b, note: [b.note, note].filter(Boolean).join(" ") })), ...blocks.slice(1)] : blocks,
    estimates: [
      { id: "forecast.projected", title: `${word} is projected, not proven`, detail: `On the saved drivers, from the balances proven through ${x.seeds.start.asOf}. ${SAVED}` },
      ...est.map((b) => ({ id: `forecast.bonus:${b.personId}:${b.key}`, title: `${b.personName}: ${b.label}`, detail: "An estimated bonus: no stub or letter shows it yet." })),
    ],
    through: x.seeds.start.asOf,
  };
}

/** A forecast column of several months (a forecast year, the rest of the year in progress): the months re-add to it. */
function projectedSpan(x: CellCtx, months: OutlookMonth[]): Built {
  const { f, r, col, line, figure } = x;
  const monthCols = monthPeriods(f, r, col.year).filter((p) => p.kind === "FORECAST");
  const word = colWord(col);
  const first = months[0]!;
  const last = months.at(-1)!;
  const blocks: ProofBlock[] = [];
  let parts: number;
  if (BALANCES.has(line)) {
    const idx = f.months.indexOf(first);
    const prev = idx > 0 ? f.months[idx - 1]! : null;
    const openV = prev ? (line === "netWorth" ? prev.netWorth : prev[line as "liquid" | "illiquid"]) : line === "netWorth" ? f.plan.start.liquid + f.plan.start.illiquid : f.plan.start[line as "liquid" | "illiquid"];
    const g = months.reduce((t, m) => t + (line === "netWorth" ? m.growth : line === "liquid" ? m.liquidGrowth : m.growth - m.liquidGrowth), 0);
    const s = sumChain(
      `${LEDGER_LINES[line]}, ${word}`,
      [
        {
          label: prev ? `${LEDGER_LINES[line]} at the end of ${keyWord(prev.key)}` : `${LEDGER_LINES[line]} at the start (${x.seeds.start.asOf}, proven)`,
          value: { cents: openV },
          source: prev ? "derived" : "proven",
          link: prev ? { label: `${LEDGER_LINES[line]}, ${keyWord(prev.key)}`, descriptor: cellOf(prev.key, prev.key, line) } : seedLink("The forecast's starting net worth", { report: "forecast", figure: "seed", which: "start" }),
        },
        partOf(x, line === "netWorth" ? "saved" : line === "liquid" ? "toLiquid" : "toRetirement", "+"),
        line === "netWorth" ? partOf(x, "growth", "+") : { op: "+", label: `Growth on ${line} money`, value: { cents: g }, source: "derived", note: "The months' growth on this side." },
      ],
      { label: `${LEDGER_LINES[line]} at the end of ${keyWord(last.key)}`, cents: figure },
    );
    blocks.push(s.block, { kind: "breakdown", title: "The last month", items: [{ label: keyWord(last.key), value: { cents: last[line as "netWorth" | "liquid" | "illiquid"] }, link: { label: `${LEDGER_LINES[line]}, ${keyWord(last.key)}`, descriptor: cellOf(last.key, last.key, line) } }] });
    parts = s.sum === last[line as "netWorth" | "liquid" | "illiquid"] ? s.sum : Number.NaN;
  } else {
    const items = months.map((m) => {
      const p = monthCols.find((c) => c.id === m.key)!;
      return { label: keyWord(m.key), value: { cents: at(p, line) }, link: { label: `${LEDGER_LINES[line]}, ${keyWord(m.key)}`, descriptor: cellOf(m.key, m.key, line) } };
    });
    parts = items.reduce((t, i) => t + i.value.cents, 0);
    blocks.push({ kind: "breakdown", title: "By month", items, note: "Each month opens its own proof: the seed it grows from, the drivers, the law." });
  }
  return {
    describes: `${LEDGER_LINES[line]} · ${word}, projected`,
    figure: { cents: figure },
    selfCheck: sumCheck(figure, Number.isNaN(parts) ? figure + 1 : parts, BALANCES.has(line) ? `The opening balance, the column's saving and growth come to ${money(Number.isNaN(parts) ? 0 : parts)}, the last month's closing` : `The ${months.length} months add up to ${money(parts)}`),
    blocks,
    estimates: [{ id: "forecast.projected", title: `${word} is projected, not proven`, detail: `On the saved drivers, from the balances proven through ${x.seeds.start.asOf}. ${SAVED}` }],
    through: x.seeds.start.asOf,
  };
}

/** The year in progress' total: the actual year to date + the forecast's rest of the year. */
function yearTotal(x: CellCtx, cols: Period[]): Built {
  const { col, line, figure } = x;
  const ytd = cols.find((p) => p.kind === "ACTUAL" && p.id === `${col.year}-ytd`)!;
  const rest = cols.find((p) => p.kind === "FORECAST" && p.id === `${col.year}-rest`)!;
  const restV = at(rest, line);
  const lines: ChainLine[] = BALANCES.has(line)
    ? [{ label: `${LEDGER_LINES[line]} at the end of ${rest.through}, projected`, value: { cents: restV }, source: "derived", link: { label: `${LEDGER_LINES[line]}, ${colWord(rest)}`, descriptor: colCell(rest, line) } }]
    : [
        { label: `Actual, ${colWord(ytd)} (proven)`, value: { cents: at(ytd, line) }, source: "proven", link: { label: `${LEDGER_LINES[line]}, ${colWord(ytd)}`, descriptor: colCell(ytd, line) } },
        { op: "+", label: `Forecast, ${colWord(rest)}`, value: { cents: restV }, source: "derived", link: { label: `${LEDGER_LINES[line]}, ${colWord(rest)}`, descriptor: colCell(rest, line) } },
      ];
  const s = sumChain(`${LEDGER_LINES[line]}, ${col.year}`, lines, { label: `${LEDGER_LINES[line]}, ${col.year}`, cents: figure }, BALANCES.has(line) ? "The year closes on the forecast's December." : "The year so far is actual; the rest is the forecast.");
  return {
    describes: `${LEDGER_LINES[line]} · ${col.year}, actual to date + forecast`,
    figure: { cents: figure },
    selfCheck: sumCheck(figure, s.sum, BALANCES.has(line) ? `The forecast's closing comes to ${money(s.sum)}` : `Actual to date and the forecast's rest add up to ${money(s.sum)}`),
    blocks: [s.block],
    estimates: [{ id: "forecast.projected", title: `${colWord(rest)} is projected, not proven`, detail: `On the saved drivers. ${SAVED}` }],
    through: x.seeds.start.asOf,
  };
}

/** An actual column (a proven year, or the year to date): the real figures, read off stubs, ledger rows and statements. */
function actualColumn(x: CellCtx, cols: Period[]): Built {
  const { book, r, col, line, figure, seeds } = x;
  const isYtd = col.id.endsWith("-ytd");
  const y = isYtd ? r.ytd! : r.years.find((v) => v.year === col.year && !v.isCurrent)!;
  const word = colWord(col);
  const w = y.cash?.waterfall;
  const people = (y.people ?? []).filter((p) => p.hasPay || p.salary || p.bonus || p.employer || p.deferrals || p.withholding);
  const payYtd = (personId: string, l: "base" | "bonus"): PayDescriptor => ({ report: "pay", basis: "ytd", personId, lines: [l], year: y.year, through: y.asOf });
  const blocks: ProofBlock[] = [];
  let parts = figure;
  const perPerson = (get: (p: (typeof people)[number]) => number, opts: { first?: "+" | "−"; op?: "+" | "−"; link?: "base" | "bonus"; note: string }): ChainLine[] =>
    people.map((p, k) => ({
      op: k ? (opts.op ?? "+") : opts.first,
      label: p.name,
      value: { cents: get(p) },
      source: "proven" as const,
      note: opts.note,
      ...(opts.link ? { link: { label: `${p.name}'s ${opts.link === "base" ? "base pay" : "bonus"}, ${y.year}`, descriptor: payYtd(p.personId, opts.link) } } : {}),
    }));
  const push = (s: { block: ProofBlock; sum: number }) => {
    blocks.push(s.block);
    parts = s.sum;
  };
  const prevYear = cols.find((p) => p.kind === "ACTUAL" && p.id === String(y.year - 1));
  const asOf = isYtd ? seeds.start.asOf : y.netWorthAsOf;
  let pay = false;

  switch (line) {
    case "salary":
    case "bonus":
      pay = true;
      push(sumChain(`${LEDGER_LINES[line]}, ${word}`, perPerson((p) => (line === "salary" ? p.salary : p.bonus), { link: line === "salary" ? "base" : "bonus", note: "The year to date on the person's last stubs." }), { label: LEDGER_LINES[line], cents: figure }));
      break;
    case "otherIncome": {
      const o = y.cash!.otherIncomeDetail;
      push(
        sumChain(
          `Interest & other, ${word}`,
          [
            { label: "Interest", value: { cents: o.interest }, source: "proven", note: "Interest rows on the bank statements." },
            { op: "+", label: "Dividends in taxable accounts", value: { cents: o.dividends }, source: "proven" },
            { op: "+", label: "Other income", value: { cents: o.other }, source: "proven" },
          ],
          { label: "Interest & other", cents: figure },
        ),
      );
      break;
    }
    case "taxes":
      pay = true;
      push(
        sumChain(
          `Taxes & deductions, ${word}`,
          [
            ...perPerson((p) => p.withholding, { note: "Tax withheld on the stubs, year to date." }).map((l) => ({ ...l, label: `${l.label}: withheld` })),
            { op: "+", label: "Tax payments", value: { cents: w!.additionalTaxes }, source: "proven", note: "Estimated and balance-due payments on the bank statements." },
            { op: "−", label: "Refunds", value: { cents: w!.refunds }, source: "proven" },
            ...perPerson((p) => p.otherDeductions, { first: "+", note: "Benefit and after-tax deductions on the stubs." }).map((l) => ({ ...l, label: `${l.label}: deductions` })),
          ],
          { label: "Taxes & deductions", cents: figure },
        ),
      );
      break;
    case "employer":
      pay = true;
      push(sumChain(`Employer 401(k) & HSA, ${word}`, perPerson((p) => p.employer, { note: "Employer money on the stubs, year to date." }), { label: "Employer 401(k) & HSA", cents: figure }));
      break;
    case "living": {
      const t = y.cash!.livingTrail;
      const l = livingLines(book, t);
      blocks.push({ kind: "chain", title: `Living cost, ${word}`, lines: l.lines });
      parts = l.recomputed;
      break;
    }
    case "bonusSpent":
      push(sumChain("Bonus spent", [{ label: "Actual years count every bonus dollar in what was saved or spent", value: { cents: 0 }, source: "derived" }], { label: "Bonus spent", cents: figure }));
      break;
    case "oneOffs": {
      const t = y.cash!.livingTrail;
      const lines: ChainLine[] = [
        ...t.oneOffs.map((o) => ({ op: "+" as const, label: `${o.date} ${o.payee}`, value: { cents: o.cents }, source: "proven" as const, note: [o.category, o.account, o.label && `“${o.label}”`, "tagged by you as a one-off"].filter(Boolean).join(" · ") })),
        ...t.oneOffCategories.map((o) => ({ op: "+" as const, label: `${o.category} (${o.rows} row${o.rows === 1 ? "" : "s"})`, value: { cents: o.cents }, source: "proven" as const, note: "A category you count as one-offs." })),
      ].map((l, k) => (k ? l : { ...l, op: undefined }));
      if (!lines.length) lines.push({ label: "No expense tagged as a one-off", value: { cents: 0 }, source: "derived" });
      push(sumChain(`One-offs, ${word}`, lines, { label: "One-offs", cents: figure }));
      break;
    }
    case "saved":
      push(sumChain(`Saved, ${word}`, savedParts(x), { label: "Saved", cents: figure }));
      break;
    case "toRetirement":
      push(sumChain(`Saved to retirement, ${word}`, [...perPerson((p) => p.deferrals, { note: "401(k) and HSA deferrals on the stubs, year to date." }).map((l) => ({ ...l, label: `${l.label}: deferrals` })), partOf(x, "employer", "+")], { label: "Saved to retirement", cents: figure }));
      break;
    case "toLiquid":
      push(sumChain(`Saved to liquid, ${word}`, [partOf(x, "saved", undefined), partOf(x, "toRetirement", "−")], { label: "Saved to liquid", cents: figure }));
      break;
    case "growth":
      push(sumChain(`Growth & other, ${word}`, [partOf(x, "change", undefined), partOf(x, "saved", "−")], { label: "Growth & other", cents: figure }, "Everything that moved net worth besides cash saved: markets, outside money, gaps."));
      break;
    case "change": {
      const openV = col.flows.open ?? 0;
      push(
        sumChain(
          `Change in net worth, ${word}`,
          [
            partOf(x, "netWorth", undefined, { label: `Net worth at the end of ${asOf}`, source: "proven" }),
            { op: "−", label: `Net worth at the end of ${y.year - 1}`, value: { cents: openV }, source: "proven", ...(prevYear ? { link: { label: `Net worth, ${y.year - 1}`, descriptor: colCell(prevYear, "netWorth") } } : {}) },
          ],
          { label: "Change in net worth", cents: figure },
        ),
      );
      break;
    }
    case "netWorth":
      push(sumChain(`Net worth, end of ${asOf}`, [partOf(x, "liquid", undefined, { source: "proven" }), partOf(x, "illiquid", "+", { source: "proven" })], { label: "Net worth", cents: figure }));
      break;
    case "liquid":
    case "illiquid": {
      const transit = isYtd ? (seeds.start.inTransit ?? { liquid: 0, illiquid: 0 }) : y.netWorth!.inTransitSplit;
      const s = balanceSide(book, asOf, line === "liquid", transit, figure);
      push({ block: s.block, sum: s.parts });
      if (isYtd) blocks.push({ kind: "breakdown", title: "The forecast starts here", items: [{ label: `Net worth at the end of ${asOf}`, value: { cents: seeds.start.liquid + seeds.start.illiquid }, link: seedLink("The forecast's starting net worth", { report: "forecast", figure: "seed", which: "start" }) }] });
      break;
    }
  }
  const from = `${y.year}-01-01`;
  const { checks, withheld } = BALANCES.has(line) || line === "change" || line === "growth"
    ? checksFor(book, { affects: "NET_WORTH", from: line === "change" || line === "growth" ? from : asOf, to: asOf }, NET_WORTH_CHECKS)
    : checksFor(book, pay ? [{ affects: "CASH_FLOW", from, to: y.asOf }, { affects: "PAY", from, to: y.asOf }] : { affects: "CASH_FLOW", from, to: y.asOf }, pay ? [...CASH_FLOW_CHECKS, ...PAY_CHECKS.filter((id) => !CASH_FLOW_CHECKS.includes(id))] : CASH_FLOW_CHECKS);
  return {
    describes: `${LEDGER_LINES[line]} · ${word}, actual (not projected)`,
    figure: { cents: figure },
    selfCheck: sumCheck(figure, parts, `Read off the stubs, ledger rows and statements, the parts come to ${money(parts)}`),
    blocks: [...blocks.slice(0, 1).map((b) => ({ ...b, note: [b.note, "Actual: what happened, read off statements and stubs, not projected."].filter(Boolean).join(" ") })), ...blocks.slice(1)],
    checks,
    withheld,
    estimates: [],
    through: BALANCES.has(line) ? asOf : y.asOf,
  };
}

function cellProof(c: Ctx, d: CellDescriptor): Built {
  const f = buildForecast(forecastInputs(c.data)!, c.a);
  const r = c.data.profile;
  const through = d.through ?? d.month;
  const cols = columnsOf(f, r, Number(d.month.slice(0, 4)));
  const col = cols.find((p) => p.from === d.month && p.through.slice(0, 7) === through);
  if (!col) return notFound(`The forecast ledger has no column ${d.month}${d.through ? ` – ${d.through}` : ""}.`);
  const v = ledgerValue(col.flows, d.line);
  if (v == null) return notFound(`${LEDGER_LINES[d.line]} isn't proven for ${colWord(col)}${col.note ? `: ${col.note}` : ""}.`);
  const x: CellCtx = { ...c, f, r, col, line: d.line, figure: v };
  if (col.kind === "ACTUAL") return actualColumn(x, cols);
  if (col.kind === "TOTAL") return yearTotal(x, cols);
  const months = f.months.filter((m) => m.key >= col.from && m.key <= through);
  return months.length === 1 ? projectedMonth(x, months[0]!) : projectedSpan(x, months);
}

// -------------------------------------------------------------------

function notFound(why: string): Built {
  return { describes: why, figure: { text: "—" }, selfCheck: null, blocks: [], estimates: [], through: "", withheld: true };
}

export function buildForecastProof(book: Book, data: ForecastData, d: ForecastDescriptor): Proof {
  const seeds = data.profile.seeds;
  const base = { report: "forecast" as const, descriptor: d, today: book.today };
  if (!seeds)
    return {
      ...base,
      describes: "The forecast's starting point isn't proven",
      figure: { text: "Withheld" },
      selfCheck: null,
      withheld: true,
      blocks: [{ kind: "breakdown", title: "What withholds it", items: data.profile.seedBlockers.map((b) => ({ label: b.title, value: { text: b.status } })) }],
      checks: [],
      estimates: [],
      through: book.horizon.netWorth,
    };
  const c: Ctx = { book, data, seeds, a: data.profile.settings.outlook };
  const built =
    d.figure === "month"
      ? cellProof(c, d)
      : d.which === "start"
      ? startProof(c)
      : d.which === "pay"
        ? payProof(c, d.personId, d.paycheck)
        : d.which === "deferrals" || d.which === "employer"
          ? householdPay(c, d.which, d.paycheck)
          : d.which === "take-home"
            ? takeHomeProof(c, d.paycheck)
            : d.which === "living"
              ? livingProof(c, d.basis)
              : d.which === "return"
                ? returnProof(c)
                : bonusProof(c);
  return { ...base, checks: [], withheld: false, ...built, through: built.through || book.horizon.netWorth };
}

export const forecastKind: ProofKind<ForecastDescriptor> = {
  report: "forecast",
  parse: parseForecastDescriptor,
  build: async (ctx, d) => buildForecastProof(ctx.book, await perBook(ctx, "forecast-data", () => loadForecastData(ctx.db, ctx.book)), d),
};
