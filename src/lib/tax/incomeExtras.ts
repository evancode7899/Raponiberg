import type { ProofValue } from "../book/proof/types.ts";
import type { AccountIncome, PersonReport, TaxReport } from "./buildTaxReport.ts";

/**
 * Taxes › Income & W-2 beyond its estimate lines, as numbers: Connecticut's bracket lines,
 * each employer's W-2 build-up and pay-stub lines, each account's investment income, IRA
 * moves, CHET contributions, and each child's custodial income. One pure function for the
 * page and its proofs (book/derived/taxes.ts); the page draws a cell by its row and column.
 */

export type IncomeCell = { row: string; col: string; describes: string; value: ProofValue };

/** The W-2 boxes the page builds from a pay stub's lines, in order. */
export const W2_ROWS = [
  ["gross", "Gross pay (incl. imputed income)"],
  ["non-taxable", "Non-taxable reimbursements"],
  ["pretax", "Pre-tax health, HSA, FSA (§125)"],
  ["box5", "Box 5 · Medicare wages"],
  ["pretax-401k", "Pre-tax 401(k)"],
  ["box1", "Box 1 · Wages (federal taxable)"],
  ["box3", "Box 3 · Social Security wages (capped)"],
  ["box16", "Box 16 · CT wages"],
  ["box2", "Box 2 · Federal withheld"],
  ["box4", "Box 4 · Social Security withheld"],
  ["box6", "Box 6 · Medicare withheld"],
  ["box17", "Box 17 · CT withheld"],
  ["box12d", "Box 12 D · 401(k) deferrals"],
  ["box12w", "Box 12 W · HSA (you + employer)"],
  ["box12c", "Box 12 C · Group-term life over $50k"],
  ["box12dd", "Box 12 DD · Health coverage cost (info only)"],
  ["employer", "Employer 401(k) contributions (not taxed)"],
] as const;
export type W2Row = (typeof W2_ROWS)[number][0];

type Entry = PersonReport["payroll"][number];

/** An employer's W-2 box, year to date or projected to December 31. */
export function w2Value(e: Entry, row: W2Row, side: "ytd" | "projected"): number {
  const b = side === "ytd" ? e.w2Ytd : e.w2Projected;
  const pay = side === "ytd" ? e.ytd : e.projected;
  switch (row) {
    case "gross":
      return pay.gross;
    case "non-taxable":
      return -pay.nonTaxable;
    case "pretax":
      return -(pay.section125 + pay.hsa + pay.dependentCareFsa);
    case "box5":
      return b.box5MedicareWages;
    case "pretax-401k":
      return -b.box12.D;
    case "box1":
      return b.box1Wages;
    case "box3":
      return b.box3SsWages;
    case "box16":
      return b.box16StateWages;
    case "box2":
      return b.federalWithheld;
    case "box4":
      return b.ssWithheld;
    case "box6":
      return b.medicareWithheld;
    case "box17":
      return b.stateWithheld;
    case "box12d":
      return b.box12.D;
    case "box12w":
      return b.box12.W;
    case "box12c":
      return b.box12.C;
    case "box12dd":
      return b.box12.DD;
    case "employer":
      return b.employerRetirement;
  }
}

/** The investment-income rows the page lists per taxable account. */
export const ACCOUNT_ROWS = [
  ["Ordinary dividends", "ordinaryDividends"],
  ["of which qualified", "qualifiedDividends"],
  ["of which money market", "moneyMarketDividends"],
  ["Interest", "interest"],
  ["Capital gain distributions", "capGainDistLong"],
  ["Realized short-term gain/loss", "shortTermGain"],
  ["Realized long-term gain/loss", "longTermGain"],
  ["Foreign tax paid", "foreignTax"],
] as const satisfies readonly (readonly [string, keyof AccountIncome["ytd"]])[];

/** A row key for an employer or account: who, and which. */
export const employerRow = (p: Pick<PersonReport, "id">, e: Pick<Entry, "employer">, row: string) => `w2:${p.id}:${e.employer}:${row}`;
export const lineRow = (p: Pick<PersonReport, "id">, e: Pick<Entry, "employer">, i: number) => `stub-line:${p.id}:${e.employer}:${i}`;
export const accountRow = (a: Pick<AccountIncome, "accountNumber">, k: string) => `account:${a.accountNumber}:${k}`;

export function incomeCells(r: TaxReport): IncomeCell[] {
  const out: IncomeCell[] = [];
  const add = (row: string, col: string, describes: string, cents: number) => out.push({ row, col, describes, value: { cents } });
  const ct = r.scenarios.mfj.ct;
  add("ct-other", "joint", "Connecticut: other modifications", ct.additions - (ct.subtractions - ct.chetDeduction - ct.usObligationSubtraction));
  add("ct-brackets", "joint", "Connecticut: tax from brackets", ct.initialTax);
  add("ct-addback", "joint", "Connecticut: 2% rate phase-out add-back", ct.addBack);
  add("ct-recapture", "joint", "Connecticut: benefit recapture", ct.recapture);
  add("ct-personal-credit", "joint", "Connecticut: personal tax credit", -ct.personalCredit);
  for (const p of r.people) {
    for (const e of p.payroll) {
      if (e.extraBonus) add(employerRow(p, e, "extra-bonus"), "projected", `${p.name}, ${e.employer}: expected bonus`, e.extraBonus);
      for (const [row, label] of W2_ROWS)
        for (const side of ["ytd", "projected"] as const)
          // The year in progress projects gross pay by the forecast's own figure (planning › projected gross).
          if (!(row === "gross" && side === "projected" && r.isCurrentYear && e.active)) add(employerRow(p, e, row), side, `${p.name}, ${e.employer}: ${label}, ${side === "ytd" ? "year to date" : "projected"}`, w2Value(e, row, side));
      // New York's boxes, where the employer withholds for it (Overview › projected W-2s).
      for (const side of ["ytd", "projected"] as const) {
        const b = side === "ytd" ? e.w2Ytd : e.w2Projected;
        if ((e.w2Projected.nyWithheld ?? 0) + (e.w2Projected.nycWithheld ?? 0) > 0)
          for (const [row, label, v] of [["box16ny", "Box 16 · NY wages", b.nyStateWages], ["box17ny", "Box 17 · NY tax withheld", b.nyWithheld], ["box19nyc", "Box 19 · NYC tax withheld", b.nycWithheld]] as const)
            add(employerRow(p, e, row), side, `${p.name}, ${e.employer}: ${label}`, v ?? 0);
      }
      e.lines.forEach((l, i) => {
        add(lineRow(p, e, i), "current", `${p.name}, ${e.employer}: ${l.name}, latest check`, l.current ?? 0);
        add(lineRow(p, e, i), "ytd", `${p.name}, ${e.employer}: ${l.name}, year to date`, l.ytd ?? 0);
      });
    }
    for (const a of p.accounts.filter((x) => x.kind === "TAXABLE"))
      for (const [label, k] of ACCOUNT_ROWS)
        for (const side of ["ytd", "projected"] as const) add(accountRow(a, k), side, `${a.label}: ${label}, ${side === "ytd" ? "year to date" : "projected"}`, a[side][k]);
    const ira = p.retirement;
    add(`ira:${p.id}:rollovers`, "joint", `${p.name}: direct IRA rollovers`, ira.rollovers);
    add(`ira:${p.id}:conversions`, "joint", `${p.name}: Roth conversions`, ira.conversions);
    add(`ira:${p.id}:basis`, "joint", `${p.name}: non-deductible IRA basis`, -ira.basis);
    add(`ira:${p.id}:other`, "joint", `${p.name}: other IRA withdrawals`, ira.otherDistributions);
    add(`ira:${p.id}:taxable`, "joint", `${p.name}: IRA taxable`, ira.taxable);
    add(`chet:${p.id}`, "joint", `${p.name}: CHET 529 contributions this year`, p.income.ctChetContributions);
  }
  for (const c of r.children) {
    add(`child:${c.name}`, "ytd", `${c.name}: custodial unearned income, year to date`, c.ytd);
    add(`child:${c.name}`, "projected", `${c.name}: custodial unearned income, projected`, c.projected);
  }
  return out;
}
