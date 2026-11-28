import { usdText } from "../formatMoney.ts";
import { noteBook, type NoteBook } from "../book/said.ts";
import { type BookStub } from "../book/load.ts";
import { statementContributionsYtd } from "../book/taxAdvantaged.ts";
import { type PersonIncome } from "./computeReturn.ts";
import { ctResidentShares, w2FromForm, type DocRef, type YearDocs } from "./documents.ts";
import { ACCOUNT_KIND_LABEL, CHILD_KINDS, type AccountTaxKind } from "./facts/investments.ts";
import { projectPayroll, ZERO_AMOUNTS, type PayrollAmounts, type PayrollProjection } from "./facts/payroll.ts";
import { type TaxYearParams } from "./params.ts";
import { type NyResidency, type PayForecast, type Residency, type TaxPerson, type TaxProfile } from "./profile.ts";
import type { FidelitySnapshot, InvestmentFigures, AccountIncome, PayrollEntry, ChildIncome, PersonReport, TaxReport } from "./taxReportTypes.ts";

/** The tax report's parts beside buildTaxReport (buildTaxReport.ts): payroll, residency, 1099s, investment accounts, a child's income. */
export const pos = (n: number) => Math.max(0, n);
export const usd = (cents: number) => usdText(cents, { whole: true });
/** Employer and payroll HSA contributions (W-2 box 12 W) above the year's family limit are taxable and draw a 6% excise tax. */
export function hsaCheck(people: PersonReport[], fp: TaxYearParams["federal"], warnings: string[]) {
  const total = people.reduce((s, p) => s + p.payroll.reduce((t, x) => t + x.w2Projected.box12.W, 0), 0);
  // Whole dollars: a projection a few cents over the limit isn't an excess contribution.
  if (Math.round(total / 100) > Math.round(fp.limits.hsaFamily / 100)) {
    warnings.push(
      `HSA contributions through payroll (W-2 box 12 W) total ${usd(total)}, over the ${usd(fp.limits.hsaFamily)} family limit (plus $1,000 each at 55+). The excess is taxable wages unless withdrawn by the filing deadline (Form 8889).`,
    );
  }
}

/**
 * A W-2 form from an employer with no pay stubs on file: its boxes stand alone (nothing
 * to project; the year is over).
 */
export function formOnlyPayroll(form: import("../taxdocs/types.ts").W2Form, doc: DocRef, name: string): PayrollEntry {
  const w2 = w2FromForm(form, null);
  const ytd: PayrollAmounts = {
    ...ZERO_AMOUNTS,
    gross: form.medicareWages,
    federalWithheld: form.federalWithheld,
    ssWithheld: form.ssWithheld,
    medicareWithheld: form.medicareWithheld,
    stateWithheld: w2.stateWithheld,
    otherStateWithheld: w2.otherStateWithheld,
  };
  return {
    employer: form.employer,
    employee: name,
    source: "W2" as PayrollProjection["source"],
    latestPayDate: "",
    frequency: "SEMIMONTHLY",
    remainingPayDates: [],
    regularPaycheck: null,
    basis: "LATEST",
    latestRegular: null,
    typicalRegular: null,
    payThrough: null,
    extraBonus: 0,
    ytd,
    projected: ytd,
    w2Ytd: w2,
    w2Projected: w2,
    lines: [],
    federalFilingStatus: null,
    active: false,
    w2Doc: doc,
    stubW2: null,
  };
}

/**
 * A finished year's brokerage 1099s replace the statements' figures for their accounts
 * (matched by the last four digits). For a year in progress, last year's 1099 for the
 * same account sets how much of its dividends are qualified and how much is REIT (199A)
 * income — better than one household-wide guess.
 */
export function applyBrokerage1099s(accounts: AccountIncome[], docs: YearDocs | null, lastYear: YearDocs, profile: TaxProfile, warnings: string[]) {
  for (const a of accounts) {
    a.source = "STATEMENTS";
    a.doc = null;
    a.fromStatements = null;
    a.calibratedFrom = null;
  }
  const tail = (n: string) => n.replace(/\D/g, "").slice(-4);
  for (const f of docs?.brokerage ?? []) {
    const a = accounts.find((x) => x.kind === "TAXABLE" && f.form.account && tail(x.accountNumber) === f.form.account);
    const d = f.form.div;
    const figures: InvestmentFigures = {
      ordinaryDividends: d.ordinary,
      qualifiedDividends: d.qualified,
      moneyMarketDividends: a?.ytd.moneyMarketDividends ?? 0,
      interest: f.form.int.interest,
      capGainDistShort: 0,
      capGainDistLong: d.capitalGainDistributions,
      shortTermGain: f.form.b.shortTermGain,
      longTermGain: f.form.b.longTermGain + f.form.b.unknownTermGain,
      foreignTax: d.foreignTax + f.form.int.foreignTax,
      taxExempt: d.exemptInterest + f.form.int.taxExempt,
      section199a: d.section199a,
      usTreasury: f.form.int.usTreasury,
    };
    if (a) {
      a.fromStatements = a.ytd;
      a.ytd = figures;
      a.projected = figures;
      a.source = "1099";
      a.doc = f.doc;
    } else {
      warnings.push(`The ${f.form.payer} 1099 for account ••${f.form.account ?? "?"} matches no investment statements on file; its figures are counted as filed.`);
      accounts.push({
        accountNumber: f.form.account ?? f.doc.id,
        label: `${f.form.payer} ••${f.form.account ?? "?"} (1099 only)`,
        kind: "TAXABLE",
        ownerId: f.personId ?? profile.persons[0]!.id,
        ownerLine: f.form.recipient,
        latestStatement: "",
        ytd: figures,
        projected: figures,
        projection: { factor: 1, method: "FINAL" },
        distributions: [],
        contributionsYtd: null,
        isChet: false,
        endingValue: null,
        statementKind: "TAXABLE",
        child: null,
        source: "1099",
        doc: f.doc,
        fromStatements: null,
        januaryDividends: [],
        calibratedFrom: null,
      });
    }
  }
  if (docs) {
    for (const a of accounts.filter((x) => x.kind === "TAXABLE" && x.source === "STATEMENTS" && x.ytd.ordinaryDividends + x.ytd.interest > 1_000)) {
      if (docs.federal) warnings.push(`No 1099 for ${a.label} is in the tax documents folder; its income comes from the statements.`);
    }
    return;
  }
  for (const a of accounts.filter((x) => x.kind === "TAXABLE")) {
    const prev = lastYear.brokerage.find((f) => f.form.account && tail(a.accountNumber) === f.form.account);
    if (!prev || prev.form.div.ordinary <= 0) continue;
    const q = prev.form.div.qualified / prev.form.div.ordinary;
    const reit = prev.form.div.section199a / prev.form.div.ordinary;
    for (const pick of ["ytd", "projected"] as const) {
      a[pick] = { ...a[pick], qualifiedDividends: Math.round(a[pick].ordinaryDividends * q), section199a: Math.round(a[pick].ordinaryDividends * reit) };
    }
    a.calibratedFrom = lastYear.year;
  }
  // No 1099 from last year to read the split from: the qualified share is the one typed under Inputs.
  for (const a of accounts.filter((x) => x.kind === "TAXABLE" && x.source === "STATEMENTS" && x.calibratedFrom == null && x.ytd.ordinaryDividends > 0))
    warnings.push(`${a.label}: no ${lastYear.year} 1099 to read the qualified share of its dividends from, so the qualified share set under Inputs counts for its fund and stock dividends. The year's 1099 will settle it.`);
}

/** The share of the year before `d` (a move out), or null without a date. */
export function beforeMove(d: string | null, year: number): number | null {
  if (!d) return null;
  const daysInYear = (Date.parse(`${year + 1}-01-01`) - Date.parse(`${year}-01-01`)) / 86_400_000;
  return Math.min(1, Math.max(0, (Date.parse(d) - Date.parse(`${year}-01-01`)) / 86_400_000 / daysInYear));
}

/**
 * New York for the year: as entered under Inputs; else the filed New York return (IT-201: a
 * full-year resident; IT-203 with a move date: part-year; IT-203 alone: nonresident; City
 * tax on it: the City too); else New York withholding (moved to Connecticut during the
 * year: part-year until the move; otherwise a nonresident working there, or a resident
 * when not living in Connecticut at all).
 */
export function nyFor(entered: NyResidency | null, docs: YearDocs, ct: TaxReport["residency"], withheld: { state: boolean; city: boolean }, year: number): TaxReport["ny"] {
  const make = (r: NyResidency, source: NonNullable<TaxReport["ny"]>["source"]): TaxReport["ny"] => {
    if (r.state === "NONE") return null;
    // IT-360.1's proration: whole months lived in the City (a part month counts from 15 days).
    const months = r.city === "PART_YEAR" ? Math.round((beforeMove(r.movedOut, year) ?? 0) * 12) : r.city === "RESIDENT" ? 12 : 0;
    const state = r.state === "RESIDENT" ? "RESIDENT" : r.state === "PART_YEAR" ? "PART_YEAR" : "NONRESIDENT";
    return { ...r, source, filing: { state, city: r.city, cityMonths: months } };
  };
  if (entered) return make(entered, "INPUTS");
  const f = docs.ny;
  if (f) {
    const city = (f.state?.cityTax ?? 0) > 0 || f.lines.some((l) => l.form === "IT-360.1");
    if (f.form === "IT-201") return make({ state: "RESIDENT", city: city ? "RESIDENT" : "NONE", movedOut: null }, "FILED_RETURN");
    if (f.movedOn) return make({ state: "PART_YEAR", city: city ? "PART_YEAR" : "NONE", movedOut: f.movedOn }, "FILED_RETURN");
    return make({ state: "NONRESIDENT", city: "NONE", movedOut: null }, "FILED_RETURN");
  }
  if (!withheld.state && !withheld.city) return null;
  if (ct.ct === "PART_YEAR" && ct.movedIn) return make({ state: "PART_YEAR", city: withheld.city ? "PART_YEAR" : "NONE", movedOut: ct.movedIn }, "WITHHOLDING");
  if (ct.ct === "NONRESIDENT") return make({ state: "RESIDENT", city: withheld.city ? "RESIDENT" : "NONE", movedOut: null }, "WITHHOLDING");
  return make({ state: "NONRESIDENT", city: "NONE", movedOut: null }, "WITHHOLDING");
}

export function residencyFor(entered: Residency | null, docs: YearDocs, year: number): TaxReport["residency"] {
  const daysInYear = (Date.parse(`${year + 1}-01-01`) - Date.parse(`${year}-01-01`)) / 86_400_000;
  const afterMove = (d: string | null) => (d ? Math.min(1, Math.max(0, ((Date.parse(`${year}-12-31`) - Date.parse(d)) / 86_400_000 + 1) / daysInYear)) : null);
  const filedShare = ctResidentShares(docs.ct).investment;
  if (entered) {
    const share = entered.ct === "FULL" ? 1 : entered.ct === "NONRESIDENT" ? 0 : (entered.investmentShare ?? filedShare ?? afterMove(entered.movedIn) ?? 1);
    return { ...entered, investmentShare: share, source: "INPUTS" };
  }
  if (docs.ct?.form === "CT-1040NR/PY") {
    const movedIn = docs.ny?.movedOn ?? null;
    if (movedIn || filedShare) return { ct: "PART_YEAR", movedIn, investmentShare: filedShare ?? afterMove(movedIn) ?? 1, sourceIncome: null, source: "FILED_RETURN" };
    return { ct: "NONRESIDENT", movedIn: null, investmentShare: 0, sourceIncome: null, source: "FILED_RETURN" };
  }
  if (docs.ny && !docs.ct) return { ct: "NONRESIDENT", movedIn: null, investmentShare: 0, sourceIncome: null, source: "FILED_RETURN" };
  return { ct: "FULL", movedIn: null, investmentShare: 1, sourceIncome: null, source: "DEFAULT" };
}

export function addAmounts(a: PayrollAmounts, b: PayrollAmounts): PayrollAmounts {
  const out = { ...a };
  for (const k of Object.keys(out) as (keyof PayrollAmounts)[]) out[k] += b[k];
  return out;
}

export const sumW2 = (i: PersonIncome) => i.w2s.reduce((s, w) => s + w.box1Wages, 0);

export function bumpWages(i: PersonIncome, cents: number): PersonIncome {
  const [first, ...rest] = i.w2s;
  return {
    ...i,
    w2s: [
      { ...first!, box1Wages: first!.box1Wages + cents, box5MedicareWages: first!.box5MedicareWages + cents, box16StateWages: first!.box16StateWages + cents, box3SsWages: first!.box3SsWages + cents },
      ...rest,
    ],
  };
}

/** One projection per employer; only the most recent employer keeps paying through year end. */
export function projectEmployers(
  stubs: BookStub[],
  params: TaxYearParams,
  expectedBonus: number,
  pay: PayForecast,
  isCurrentYear: boolean,
  asOf: string,
  warnings: string[],
  name: string,
  basisFromForecast = false,
  notes: NoteBook = noteBook("tax"),
): (PayrollProjection & { active: boolean })[] {
  const byEmployer = new Map<string, BookStub[]>();
  for (const s of stubs) byEmployer.set(s.employerKey, [...(byEmployer.get(s.employerKey) ?? []), s]);
  const latestOf = (ss: BookStub[]) => ss.reduce((m, s) => (s.payDate > m ? s.payDate : m), "");
  const groups = [...byEmployer.values()].sort((a, b) => latestOf(b).localeCompare(latestOf(a)));
  return groups.map((g, i) => {
    const active = i === 0;
    const p = projectPayroll(g, params.federal, active ? { extraBonus: expectedBonus, basis: pay.paycheck, payThrough: pay.payThrough } : {});
    if (!active) return { ...p, active, remainingPayDates: [], projected: p.ytd, w2Projected: p.w2Ytd, extraBonus: 0 };
    const ageDays = (Date.parse(asOf) - Date.parse(p.latestPayDate)) / 86_400_000;
    if (isCurrentYear && ageDays > 45) {
      warnings.push(`${name}'s latest ${p.employer} pay stub is from ${p.latestPayDate}; upload newer stubs for a sharper projection.`);
    }
    // A latest paycheck far from the typical one (reduced hours, leave, a raise) moves the
    // whole forecast; say which one is being repeated so it can be switched.
    const latest = p.latestRegular?.amounts.gross ?? 0;
    const typical = p.typicalRegular?.amounts.gross ?? 0;
    if (isCurrentYear && p.remainingPayDates.length && typical > 0 && Math.abs(latest - typical) / typical > 0.15) {
      const where = basisFromForecast ? "on the Forecast page" : "under Inputs";
      warnings.push(
        notes.say((x) => {
          const change = `${name}'s latest regular ${p.employer} paycheck (${p.latestRegular!.payDate}, ${x.usd(latest, `gross pay on the ${p.latestRegular!.payDate} stub`, undefined, usd)} gross) is ${x.pct(Math.abs(latest - typical) / typical, "how far it is from the typical recent paycheck")} ${latest < typical ? "below" : "above"} the typical recent one (${x.usd(typical, "the typical recent paycheck's gross pay", undefined, usd)})`;
          return p.basis === "LATEST"
            ? `${change}. The forecast repeats the latest; if it was a one-off, switch ${name}'s paycheck to "typical" ${where}.`
            : `${change}. The forecast repeats the typical paycheck, as chosen ${where}.`;
        }),
      );
    }
    return { ...p, active };
  });
}


export function investmentAccounts(
  snapshots: FidelitySnapshot[],
  year: number,
  profile: TaxProfile,
  personFor: (t: string) => TaxPerson | undefined,
  warnings: string[],
): AccountIncome[] {
  const y = String(year);
  const byAccount = new Map<string, FidelitySnapshot[]>();
  for (const s of snapshots) byAccount.set(s.accountNumber, [...(byAccount.get(s.accountNumber) ?? []), s]);
  const out: AccountIncome[] = [];
  for (const [acct, all] of byAccount) {
    const inYear = all.filter((s) => s.periodEnd.startsWith(y)).sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || Number(a.isYearEnd) - Number(b.isYearEnd));
    if (!inYear.length) continue;
    const latest = inYear.at(-1)!;
    const monthly = inYear.filter((s) => !s.isYearEnd);
    const kind = profile.accountKinds[acct] ?? latest.kind;
    // A type set under Inputs beats the statement; when the statement reads one, say they disagree.
    if (profile.accountKinds[acct] && latest.kind !== "OTHER" && profile.accountKinds[acct] !== latest.kind)
      warnings.push(`Account ••${acct.slice(-4)} is taxed as ${ACCOUNT_KIND_LABEL[kind]} (set under Inputs), though its statement reads ${ACCOUNT_KIND_LABEL[latest.kind]}.`);
    // A custodial account or Trump Account is the child's: no parent owns its income.
    const child = CHILD_KINDS.includes(kind) ? (profile.dependents.find((d) => latest.ownerLine.toUpperCase().includes(d.name.toUpperCase()))?.name ?? latest.ownerLine) : null;
    const ownerId = child
      ? "CHILD"
      : (profile.accountOwners[acct] ?? (/JOINT/i.test(latest.ownerLine) ? "JOINT" : personFor(latest.ownerLine)?.id ?? profile.persons[0]!.id));

    const inc = latest.income ?? { dividends: 0, interest: 0, capGainDistShort: 0, capGainDistLong: 0, taxExempt: 0, taxDeferred: 0 };
    const realized = [...inYear].reverse().find((s) => s.realized)?.realized ?? { shortTerm: 0, longTerm: 0 };
    // Split dividends using the individual payments seen this year.
    const rows = monthly.flatMap((s) => s.incomeRows).filter((r) => r.kind === "DIVIDEND");
    const rowTotal = rows.reduce((s, r) => s + r.amount, 0);
    const nqRows = rows.filter((r) => r.nonQualified).reduce((s, r) => s + r.amount, 0);
    const mmRows = rows.filter((r) => r.moneyMarket).reduce((s, r) => s + r.amount, 0);
    const nqShare = rowTotal > 0 ? nqRows / rowTotal : 0;
    const mmShare = rowTotal > 0 ? mmRows / rowTotal : 0;
    const foreign = Math.abs(monthly.flatMap((s) => s.incomeRows).filter((r) => r.kind === "FOREIGN_TAX").reduce((s, r) => s + r.amount, 0));
    const ordinary = inc.dividends;
    const ytd: InvestmentFigures = {
      ordinaryDividends: ordinary,
      qualifiedDividends: Math.round(ordinary * (1 - nqShare) * profile.qualifiedDividendShare),
      moneyMarketDividends: Math.round(ordinary * mmShare),
      interest: inc.interest,
      capGainDistShort: inc.capGainDistShort,
      capGainDistLong: inc.capGainDistLong,
      shortTermGain: realized.shortTerm,
      longTermGain: realized.longTerm,
      foreignTax: foreign,
      taxExempt: inc.taxExempt,
      section199a: 0,
      usTreasury: 0,
    };

    // Year-end projection of income (not of gains, which depend on future sales).
    let projection: AccountIncome["projection"] = { factor: 1, method: "FINAL" };
    const endMonth = Number(latest.periodEnd.slice(5, 7));
    if (latest.periodEnd < `${y}-12-31` && !latest.isYearEnd) {
      const prior = all.filter((s) => s.periodEnd.startsWith(String(year - 1)) && s.income);
      const sameMonth = prior.find((s) => Number(s.periodEnd.slice(5, 7)) === endMonth && !s.isYearEnd);
      const dec = prior.find((s) => s.periodEnd.endsWith("-12-31"));
      const linear = 12 / endMonth;
      if (sameMonth?.income && dec?.income && sameMonth.income.dividends > 0 && dec.income.dividends >= sameMonth.income.dividends) {
        projection = { factor: Math.min(dec.income.dividends / sameMonth.income.dividends, linear * 1.5), method: "SEASONAL" };
      } else {
        projection = { factor: linear, method: "LINEAR" };
      }
    }
    const scale = (n: number) => Math.round(n * projection.factor);
    const projected: InvestmentFigures = {
      ...ytd,
      ordinaryDividends: scale(ytd.ordinaryDividends),
      qualifiedDividends: scale(ytd.qualifiedDividends),
      moneyMarketDividends: scale(ytd.moneyMarketDividends),
      interest: scale(ytd.interest),
      foreignTax: scale(ytd.foreignTax),
      taxExempt: scale(ytd.taxExempt),
    };
    if (kind === "OTHER")
      warnings.push(`${latest.institution} account ${acct} (${latest.ownerLine}) has an unrecognized type, so its income is not counted. Set its type under Inputs → Investment accounts.`);
    out.push({
      accountNumber: acct,
      label: accountLabel(latest, kind),
      kind,
      statementKind: latest.kind,
      child,
      ownerId,
      ownerLine: latest.ownerLine,
      latestStatement: latest.periodEnd,
      ytd,
      projected,
      projection,
      distributions: monthly.flatMap((s) => s.distributions),
      contributionsYtd: statementContributionsYtd(inYear, year),
      isChet: latest.isChet,
      endingValue: latest.endingValue,
      source: "STATEMENTS",
      doc: null,
      fromStatements: null,
      januaryDividends: rows.filter((r) => !r.moneyMarket && r.date.slice(5, 7) === "01").map((r) => ({ date: r.date, amount: r.amount })),
      calibratedFrom: null,
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export function accountLabel(s: FidelitySnapshot, kind: AccountTaxKind): string {
  const tail = s.accountNumber.slice(-4);
  return `${s.institution} ${kind === "529" && s.isChet ? "CHET 529" : ACCOUNT_KIND_LABEL[kind]} ••${tail}`;
}

export const unearned = (f: InvestmentFigures) => f.ordinaryDividends + f.interest + f.capGainDistShort + f.capGainDistLong + f.shortTermGain + f.longTermGain;

/** Custodial accounts, one entry per child, with the rule their income falls under. */
export function childIncome(
  accounts: AccountIncome[],
  limits: TaxYearParams["federal"]["kiddie"],
  year: number,
  isForecast: boolean,
  warnings: string[],
  assumptions: string[],
  notes: NoteBook = noteBook("tax"),
): ChildIncome[] {
  const byChild = new Map<string, AccountIncome[]>();
  // A Trump Account's income is tax-deferred: it's no one's until withdrawn.
  for (const a of accounts) if (a.child && a.kind === "CUSTODIAL") byChild.set(a.child, [...(byChild.get(a.child) ?? []), a]);
  return [...byChild].map(([name, as]) => {
    const ytd = pos(as.reduce((s, a) => s + unearned(a.ytd), 0));
    const projected = pos(as.reduce((s, a) => s + unearned(a.projected), 0));
    // The rule is decided on the full-year figure; a finished year's projection is its total.
    const rule: ChildIncome["rule"] = projected <= limits.exempt ? "UNDER_EXEMPT" : projected <= limits.threshold ? "CHILD_RATE" : "KIDDIE_TAX";
    const parentElectionAllowed = projected < limits.parentElectionMax && as.every((a) => a.projected.shortTermGain === 0 && a.projected.longTermGain === 0);
    type Say = Parameters<Parameters<NoteBook["say"]>[0]>[0];
    const law = (x: Say, cents: number, what: string) => x.usd(cents, `the kiddie-tax ${what}, set by law`, undefined, usd);
    const where = (x: Say) => `${name}'s custodial account income (${as.map((a) => a.label).join(", ")}: ${x.usd(projected, `${name}'s unearned income${isForecast ? ", projected" : ""}`, undefined, usd)}${isForecast ? " projected" : ""} for ${year})`;
    if (rule === "UNDER_EXEMPT") {
      assumptions.push(notes.say((x) => `${where(x)} is ${name}'s, not yours, so it's left off your return. It's under ${law(x, limits.exempt, "exempt amount")}: no tax and no return for ${name}.`));
    } else {
      const election = (x: Say) =>
        parentElectionAllowed
          ? ` Or you can report it on your own return with Form 8814 instead; this estimate leaves it off.`
          : ` Form 8814 (reporting it on your return) isn't available: ${projected >= limits.parentElectionMax ? `it's ${law(x, limits.parentElectionMax, "Form 8814 ceiling")} or more` : "it includes realized gains from sales"}.`;
      warnings.push(
        notes.say((x) =>
          rule === "CHILD_RATE"
            ? `${where(x)} is over ${law(x, limits.exempt, "exempt amount")}, so a return must be filed for ${name}: the part over ${law(x, limits.exempt, "exempt amount")} is taxed at ${name}'s rate.${election(x)}`
            : `${where(x)} is over ${law(x, limits.threshold, "threshold")}, so the kiddie tax applies: ${name}'s return (Form 8615) taxes the part over ${law(x, limits.threshold, "threshold")} at your rate.${election(x)}`,
        ),
      );
    }
    return { name, accounts: as.map((a) => a.label), ytd, projected, rule, parentElectionAllowed, limits };
  });
}
