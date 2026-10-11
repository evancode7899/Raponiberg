import type { LayoutRow } from "../statements/pdfLayout.ts";
import { labelValue, lineValue, readReturnLines, type ReturnLine } from "./lines.ts";
import type { FederalKey, FederalReturnSummary, FiledReturn, StateKey, StateReturnSummary } from "./types.ts";

/**
 * A filed return's figures by name. Federal lines are found by form and line number (the
 * 1040's numbering shifts a little between years: 7 → 7a, 11 → 11a, 12 → 12e, 13 → 13a);
 * state lines by their printed words, which hold across CT's resident and part-year forms
 * and NY's IT-201 and IT-203.
 */

export const FEDERAL_FORMS = ["1040", "1040X", "S1", "S2", "S3", "SA", "SB", "SD", "SE", "8812", "8949", "8889", "8995", "8959", "8960", "8606", "2441", "1116", "6251", "8582", "8880"];
export const CT_FORMS = ["CT-1040", "CT-1040NR/PY", "CT-SI", "CT-1040AW"];
export const NY_FORMS = ["IT-201", "IT-203", "IT-203-B", "IT-360.1", "IT-196"];

const cents = (d: number | null) => (d == null ? null : Math.round(d * 100));

/** Federal figure → [form, line numbers to try in order]. */
const FEDERAL: Record<FederalKey, [string, string[]]> = {
  wages: ["1040", ["1z", "1a", "1"]],
  taxExemptInterest: ["1040", ["2a"]],
  taxableInterest: ["1040", ["2b"]],
  qualifiedDividends: ["1040", ["3a"]],
  ordinaryDividends: ["1040", ["3b"]],
  iraDistributions: ["1040", ["4a"]],
  iraTaxable: ["1040", ["4b"]],
  pensionsTaxable: ["1040", ["5b"]],
  capitalGain: ["1040", ["7a", "7"]],
  additionalIncome: ["1040", ["8"]],
  totalIncome: ["1040", ["9"]],
  adjustments: ["1040", ["10"]],
  agi: ["1040", ["11a", "11"]],
  deduction: ["1040", ["12e", "12"]],
  qbiDeduction: ["1040", ["13a", "13"]],
  taxableIncome: ["1040", ["15"]],
  tax: ["1040", ["16"]],
  amt: ["1040", ["17"]],
  childCredit: ["1040", ["19"]],
  otherCredits: ["1040", ["20"]],
  otherTaxes: ["1040", ["23"]],
  additionalMedicareTax: ["S2", ["11"]],
  niit: ["S2", ["12"]],
  totalTax: ["1040", ["24"]],
  w2Withholding: ["1040", ["25a"]],
  otherWithholding: ["1040", ["25c"]],
  estimatedPayments: ["1040", ["26"]],
  excessSsCredit: ["S3", ["11"]],
  refundableCredits: ["1040", ["32"]],
  totalPayments: ["1040", ["33"]],
  refund: ["1040", ["35a"]],
  appliedToNextYear: ["1040", ["36"]],
  amountOwed: ["1040", ["37"]],
  penalty: ["1040", ["38"]],
  hsaDeduction: ["S1", ["13"]],
  hsaEmployer: ["8889", ["9"]],
  section199aDividends: ["8995", ["28", "6"]],
};

export function federalSummary(lines: ReturnLine[]): FederalReturnSummary {
  const out = {} as FederalReturnSummary;
  for (const [key, [form, nums]] of Object.entries(FEDERAL) as [FederalKey, [string, string[]]][]) {
    let v: number | null = null;
    for (const n of nums) {
      v = lineValue(lines, form, n);
      if (v != null) break;
    }
    out[key] = cents(v);
  }
  // Line 25b (1099 withholding) is summed into "other" withholding with 25c.
  const b = lineValue(lines, "1040", "25b");
  if (b != null) out.otherWithholding = (out.otherWithholding ?? 0) + cents(b)!;
  return out;
}

const CT: Record<StateKey, RegExp | null> = {
  federalAgi: /Federal adjusted gross income/i,
  stateAgi: /Connecticut adjusted gross income/i,
  sourceIncome: /Income from Connecticut sources/i,
  incomePercentage: /Line 6 divided by Line 5/i,
  taxBeforeAllocation: /^\d+[a-z]?\.\s*Income tax\b/i,
  incomeTax: /Connecticut income tax:/i,
  otherStateCredit: /Credit for income taxes paid to qualifying jurisdictions/i,
  cityTax: null,
  totalTax: /Total tax/i,
  withheld: /Total Connecticut income tax withheld/i,
  cityWithheld: null,
  estimatedPayments: /estimated tax payments/i,
  totalPayments: /Total payments/i,
  refund: /^\d+\.\s*Refund/i,
  amountOwed: /Total amount due/i,
  usObligationSubtraction: /Interest on U\.S\. government obligations/i,
  chet: /CHET contributions made/i,
};

const NY: Record<StateKey, RegExp | null> = {
  federalAgi: /Federal adjusted gross income/i,
  stateAgi: /New York adjusted gross income/i,
  sourceIncome: null,
  incomePercentage: null,
  taxBeforeAllocation: /New York State tax on line|NYS tax on line/i,
  incomeTax: /Total New York State taxes/i,
  otherStateCredit: /Resident credit/i,
  cityTax: /Total New York City and Yonkers taxes/i,
  totalTax: /voluntary contributions/i,
  withheld: /Total New York State tax withheld/i,
  cityWithheld: /Total New York City tax withheld/i,
  estimatedPayments: /estimated tax payments/i,
  totalPayments: /Total payments/i,
  refund: /available for refund/i,
  amountOwed: /Amount you owe/i,
  usObligationSubtraction: /government bonds/i,
  chet: null,
};

export function stateSummary(lines: ReturnLine[], jurisdiction: "CT" | "NY"): StateReturnSummary {
  const forms = jurisdiction === "CT" ? ["CT-1040", "CT-1040NR/PY"] : ["IT-201", "IT-203"];
  const map = jurisdiction === "CT" ? CT : NY;
  const out = {} as StateReturnSummary;
  for (const [key, re] of Object.entries(map) as [StateKey, RegExp | null][]) {
    out[key] = re ? cents(labelValue(lines, key === "usObligationSubtraction" || key === "chet" ? [...forms] : forms, re, "first")) : null;
  }
  if (jurisdiction === "CT") {
    out.incomePercentage = labelValue(lines, forms, CT.incomePercentage!) == null ? null : Math.round(labelValue(lines, forms, CT.incomePercentage!)! * 10_000);
  } else {
    // IT-203 prints a federal and a New York column; the NY column is the NY-source income.
    const it203 = lines.some((l) => l.form === "IT-203");
    if (out.federalAgi == null) out.federalAgi = cents(lineValue(lines, it203 ? "IT-203" : "IT-201", "19", "first"));
    if (it203) {
      out.sourceIncome = cents(lineValue(lines, "IT-203", "31", "last"));
      out.stateAgi = cents(lineValue(lines, "IT-203", "31", "first"));
      const pct = lineValue(lines, "IT-203", "45");
      out.incomePercentage = pct == null ? null : Math.round(pct * 10_000);
      out.taxBeforeAllocation = cents(lineValue(lines, "IT-203", "44")) ?? out.taxBeforeAllocation;
    }
  }
  return out;
}

const STATUS: [RegExp, FiledReturn["filingStatus"]][] = [
  [/X\s*Married filing jointly/, "MFJ"],
  [/X\s*Married filing separately/, "MFS"],
  [/X\s*Head of household/, "HOH"],
  [/X\s*Single\b/, "SINGLE"],
];

/** One filed return per jurisdiction found in the PDF (Intuit prints federal and state in one file). */
export function parseReturns(rows: LayoutRow[], text: string): FiledReturn[] {
  const printed = /Printed on (\d{2})\/(\d{2})\/(\d{4})/.exec(text);
  const printedOn = printed ? `${printed[3]}-${printed[1]}-${printed[2]}` : null;
  const out: FiledReturn[] = [];
  // Each jurisdiction's pages are read in its own style; a page's title says whose it is.
  const fed = readReturnLines(rows, "?", "FED").filter((l) => FEDERAL_FORMS.includes(l.form));
  const ct = readReturnLines(rows, "?", "CT").filter((l) => CT_FORMS.includes(l.form));
  const ny = readReturnLines(rows, "?", "NY").filter((l) => NY_FORMS.includes(l.form));
  if (fed.some((l) => l.form === "1040" || l.form === "1040X")) {
    const rowText = rows.map((r) => r.cells.map((c) => c.text).join(" ")).join("\n");
    out.push({
      jurisdiction: "FEDERAL",
      form: fed.some((l) => l.form === "1040X") ? "1040X" : "1040",
      filingStatus: STATUS.find(([re]) => re.test(rowText))?.[1] ?? null,
      printedOn,
      movedOn: null,
      lines: fed,
      otherIncome: scheduleOneItems(rows, fed),
      federal: federalSummary(fed),
      state: null,
    });
  }
  if (ct.length) {
    out.push({
      jurisdiction: "CT",
      form: ct.some((l) => l.form === "CT-1040NR/PY") ? "CT-1040NR/PY" : "CT-1040",
      filingStatus: null,
      printedOn,
      movedOn: null,
      lines: ct,
      otherIncome: [],
      federal: null,
      state: stateSummary(ct, "CT"),
    });
  }
  if (ny.length) {
    out.push({
      jurisdiction: "NY",
      form: ny.some((l) => l.form === "IT-203") ? "IT-203" : "IT-201",
      filingStatus: null,
      printedOn,
      movedOn: nyMoveDate(rows),
      lines: ny,
      otherIncome: [],
      federal: null,
      state: stateSummary(ny, "NY"),
    });
  }
  return out;
}

/**
 * Schedule 1 line 8z ("Other income. List type and amount"): the description prints on
 * the row above the amount, in capitals.
 */
function scheduleOneItems(rows: LayoutRow[], fed: ReturnLine[]): FiledReturn["otherIncome"] {
  const z = fed.find((l) => l.form === "S1" && l.line === "8z");
  if (!z) return [];
  const row = rows.find((r) => r.page === z.page && r.cells.some((c) => c.text.trim() === "8z"));
  const above = rows.filter((r) => r.page === z.page && row && r.y > row.y && r.y - row.y <= 16).flatMap((r) => r.cells.map((c) => c.text.trim()));
  const label = above.find((t) => /^[A-Z0-9][A-Z0-9 ,&'()/-]{4,}$/.test(t) && /[A-Z]{3}/.test(t));
  return [{ label: label ?? "Other income", amount: Math.round(z.values.at(-1)! * 100) }];
}

/** IT-203 item G: "Enter the date you moved into or out of NYS (mmddyyyy)". */
function nyMoveDate(rows: LayoutRow[]): string | null {
  const label = rows.find((r) => r.cells.some((c) => /date you moved into/i.test(c.text)));
  if (!label) return null;
  const near = rows
    .filter((r) => r.page === label.page && Math.abs(r.y - label.y) <= 15)
    .flatMap((r) => r.cells)
    .find((c) => /^\d{8}$/.test(c.text.trim()));
  const d = near?.text.trim();
  return d ? `${d.slice(4)}-${d.slice(0, 2)}-${d.slice(2, 4)}` : null;
}
