import { addDays, startOfMonth } from "../../dates/isoDate.ts";
import { formatPercentRatio, formatUsdFromCents } from "../../formatMoney.ts";
import { buildForecast } from "../../forecast/forecast.ts";
import { forecastInputs, loadForecastData, type ForecastData } from "../../forecast/load.ts";
import { bucketForGroup } from "../../profile/annualMath.ts";
import { resolveBasePay, type DeferralParts, type OutlookSeeds, type ResolvedBasePay } from "../../profile/basePay.ts";
import { BUCKETS, DEFAULT_PERSON_OUTLOOK, type LivingBasis, type OutlookAssumptions, type PaycheckBasis } from "../../profile/settings.ts";
import { TAX_YEARS } from "../../tax/params.ts";
import { chainReturns } from "../../ledger/timeline.ts";
import { inclusiveDays } from "../../dates/isoDate.ts";
import type { Book } from "../load.ts";
import { buildNetWorth } from "../reports/netWorth.ts";
import { buildCashFlowProof, CASH_FLOW_CHECKS, type CashFlowDescriptor } from "./cashFlowProof.ts";
import { checksFor, sumCheck } from "./common.ts";
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
 * `figure: "seed"` names a starting figure; a later extension proves one month's cell of
 * the forecast ledger as `figure: "month"` with the month's key and line.
 */

export type ForecastSeed = "start" | "pay" | "deferrals" | "employer" | "take-home" | "living" | "return" | "bonus";

export type ForecastDescriptor =
  | { report: "forecast"; figure: "seed"; which: "start" | "return" | "bonus" }
  | { report: "forecast"; figure: "seed"; which: "pay"; personId: string; paycheck: PaycheckBasis }
  /** `paycheck`: each person's paycheck choice on the page (the saved one for anyone not listed). */
  | { report: "forecast"; figure: "seed"; which: "deferrals" | "employer" | "take-home"; paycheck?: Record<string, PaycheckBasis> }
  | { report: "forecast"; figure: "seed"; which: "living"; basis: LivingBasis };

const BASES: PaycheckBasis[] = ["LATEST", "TYPICAL"];
const LIVING: LivingBasis[] = ["TRAILING_12", "LAST_YEAR", "THIS_YEAR"];

export function parseForecastDescriptor(d: Record<string, unknown>): ForecastDescriptor | { error: string } {
  if (d.figure === "month") return { error: "A forecast month's cell can't be proven yet: figure must be seed." };
  if (d.figure !== "seed") return { error: "figure must be seed." };
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

function startProof(c: Ctx): Built {
  const { book, seeds } = c;
  const s = seeds.start;
  const liquid = new Set(BUCKETS.filter((b) => b.liquid).map((b) => b.id));
  const ids = (want: boolean) => book.ledger.accounts.filter((x) => liquid.has(bucketForGroup(x.group)) === want).map((x) => x.id);
  const side = (want: boolean) => {
    const accountIds = ids(want);
    if (!accountIds.length) return { cents: 0, link: undefined };
    const descriptor: NetWorthDescriptor = { report: "net-worth", metric: "balance", date: s.asOf, accountIds };
    const p = buildNetWorthProof(book, descriptor);
    return { cents: "cents" in p.figure ? p.figure.cents : 0, link: { label: `${want ? "Liquid" : "Illiquid"} accounts on ${s.asOf}`, descriptor } satisfies ProofLink };
  };
  const transit = s.inTransit ?? { liquid: 0, illiquid: 0 };
  const chainFor = (want: boolean): { block: ProofBlock; parts: number } => {
    const acc = side(want);
    const t = want ? transit.liquid : transit.illiquid;
    const lines: ChainLine[] = [
      {
        label: want ? "Cash and taxable investments, less card balances" : "Retirement, HSA and everything else, less long-term debt",
        value: { cents: acc.cents },
        source: "proven",
        note: `Every such account's balance at the end of ${s.asOf}, read off its statements.`,
        ...(acc.link ? { link: acc.link } : {}),
      },
    ];
    if (t) lines.push(signed(t, { label: "Transfers in flight to these accounts", source: "derived", note: "Matched transfers that had left one account but not reached the other count on the side they were going to." }));
    lines.push({ op: "=", label: want ? "Liquid" : "Illiquid", value: { cents: want ? s.liquid : s.illiquid }, source: "derived" });
    return { block: { kind: "chain", title: want ? "Liquid" : "Illiquid", lines }, parts: acc.cents + t };
  };
  const l = chainFor(true);
  const i = chainFor(false);
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
    { label: "State tax on retirement draws", value: { ratio: c.a.stateTaxRate }, source: "assumption" },
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

function livingProof(c: Ctx, basis: LivingBasis): Built {
  const { book, seeds } = c;
  const seed = seeds.living[basis];
  if (!seed?.trail) return notFound(`There's no ${basis} living-cost figure: its window isn't proven.`);
  const t = seed.trail;
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
  let recomputed = cfCents + (booked - cfCents) - t.taxPayments - oneOffs - t.reimbursements - t.payReimbursements;
  if (t.days) {
    lines.push({ op: "×", label: `365 ÷ ${t.days} days`, value: { text: `365 ÷ ${t.days}` }, source: "derived" }, { op: "=", label: "A year at this rate", value: { cents: seed.cents }, source: "derived" });
    recomputed = Math.round((recomputed * 365) / t.days);
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
    d.which === "start"
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
  build: async ({ book, db }, d) => buildForecastProof(book, await loadForecastData(db, book), d),
};
