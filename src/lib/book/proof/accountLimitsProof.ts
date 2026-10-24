import { formatPercentRatio, formatUsdFromCents } from "../../formatMoney.ts";
import { taxLink } from "../../forecast/forecast.ts";
import { loadForecast } from "../../forecast/load.ts";
import { loadJsonSetting } from "../../settingsStore.ts";
import { taxYearParams, TAX_YEARS } from "../../tax/params.ts";
import { normalizeRetirementSettings, RETIREMENT_SETTINGS_KEY, type RetirementSettings } from "../../taxAccounts/settings.ts";
import type { Book, BookRow } from "../load.ts";
import { buildTaxAccounts, STUB_CHECKS, type Amount, type EmployerPlan, type PersonAccounts, type TaxAccountsReport } from "../reports/taxAccounts.ts";
import { accountOwner, chetYear, IRA_SUBTYPES } from "../taxAdvantaged.ts";
import type { CheckId } from "../types.ts";
import { checksFor, estimatesFor, perBook, sumCheck } from "./common.ts";
import { taxYearThrough } from "../blockers.ts";
import { groupRows, type PayLine } from "./payProof.ts";
import type { ChainLine, Proof, ProofBlock, ProofCheck, ProofContext, ProofEstimate, ProofKind, ProofLink } from "./types.ts";

/**
 * The proof behind a figure on the Account limits page (/tax-accounts): how much of each
 * yearly limit is used, the limit itself, and the room left. Every figure is re-derived
 * through the page's own report (buildTaxAccounts, which reads book/taxAdvantaged.ts, the
 * module the Taxes page shares), never a copy:
 *
 *  - 401(k) and HSA money from pay: each employer's year to date on its latest stub (or the
 *    W-2 on file for a finished year), each opening the pay proof of those stub lines; the
 *    rest of the year is an estimate (the regular check repeated), opening the forecast's
 *    pay seed when the forecast chose that check.
 *  - IRA contributions: the IRA statement rows that count, grouped by statement.
 *  - CHET 529: each account's contributions-year-to-date line, else its ledger deposits.
 *  - Limits: tax law (tax/params.ts) plus age catch-ups, the age from the birth year the
 *    owner typed under Settings › Household.
 *  - Room and excess: limit − counted, each side opening its own proof.
 */

export type LimitAccount = "k401" | "hsa" | "ira" | "chet" | "steps";
export type LimitFigure = "used" | "projected" | "limit" | "room" | "excess" | "tax-saved";

export type AccountLimitsDescriptor = {
  report: "account-limits";
  year: number;
  account: LimitAccount;
  figure: LimitFigure;
  /** k401, hsa, ira: whose. */
  personId?: string;
  /** k401 used/projected: one employer's plan, by the name the page shows. */
  employer?: string;
  /** k401 / hsa used/projected: your money (default for the 401(k)) or the employer's. Omitted for the HSA: everything that counts. */
  part?: "employee" | "employer";
};

const FIGURES: Record<LimitAccount, LimitFigure[]> = {
  k401: ["used", "projected", "limit", "room", "excess"],
  hsa: ["used", "projected", "limit", "room"],
  ira: ["used", "limit", "room"],
  chet: ["used", "limit", "room"],
  steps: ["room", "tax-saved"],
};

/** Statement problems that make IRA and CHET contributions unprovable. */
const STATEMENT_CHECKS: CheckId[] = ["statement.held", "statement.chain", "statement.gap", "statement.history", "transfer.unmatched", "ledger.consistency", "ledger.freshness"];
const PAY_LIMIT_CHECKS: CheckId[] = [...STUB_CHECKS, "retirement.contributions"];

export function parseAccountLimitsDescriptor(d: Record<string, unknown>): AccountLimitsDescriptor | { error: string } {
  if (typeof d.year !== "number" || !Number.isInteger(d.year) || d.year < 1900 || d.year > 2999) return { error: "year must be a calendar year." };
  if (!Object.hasOwn(FIGURES, d.account as string)) return { error: `account must be one of: ${Object.keys(FIGURES).join(", ")}.` };
  const account = d.account as LimitAccount;
  if (!FIGURES[account].includes(d.figure as LimitFigure)) return { error: `${account} figure must be one of: ${FIGURES[account].join(", ")}.` };
  const figure = d.figure as LimitFigure;
  const perPerson = account === "k401" || account === "hsa" || account === "ira";
  if (perPerson && (typeof d.personId !== "string" || !d.personId)) return { error: "personId must be an id." };
  if (!perPerson && d.personId != null) return { error: `${account} is the household's: no personId.` };
  const flows = figure === "used" || figure === "projected";
  if (d.employer != null && (account !== "k401" || !flows || typeof d.employer !== "string" || !d.employer)) return { error: "employer names one plan of a 401(k) used or projected figure." };
  if (d.part != null && (!(account === "k401" || account === "hsa") || !flows || (d.part !== "employee" && d.part !== "employer"))) return { error: "part (employee or employer) is for 401(k) and HSA used or projected figures." };
  return {
    report: "account-limits",
    year: d.year,
    account,
    figure,
    ...(perPerson ? { personId: d.personId as string } : {}),
    ...(d.employer ? { employer: d.employer as string } : {}),
    ...(d.part ? { part: d.part as "employee" | "employer" } : {}),
  };
}

// ---------------------------------------------------------------------------

const money = (c: number) => (c === 0 ? "$0.00" : formatUsdFromCents(c));
const pos = (n: number) => Math.max(0, n);
const total = (lines: ChainLine[]) => lines.reduce((t, l) => t + (l.op === "=" ? 0 : (l.op === "−" ? -1 : 1) * ("cents" in l.value ? l.value.cents : 0)), 0);
const link = (label: string, d: AccountLimitsDescriptor, patch: Partial<AccountLimitsDescriptor>): ProofLink => {
  const { employer: _e, part: _p, ...base } = d;
  void _e;
  void _p;
  return { label, descriptor: { ...base, ...patch } as AccountLimitsDescriptor };
};

export type AccountLimitsInputs = { report: TaxAccountsReport; birthYears: Record<string, number>; settings: RetirementSettings };

type Built = Pick<Proof, "describes" | "figure" | "selfCheck" | "blocks"> & { checks?: ProofCheck[]; withheld?: boolean; estimates?: ProofEstimate[]; through?: string };

/** Which stub lines and report figure an employer's money for the account and part is. */
type Flow = { label: string; line: PayLine; amount: (e: EmployerPlan) => Amount; per: (e: EmployerPlan) => number };
const FLOWS: Record<"k401" | "hsa", Record<"employee" | "employer", Flow>> = {
  k401: {
    employee: { label: "your 401(k) deferrals", line: "k401", amount: (e) => e.employee, per: (e) => (e.projection?.perCheck ? e.projection.perCheck.retirementPretax + e.projection.perCheck.retirementRoth : 0) },
    employer: { label: "employer 401(k) money", line: "employer-k401", amount: (e) => e.employer$, per: (e) => e.projection?.perCheck?.employerRetirement ?? 0 },
  },
  hsa: {
    employee: { label: "HSA from your pay", line: "hsa", amount: (e) => e.hsa, per: (e) => e.projection?.perCheck?.hsa ?? 0 },
    employer: { label: "employer HSA money", line: "employer-hsa", amount: (e) => e.employerHsa, per: (e) => e.projection?.perCheck?.employerHsa ?? 0 },
  },
};

/** The lines one employer adds to a pay figure: its year to date and, projected, the rest of the year. */
function employerLines(r: TaxAccountsReport, p: PersonAccounts, e: EmployerPlan, f: Flow, projected: boolean, estimates: ProofEstimate[]): ChainLine[] {
  const a = f.amount(e);
  const name = e.employer;
  const lines: ChainLine[] = [];
  const payLink: ProofLink | undefined = e.employerKey
    ? { label: `${name} stubs, ${r.year}`, descriptor: { report: "pay", basis: "ytd", personId: p.id, employerKeys: [e.employerKey], lines: [f.line], year: r.year, through: e.through } }
    : undefined;
  const fromW2 = e.w2 && f.line === "k401";
  lines.push({
    op: "+",
    label: fromW2 ? `${name}: W-2 box 12 (codes D and AA)` : `${name}: ${f.label}, year to date on the ${e.through} stub`,
    value: { cents: a.ytd },
    source: "proven",
    ...(fromW2 ? { note: "The W-2 on file replaces the stubs' year to date for a finished year; the link opens the stubs." } : {}),
    ...(payLink ? { link: payLink } : {}),
  });
  if (!projected || a.projected === a.ytd) return lines;
  const proj = e.projection;
  const per = f.per(e);
  const repeated = proj ? proj.checks * per : 0;
  if (repeated) {
    lines.push({
      op: "+",
      label: `${proj!.checks} more paycheck${proj!.checks === 1 ? "" : "s"} to Dec 31 × ${money(per)}`,
      value: { cents: repeated },
      source: "estimate",
      note: `The ${proj!.basis === "TYPICAL" ? "typical recent" : "latest"} regular check's ${f.label}, repeated for each pay date after the ${e.through} stub.`,
      // No forecast ledger cell: its lines are household-wide (toRetirement also holds employer money), so none holds one person's deferrals; the pay seed is the source.
      ...(proj!.fromForecast ? { link: { label: `${p.name}'s pay in the forecast`, descriptor: { report: "forecast", figure: "seed", which: "pay", personId: p.id, paycheck: proj!.basis } } } : {}),
    });
    estimates.push({ id: `account-limits:${p.id}:${e.employer}:${f.line}`, title: `${p.name}'s ${f.label} from ${name} for the ${proj!.checks} pay dates left in ${r.year}`, detail: "The regular paycheck repeated; a raise, a change of election or a bonus deferral would move it." });
  }
  const rest = a.projected - a.ytd - repeated;
  if (rest)
    lines.push({
      op: rest < 0 ? "−" : "+",
      label: rest < 0 ? "Payroll stops at the year's limit" : "Other pay to Dec 31",
      value: { cents: Math.abs(rest) },
      source: rest < 0 ? "law" : "estimate",
      note: rest < 0 ? "Deferrals stop once the annual limit is reached, so the repeated check is cut back." : undefined,
    });
  return lines;
}

/** 401(k) or HSA money from pay, year to date or projected to Dec 31. */
function payFlow(book: Book, r: TaxAccountsReport, p: PersonAccounts, d: AccountLimitsDescriptor): Built {
  const acct = d.account as "k401" | "hsa";
  const projected = d.figure === "projected";
  const pick = (a: Amount) => (projected ? a.projected : a.ytd);
  const parts: ("employee" | "employer")[] = d.part ? [d.part] : acct === "k401" ? ["employee"] : ["employee", "employer"];
  const emps = p.k401.employers.filter((e) => !d.employer || e.employer === d.employer);
  if (d.employer && !emps.length) return notFound(`${p.name} has no ${d.employer} pay in ${r.year}.`);
  const estimates: ProofEstimate[] = [];
  const blocks: ProofBlock[] = [];
  let parts$ = 0;
  for (const e of emps) {
    const lines = parts.flatMap((part) => employerLines(r, p, e, FLOWS[acct][part], projected, estimates)).filter((l, i) => i === 0 || ("cents" in l.value && l.value.cents !== 0));
    if (!lines.length) continue;
    lines[0] = { ...lines[0]!, op: undefined };
    const sub = total(lines);
    parts$ += sub;
    lines.push({ op: "=", label: `${e.employer}${e.active ? "" : " (former)"}`, value: { cents: sub }, source: lines.some((l) => l.source === "estimate") ? "estimate" : "proven" });
    blocks.push({ kind: "chain", title: e.employer, lines });
  }
  const outside = acct === "hsa" && !d.part && !d.employer ? p.hsa.outsidePayroll : 0;
  if (outside) {
    parts$ += outside;
    blocks.push({ kind: "chain", title: "Outside payroll", lines: [{ label: "HSA contributions made outside payroll", value: { cents: outside }, source: "assumption", note: `Typed on the Taxes page's Inputs for ${r.year}.` }] });
  }
  // The figure as the page shows it.
  const figure = d.employer
    ? emps.reduce((t, e) => t + parts.reduce((u, part) => u + pick(FLOWS[acct][part].amount(e)), 0), 0)
    : acct === "k401"
      ? pick(parts[0] === "employer" ? p.k401.employers.reduce((s, e) => ({ ytd: s.ytd + e.employer$.ytd, projected: s.projected + e.employer$.projected }), { ytd: 0, projected: 0 }) : p.k401.total)
      : pick(d.part === "employee" ? p.hsa.employee : d.part === "employer" ? p.hsa.employer : p.hsa.total);
  if (acct === "k401" && !d.part && !d.employer && p.k401.roth.ytd + p.k401.roth.projected > 0)
    blocks.push({
      kind: "breakdown",
      title: "Pre-tax and Roth",
      items: [
        { label: "Pre-tax", value: { cents: pick(p.k401.pretax) } },
        { label: "Roth", value: { cents: pick(p.k401.roth) } },
      ],
      note: "Both count toward the one elective-deferral limit.",
    });
  const keys = emps.map((e) => e.employerKey).filter((k): k is string => !!k);
  const { checks } = checksFor(book, { affects: "PAY", personId: p.id, from: `${r.year}-01-01`, to: p.through ?? `${r.year}-12-31`, ...(keys.length ? { employerKeys: keys } : {}) }, PAY_LIMIT_CHECKS);
  const whose = d.part === "employer" ? (acct === "k401" ? "employer 401(k) money" : "employer HSA money") : acct === "k401" ? "401(k) deferrals" : d.part === "employee" ? "HSA from pay" : "HSA contributions";
  return {
    describes: `${p.name} · ${whose}, ${r.year}${projected ? " projected to Dec 31" : " so far"}${d.employer ? ` · ${d.employer}` : ""}`,
    figure: { cents: figure },
    selfCheck: sumCheck(figure, parts$, `The parts below add up to ${money(parts$)}`),
    blocks: blocks.length ? blocks : [{ kind: "chain", title: "Nothing this year", lines: [{ label: `No ${whose} on ${p.name}'s ${r.year} stubs`, value: { cents: 0 }, source: "proven" }] }],
    checks,
    withheld: p.blockers.length > 0,
    estimates,
    through: p.through ?? `${r.year}-12-31`,
  };
}

// ------------------------------------------------------------------- limits

function ageLines(r: TaxAccountsReport, p: PersonAccounts, birthYears: Record<string, number>, from: number, word: string): ChainLine[] {
  const by = birthYears[p.id];
  if (!by) return [{ label: "Birth year", value: { text: "not set" }, source: "assumption", note: `No birth year under Settings › Household, so no ${word} catch-up is counted.` }];
  return [
    { label: "Birth year", value: { text: String(by) }, source: "assumption", note: "Typed under Settings › Household." },
    { label: `Age at the end of ${r.year}`, value: { text: String(r.year - by) }, source: "derived", note: `Catch-up contributions start at ${from}.` },
  ];
}

function limitProof(r: TaxAccountsReport, inputs: AccountLimitsInputs, d: AccountLimitsDescriptor, p: PersonAccounts | null): Built {
  const params = taxYearParams(r.year);
  const fp = params.federal;
  const lim = fp.retirement;
  const lines: ChainLine[] = [];
  let figure = 0;
  let describes = "";
  if (d.account === "k401" && p) {
    lines.push({ label: `401(k) elective-deferral limit, ${r.year}`, value: { cents: fp.limits.k401 }, source: "law" }, ...ageLines(r, p, inputs.birthYears, 50, "401(k)"));
    if (p.k401.catchUp) lines.push({ op: "+", label: p.age != null && p.age >= 60 && p.age <= 63 ? "Catch-up at ages 60–63" : "Catch-up at 50 and over", value: { cents: p.k401.catchUp }, source: "law" });
    figure = p.k401.limit;
    describes = `${p.name} · 401(k) deferral limit, ${r.year}`;
  } else if (d.account === "hsa" && p) {
    const c = p.hsa.coverage;
    lines.push({
      label: "HSA coverage",
      value: { text: c === "NONE" ? "No HSA-eligible plan" : c === "FAMILY" ? "Family" : "Self-only" },
      source: p.hsa.assumed ? "derived" : "assumption",
      note: p.hsa.assumed ? "Assumed from the stubs: HSA money on them means a plan, family when the household has dependents. Set it on Inputs." : "Chosen on Inputs.",
    });
    if (c !== "NONE") {
      lines.push({ op: "+", label: `${c === "FAMILY" ? "Family" : "Self-only"} HSA limit, ${r.year}`, value: { cents: c === "FAMILY" ? fp.limits.hsaFamily : fp.limits.hsaSelf }, source: "law" }, ...ageLines(r, p, inputs.birthYears, 55, "HSA"));
      if (p.age != null && p.age >= 55) lines.push({ op: "+", label: "Catch-up at 55 and over", value: { cents: lim.hsaCatchUp55 }, source: "law" });
    }
    figure = p.hsa.limit;
    describes = `${p.name} · HSA limit, ${r.year}`;
  } else if (d.account === "ira" && p) {
    lines.push({ label: `IRA contribution limit, ${r.year}`, value: { cents: fp.limits.ira }, source: "law", note: "Traditional and Roth together." }, ...ageLines(r, p, inputs.birthYears, 50, "IRA"));
    if (p.age != null && p.age >= 50) lines.push({ op: "+", label: "Catch-up at 50 and over", value: { cents: lim.iraCatchUp }, source: "law" });
    figure = p.ira.limit;
    describes = `${p.name} · IRA limit, ${r.year}`;
  } else {
    lines.push(
      { label: "Filing status", value: { text: r.filingStatus === "MFJ" ? "Married filing jointly" : "Single" }, source: "derived", note: "From the household's members." },
      { op: "+", label: `Connecticut's CHET deduction cap, ${r.year}`, value: { cents: params.ct.chetDeduction[r.filingStatus] }, source: "law" },
    );
    figure = r.household.chet.deductionLimit;
    describes = `CHET 529 deduction limit, ${r.year}`;
  }
  const parts = total(lines);
  lines.push({ op: "=", label: "Limit", value: { cents: figure }, source: "law" });
  return {
    describes,
    figure: { cents: figure },
    selfCheck: sumCheck(figure, parts, lines.some((l) => l.op === "+" && l.label.startsWith("Catch-up")) ? `The law's limit and catch-up come to ${money(parts)}` : `The law's limit is ${money(parts)}`),
    blocks: [{ kind: "chain", title: "The limit", lines, note: r.paramsNotes[0] }],
  };
}

// ------------------------------------------------------------------- IRA and CHET

function iraUsed(book: Book, r: TaxAccountsReport, p: PersonAccounts): Built {
  // The same reading the report made (taxAdvantaged.iraYear), with the rows behind each account.
  const iras = book.accounts.filter((a) => IRA_SUBTYPES.includes(a.subtype ?? "") && accountOwner(book, a.id) === p.id);
  const rows = p.ira.contributions.flatMap((c) => c.rowIds.map((id) => book.rowById.get(id)).filter((x): x is BookRow => !!x));
  const sum = rows.reduce((t, x) => t + x.amountCents, 0);
  const blocks: ProofBlock[] = [];
  if (p.ira.contributions.length > 1) blocks.push({ kind: "breakdown", title: "By account", items: p.ira.contributions.map((c) => ({ label: c.account, sub: c.kind === "ROTH_IRA" ? "Roth" : "Traditional", value: { cents: c.cents } })) });
  if (rows.length)
    blocks.push({
      kind: "rows",
      title: "Contributions on the IRA statements",
      figureCents: p.ira.total,
      groups: groupRows(book, rows),
      note: "Money arriving from a bank or taxable account. Rollovers, conversions and money from another retirement account aren't contributions.",
    });
  else blocks.push({ kind: "chain", title: "Nothing this year", lines: [{ label: `No contributions on ${iras.length ? iras.map((a) => a.name).join(", ") : "any IRA statement"} in ${r.year}`, value: { cents: 0 }, source: "proven" }] });
  const from = `${r.year}-01-01`;
  // As iraYear counts them: the year in progress through the data edge.
  const to = taxYearThrough(book, r.year);
  const accountIds = iras.map((a) => a.id);
  const { checks, withheld } = accountIds.length ? checksFor(book, { affects: "NET_WORTH", from, to, accountIds }, STATEMENT_CHECKS) : { checks: [], withheld: false };
  return {
    describes: `${p.name} · IRA contributions, ${r.year}`,
    figure: { cents: p.ira.total },
    selfCheck: sumCheck(p.ira.total, sum, `The ${rows.length} row${rows.length === 1 ? "" : "s"} below add up to ${money(sum)}`),
    blocks,
    checks,
    withheld,
    estimates: estimatesFor(book, { rowIds: new Set(rows.map((x) => x.id)), from, to, accountIds }),
    through: book.horizon.netWorth < to ? book.horizon.netWorth : to,
  };
}

function chetUsed(book: Book, r: TaxAccountsReport): Built {
  const chet = chetYear(book, r.year);
  const lines: ChainLine[] = [];
  const blocks: ProofBlock[] = [];
  for (const a of chet.accounts) {
    const printed = a.statement != null ? book.brokerage.find((b) => b.accountNumber === a.accountNumber && b.periodEnd.startsWith(String(r.year)) && b.contributionsYtd === a.statement) : null;
    lines.push({
      op: lines.length ? "+" : undefined,
      label: printed ? `${a.name}: contributions year to date on the ${printed.periodEnd} statement` : `${a.name}: deposits in the ledger`,
      value: { cents: a.cents },
      source: "proven",
      note:
        a.statement != null && a.ledger != null
          ? a.statement === a.ledger
            ? `The ledger's deposits into it add up to the same ${money(a.ledger)}.`
            : `The ledger's deposits into it add up to ${money(a.ledger)}: see the warning on the page.`
          : "No statement prints a contributions line for the year.",
    });
    const rows = a.rowIds.map((id) => book.rowById.get(id)).filter((x): x is BookRow => !!x);
    if (rows.length) blocks.push({ kind: "rows", title: `${a.name}: deposits the ledger shows`, figureCents: rows.reduce((t, x) => t + x.amountCents, 0), groups: groupRows(book, rows), note: a.statement != null ? "They check the statement's line." : "What counts, with no statement line." });
  }
  const parts = total(lines);
  if (lines.length) lines.push({ op: "=", label: "Contributed", value: { cents: r.household.chet.contributed }, source: "proven" });
  else lines.push({ label: `No CHET statements for ${r.year}`, value: { cents: 0 }, source: "proven" });
  const accountIds = chet.accounts.flatMap((a) => book.accounts.filter((x) => x.identifiers.includes(a.accountNumber)).map((x) => x.id));
  const from = `${r.year}-01-01`;
  // As chetYear counts them: the year in progress through the data edge.
  const to = taxYearThrough(book, r.year);
  const { checks, withheld } = accountIds.length ? checksFor(book, { affects: "NET_WORTH", from, to, accountIds }, STATEMENT_CHECKS) : { checks: [], withheld: false };
  return {
    describes: `CHET 529 contributions, ${r.year}`,
    figure: { cents: r.household.chet.contributed },
    selfCheck: sumCheck(r.household.chet.contributed, parts, `The ${chet.accounts.length} account${chet.accounts.length === 1 ? "" : "s"} below add up to ${money(parts)}`),
    blocks: [{ kind: "chain", title: "Each account", lines }, ...blocks],
    checks,
    withheld,
    through: book.horizon.netWorth < to ? book.horizon.netWorth : to,
  };
}

// ------------------------------------------------------------------- room and excess

function roomProof(r: TaxAccountsReport, d: AccountLimitsDescriptor, p: PersonAccounts | null): Built {
  const proj = d.account === "k401" || d.account === "hsa";
  const counted = d.account === "k401" ? p!.k401.total.projected : d.account === "hsa" ? p!.hsa.total.projected : d.account === "ira" ? p!.ira.total : r.household.chet.contributed;
  const limit = d.account === "k401" ? p!.k401.limit : d.account === "hsa" ? p!.hsa.limit : d.account === "ira" ? p!.ira.limit : r.household.chet.deductionLimit;
  const room = d.account === "k401" ? p!.k401.room : d.account === "hsa" ? p!.hsa.room : d.account === "ira" ? p!.ira.room : r.steps.find((s) => s.id === "chet")?.roomCents ?? pos(limit - counted);
  const name = { k401: "401(k) deferrals", hsa: "HSA contributions", ira: "IRA contributions", chet: "CHET contributions", steps: "" }[d.account];
  const lines: ChainLine[] = [
    { label: "Limit", value: { cents: limit }, source: "law", link: link("The limit", d, { figure: "limit" }) },
    { op: "−", label: `${name}${proj ? " projected to Dec 31" : ` in ${r.year}`}`, value: { cents: counted }, source: proj && r.isCurrentYear ? "estimate" : "proven", link: link(name, d, { figure: proj ? "projected" : "used" }) },
    // Over the limit, the difference is shown as it is and room is zero: no step claims −$X is $0.
    ...(counted > limit
      ? ([
          { op: "=", label: "Over the limit by", value: { cents: limit - counted }, source: "derived" },
          { label: "Room left (none once over)", value: { cents: room }, source: "derived" },
        ] satisfies ChainLine[])
      : ([{ op: "=", label: "Room left", value: { cents: room }, source: "derived" }] satisfies ChainLine[])),
  ];
  const blocks: ProofBlock[] = [{ kind: "chain", title: "Room left", lines }];
  if (d.account === "k401" && p!.k401.perPaycheckToMax != null && room)
    blocks.push({
      kind: "chain",
      title: "To fill it",
      lines: [
        { label: "Room left", value: { cents: room }, source: "derived" },
        { op: "÷", label: `Paychecks left in ${r.year}`, value: { text: String(p!.remainingPaychecks) }, source: "estimate" },
        { op: "=", label: "More per paycheck (rounded up)", value: { cents: p!.k401.perPaycheckToMax! }, source: "derived" },
      ],
    });
  return {
    describes: `${p ? `${p.name} · ` : ""}${{ k401: "401(k)", hsa: "HSA", ira: "IRA", chet: "CHET 529 deduction", steps: "" }[d.account]} room left, ${r.year}`,
    figure: { cents: room },
    selfCheck: sumCheck(room, pos(limit - counted), `${money(limit)} − ${money(counted)}${counted > limit ? " is below zero, so no room" : ` is ${money(limit - counted)}`}`),
    blocks,
  };
}

function excessProof(r: TaxAccountsReport, d: AccountLimitsDescriptor, p: PersonAccounts): Built {
  const deferred = p.k401.total.projected;
  const x = p.k401.excessDeferral;
  const lines: ChainLine[] = [
    { label: "401(k) deferrals across employers", value: { cents: deferred }, source: r.isCurrentYear ? "estimate" : "proven", link: link("401(k) deferrals", d, { figure: "projected" }) },
    { op: "−", label: "Limit", value: { cents: p.k401.limit }, source: "law", link: link("The limit", d, { figure: "limit" }) },
    { op: "=", label: "Over the limit", value: { cents: p.k401.excess }, source: "derived" },
  ];
  const blocks: ProofBlock[] = [{ kind: "chain", title: "The excess", lines }];
  if (x) {
    const status = { RETURNED: "Returned in time", RETURNED_LATE: "Returned, not provably in time", AWAITING: "Not returned yet", NOT_RETURNED: "Not returned" }[x.status];
    const ret: ChainLine[] = [{ label: "Must be out of the plan by", value: { text: x.deadline }, source: "law" }];
    if (x.returned)
      ret.push({
        label: `Withdrawal on ${x.returned.account}'s statement ${x.returned.statement.start} – ${x.returned.statement.end}`,
        value: { cents: x.returned.cents },
        source: "proven",
        note: x.returned.deposit ? `Deposited to ${x.returned.deposit.account} on ${x.returned.deposit.date}.` : "No bank deposit of that amount was found.",
      });
    ret.push({ label: "Status", value: { text: status }, source: x.returned ? "proven" : "derived", note: "The excess counts as income for the year it was deferred, on the Taxes page." });
    blocks.push({ kind: "chain", title: "Its return", lines: ret });
  }
  return {
    describes: `${p.name} · 401(k) deferrals over the limit, ${r.year}`,
    figure: { cents: p.k401.excess },
    selfCheck: sumCheck(p.k401.excess, pos(deferred - p.k401.limit), `${money(deferred)} − ${money(p.k401.limit)} is ${money(pos(deferred - p.k401.limit))}`),
    blocks,
  };
}

// ------------------------------------------------------------------- the headline figures

/** The steps the page's "Pre-tax room left" adds: every open pre-tax step (match, HSA, 401(k)), whether or not a rate is known. */
const pretaxSteps = (r: TaxAccountsReport) => r.steps.filter((s) => s.pretax && !s.done);

function stepLink(r: TaxAccountsReport, id: string): ProofLink | undefined {
  const [kind, personId] = [id.split("-")[0], id.slice(id.indexOf("-") + 1)];
  const base = { report: "account-limits" as const, year: r.year, figure: "room" as const };
  if (kind === "k401" || kind === "hsa" || kind === "ira") return { label: "Room left", descriptor: { ...base, account: kind, personId } };
  if (id === "chet") return { label: "Room left", descriptor: { ...base, account: "chet" } };
  return undefined;
}

const MATCH_NOTE = "The deferral that earns the whole match (projected gross × the match's share of pay you typed on Inputs) less your projected deferrals.";

function stepsProof(r: TaxAccountsReport, d: AccountLimitsDescriptor): Built {
  const steps = pretaxSteps(r);
  const rate = r.marginalRate.rate;
  // With no rate known the tax saved is unknown: the room is listed, the rate says what's missing.
  const saved = d.figure === "tax-saved" && rate != null;
  const unknown = d.figure === "tax-saved" && rate == null;
  const lines: ChainLine[] = steps.map((s, i) => {
    const l = stepLink(r, s.id);
    const match = s.id.startsWith("match-");
    return {
      op: i ? ("+" as const) : undefined,
      label: saved ? `${s.title}: ${money(s.roomCents)} × the rate` : s.title,
      value: { cents: saved ? (s.taxSavedCents ?? 0) : s.roomCents },
      source: match ? ("assumption" as const) : ("derived" as const),
      ...(match ? { note: MATCH_NOTE } : {}),
      ...(l ? { link: l } : {}),
    };
  });
  const parts = total(lines);
  const figure = saved ? (r.pretax.taxSavedCents ?? 0) : r.pretax.roomCents;
  if (lines.length) lines.push({ op: "=", label: saved ? "Tax it would save" : "Pre-tax room left", value: { cents: saved ? figure : parts }, source: saved ? "estimate" : "derived" });
  else lines.push({ label: "Every pre-tax limit is filled", value: { cents: 0 }, source: "derived" });
  const blocks: ProofBlock[] = [
    {
      kind: "chain",
      title: saved ? "Each open pre-tax limit" : "Open pre-tax limits",
      lines,
      note: saved ? undefined : "The employer-match step and the 401(k) step both count the 401(k)'s shortfall, as the page lists them.",
    },
  ];
  if (d.figure === "tax-saved")
    blocks.push({
      kind: "chain",
      title: "The rate",
      lines: [
        rate == null
          ? { label: "Federal + state on the next pre-tax dollar", value: { text: "unknown" }, source: "assumption", note: "No rate typed on Inputs and no provable tax estimate for this year or last, so the tax saved can't be worked out." }
          : {
              label: "Federal + state on the next pre-tax dollar",
              value: { ratio: rate },
              source: r.marginalRate.source === "SETTING" ? "assumption" : "derived",
              note: r.marginalRate.source === "SETTING" ? "Typed on Inputs." : r.marginalRate.source === "PRIOR_YEAR" ? `${r.year - 1}'s tax estimate (this year's isn't provable yet).` : "The tax estimate's marginal rates.",
            },
      ],
    });
  const n = `${steps.length} open limit${steps.length === 1 ? "" : "s"}`;
  return {
    describes: d.figure === "tax-saved" ? `Tax the open pre-tax limits would save, ${r.year} (${rate == null ? "no marginal rate known" : `at ${formatPercentRatio(rate, 1)}`})` : `Pre-tax room left, ${r.year}`,
    figure: unknown ? { text: "Unknown" } : { cents: figure },
    selfCheck: unknown ? null : sumCheck(figure, parts, `The ${n} below add up to ${money(parts)}`),
    blocks,
    estimates: saved && steps.length ? [{ id: "account-limits:tax-saved", title: "Tax saved at one marginal rate", detail: "Each dollar of room times the rate on the next dollar; a large amount could cross a bracket." }] : [],
  };
}

// -------------------------------------------------------------------

function notFound(why: string): Built {
  return { describes: why, figure: { text: "—" }, selfCheck: null, blocks: [], withheld: true };
}

export function buildAccountLimitsProof(book: Book, inputs: AccountLimitsInputs, d: AccountLimitsDescriptor): Proof {
  const r = inputs.report;
  const p = d.personId ? (r.people.find((x) => x.id === d.personId) ?? null) : null;
  let built: Built;
  if (d.personId && !p) built = notFound(`No household member ${d.personId}.`);
  else if (d.account === "steps") built = stepsProof(r, d);
  else if (d.figure === "limit") built = limitProof(r, inputs, d, p);
  else if (d.figure === "room") built = roomProof(r, d, p);
  else if (d.figure === "excess") built = excessProof(r, d, p!);
  else if (d.account === "ira") built = iraUsed(book, r, p!);
  else if (d.account === "chet") built = chetUsed(book, r);
  else built = payFlow(book, r, p!, d);
  return {
    report: "account-limits",
    descriptor: d,
    checks: [],
    withheld: false,
    estimates: [],
    ...built,
    through: built.through ?? (r.isCurrentYear ? r.today : `${r.year}-12-31`),
    today: book.today,
  };
}

/** The page's report for the year, built as GET /api/tax-accounts builds it. */
export async function accountLimitsInputs(ctx: ProofContext, year: number): Promise<AccountLimitsInputs> {
  return perBook(ctx, `account-limits|${year}`, () => loadAccountLimitsInputs(ctx, year));
}

async function loadAccountLimitsInputs(ctx: ProofContext, year: number): Promise<AccountLimitsInputs> {
  const [settings, { forecast }] = await Promise.all([loadJsonSetting(ctx.db, RETIREMENT_SETTINGS_KEY, normalizeRetirementSettings), loadForecast(ctx.db, ctx.book)]);
  return { report: buildTaxAccounts(ctx.book, year, settings, forecast ? taxLink(forecast) : null), birthYears: ctx.book.birthYears ?? {}, settings };
}

export const accountLimitsKind: ProofKind<AccountLimitsDescriptor> = {
  report: "account-limits",
  parse: parseAccountLimitsDescriptor,
  build: async (ctx, d) => {
    if (!Object.hasOwn(TAX_YEARS, String(d.year)))
      return { report: "account-limits", descriptor: d, describes: `No tax law on file for ${d.year}`, figure: { text: "—" }, selfCheck: null, withheld: true, blocks: [], checks: [], estimates: [], through: "", today: ctx.book.today };
    return buildAccountLimitsProof(ctx.book, await accountLimitsInputs(ctx, d.year), d);
  },
};
