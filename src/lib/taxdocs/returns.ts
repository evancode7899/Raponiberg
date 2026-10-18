import type { LayoutRow } from "../statements/pdfLayout.ts";
import { readReturnLines, type ReturnLine } from "./lines.ts";
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

/**
 * Where a filed figure was printed: the line, which of its amounts (NY's IT-203 prints a
 * federal and a New York column), and its sign in the figure. The summaries below and the
 * filed-return proof (book/proof/filedReturnProof.ts) read figures through these, so both
 * name the same lines.
 */
export type FiledSource = { line: ReturnLine; column: "first" | "last"; sign: 1 | -1 };

/** A source's amount as printed (dollars, or the decimal a percentage line prints), signed. */
export const sourceValue = (s: FiledSource) => s.sign * (s.column === "first" ? s.line.values[0]! : s.line.values.at(-1)!);

const sumCents = (sources: FiledSource[]) => (sources.length ? sources.reduce((t, s) => t + cents(sourceValue(s))!, 0) : null);
const findLine = (lines: ReturnLine[], form: string, line: string) => lines.find((x) => x.form === form && x.line === line);
const findLabel = (lines: ReturnLine[], forms: string[], label: RegExp) => lines.find((x) => forms.includes(x.form) && label.test(x.label));
const one = (line: ReturnLine | undefined, column: FiledSource["column"]): FiledSource[] => (line ? [{ line, column, sign: 1 }] : []);

export const FEDERAL_KEYS = Object.keys(FEDERAL) as FederalKey[];

/** The line(s) a federal figure is read from: the first of its line numbers printed on its form. */
export function federalSources(lines: ReturnLine[], key: FederalKey): FiledSource[] {
  const [form, nums] = FEDERAL[key];
  const out = one(nums.map((n) => findLine(lines, form, n)).find(Boolean), "last");
  // Line 25b (1099 withholding) is summed into "other" withholding with 25c.
  if (key === "otherWithholding") out.push(...one(findLine(lines, "1040", "25b"), "last"));
  return out;
}

export function federalSummary(lines: ReturnLine[]): FederalReturnSummary {
  const out = {} as FederalReturnSummary;
  for (const key of FEDERAL_KEYS) out[key] = sumCents(federalSources(lines, key));
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

export const STATE_KEYS = Object.keys(CT) as StateKey[];

/** The line a state figure is read from: found by its printed words, which hold across each state's forms; IT-203's two columns by line number. */
export function stateSources(lines: ReturnLine[], jurisdiction: "CT" | "NY", key: StateKey): FiledSource[] {
  if (jurisdiction === "CT") {
    const re = CT[key];
    return re ? one(findLabel(lines, ["CT-1040", "CT-1040NR/PY"], re), key === "incomePercentage" ? "last" : "first") : [];
  }
  const it203 = lines.some((l) => l.form === "IT-203");
  if (it203) {
    // IT-203 prints a federal and a New York column; the NY column is the NY-source income.
    if (key === "sourceIncome") return one(findLine(lines, "IT-203", "31"), "last");
    if (key === "stateAgi") return one(findLine(lines, "IT-203", "31"), "first");
    if (key === "incomePercentage") return one(findLine(lines, "IT-203", "45"), "last");
    if (key === "taxBeforeAllocation" && findLine(lines, "IT-203", "44")) return one(findLine(lines, "IT-203", "44"), "last");
  }
  const re = NY[key];
  const hit = re ? one(findLabel(lines, ["IT-201", "IT-203"], re), "first") : [];
  if (key === "federalAgi" && !hit.length) return one(findLine(lines, it203 ? "IT-203" : "IT-201", "19"), "first");
  return hit;
}

export function stateSummary(lines: ReturnLine[], jurisdiction: "CT" | "NY"): StateReturnSummary {
  const out = {} as StateReturnSummary;
  for (const key of STATE_KEYS) {
    const sources = stateSources(lines, jurisdiction, key);
    // A percentage is kept in ten-thousandths, everything else in cents.
    out[key] = key !== "incomePercentage" ? sumCents(sources) : sources.length ? Math.round(sourceValue(sources[0]!) * 10_000) : null;
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
