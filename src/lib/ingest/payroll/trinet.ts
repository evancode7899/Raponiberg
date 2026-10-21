import { collapseSpaces, lines, moneyTokens, parseMoney, parseSlashDate } from "../text.ts";
import { classifyEarning, classifyEmployer, classifyPretax, classifyTax } from "./classify.ts";
import type { PayStubFacts, StubLine } from "./types.ts";

/**
 * TriNet "Earnings Statement". One row per line item ("Fed Withholding 1,529.70
 * 73,770.80"), but long names and section headings wrap onto extra lines ("Before-Tax" /
 * "Deductions" / "Current Plan Year Year-to-Date"), and a long after-tax list continues
 * on page 2. Every section ends in a printed total, which is what makes the stub
 * checkable: lines must add to their section total, and gross − taxes − deductions must
 * equal the printed net pay, this period and year to date.
 */

const NOISE = [/^TriNet HR\b/, /^For questions, contact\b/, /^EARNINGS STATEMENT$/, /^Check #\d+, Page\b/];
const PAGE = "<<PAGE>>";
/** Column headings and wrapped heading fragments inside a section. */
const HEADING = /^(Description\b.*|Deductions|(Deductions )?Current( Plan Year)? Year-to-Date)$/;
const ENDS_IN_MONEY = /-?[\d,]*\d\.\d{2}$/;

type Row = { name: string; values: number[] };

function sectionRows(ls: string[], from: number, to: number): Row[] {
  const out: Row[] = [];
  let carry: string[] = [];
  for (const l of ls.slice(from, to)) {
    if (HEADING.test(l) || l === PAGE) {
      carry = [];
      continue;
    }
    if (ENDS_IN_MONEY.test(l)) {
      const name = l.replace(/(\s*-?[\d,]*\d\.\d{2,3})+$/, "").trim();
      out.push({ name: collapseSpaces([...carry, name].join(" ")), values: moneyTokens(l) });
      carry = [];
    } else carry.push(l);
  }
  return out;
}

export function extractTrinetStub(text: string): PayStubFacts | null {
  const checkDate = /Check Date: (\S+)/.exec(text);
  if (!checkDate) return null;
  const ls = lines(text)
    .filter((l) => !NOISE.some((re) => re.test(l)))
    .map((l) => (/^-- \d+ of \d+ --$/.test(l) ? PAGE : l));
  const at = (re: RegExp, from = 0) => {
    const i = ls.findIndex((l, k) => k >= from && re.test(l));
    return i < 0 ? null : i;
  };
  /** The values of a wrapped total row ("Total Before Tax" / "Deductions 400.00 200.00 9,000.00"). */
  const totalValues = (i: number | null): number[] | null => {
    if (i == null) return null;
    for (let k = i; k < Math.min(ls.length, i + 3); k++) if (ENDS_IN_MONEY.test(ls[k]!)) return moneyTokens(ls[k]!);
    return null;
  };
  const warnings: string[] = [];

  const iCur = at(/^Current Hours and Earnings$/);
  const iYtd = at(/^YTD Hours and Earnings$/);
  const iTaxDed = at(/^Taxes and Deductions$/);
  const iTaxes = at(/^Taxes Current Year-to-Date$/);
  const iTotTaxes = at(/^Total Taxes\b/);
  const iBefore = at(/^Before-Tax$/);
  const iTotBefore = at(/^Total Before Tax\b/);
  const iAfter = at(/^After-Tax$/);
  const iTotAfter = at(/^Total After Tax\b/);
  const iTotDed = at(/^Total( Deductions\b.*)?$/, iTotAfter ?? iTotBefore ?? 0);
  const iNet = at(/^Net Pay -?[\d,]+\.\d{2}/);
  const iTaxable = at(/^Taxable Benefits Current Year-to-Date$/);
  const iTotTaxable = at(/^Total Taxable\b/);
  const iNonTaxable = at(/^Non-Taxable Benefits Current Year-to-Date$/);
  const iTotNonTaxable = at(/^Total Non-Taxable\b/);
  const iDeposit = at(/^Direct Deposit$/);
  const iWithholdingInfo = at(/^Tax Withholding$/);

  const lineItems: StubLine[] = [];
  // Earnings: the current section gives this period, the YTD section the year so far.
  const printed = { grossCurrent: null as number | null, grossYtd: null as number | null };
  const current = new Map<string, number>();
  if (iCur != null && iYtd != null) {
    for (const r of sectionRows(ls, iCur + 1, iYtd)) {
      if (/^Gross Pay\b/.test(r.name)) printed.grossCurrent = r.values.at(-1) ?? null;
      else if (!/^Fed Taxable Gross\b/.test(r.name)) current.set(r.name, (current.get(r.name) ?? 0) + (r.values.at(-1) ?? 0));
    }
  } else warnings.push("Current earnings section not found.");
  if (iYtd != null && iTaxDed != null) {
    const seen = new Set<string>();
    for (const r of sectionRows(ls, iYtd + 1, iTaxDed)) {
      if (/^Gross Pay\b/.test(r.name)) printed.grossYtd = r.values.at(-1) ?? null;
      else if (!/^Fed Taxable Gross\b/.test(r.name)) {
        lineItems.push({ name: r.name, kind: classifyEarning(r.name), current: current.get(r.name) ?? 0, ytd: r.values.at(-1) ?? null });
        seen.add(r.name);
      }
    }
    // An earning paid this period with no YTD row (never seen, but never dropped either).
    for (const [name, v] of current) if (!seen.has(name)) lineItems.push({ name, kind: classifyEarning(name), current: v, ytd: null });
  } else warnings.push("Year-to-date earnings section not found.");

  // Taxes: current, YTD.
  if (iTaxes != null && iTotTaxes != null) {
    for (const r of sectionRows(ls, iTaxes + 1, iTotTaxes)) {
      const kind = classifyTax(r.name);
      if (!kind) warnings.push(`Unrecognized tax line "${r.name}" counted as state income tax.`);
      lineItems.push({ name: r.name, kind: kind ?? "OTHER_STATE_TAX", current: r.values[0] ?? 0, ytd: r.values[1] ?? null });
    }
  } else warnings.push("Taxes section not found.");
  // Before-tax deductions: current, plan year, YTD.
  if (iBefore != null && iTotBefore != null) {
    for (const r of sectionRows(ls, iBefore + 1, iTotBefore)) {
      lineItems.push({ name: r.name, kind: classifyPretax(r.name), current: r.values[0] ?? 0, ytd: r.values.length >= 3 ? r.values[2]! : (r.values[1] ?? null) });
    }
  }
  // After-tax deductions: current, YTD. A long list stops at the withholding-info block
  // and continues at the top of the next page, up to its total.
  if (iAfter != null) {
    const nextPage = at(new RegExp(`^${PAGE}$`), iAfter);
    const end1 = Math.min(...[iTotAfter, iWithholdingInfo, nextPage].filter((i): i is number => i != null && i > iAfter));
    const rows = Number.isFinite(end1) ? sectionRows(ls, iAfter + 1, end1) : [];
    if (iTotAfter != null && iTotAfter > end1) {
      const pageStart = ls.lastIndexOf(PAGE, iTotAfter);
      if (pageStart > end1) rows.push(...sectionRows(ls, pageStart + 1, iTotAfter));
    }
    for (const r of rows) lineItems.push({ name: r.name, kind: "AFTER_TAX", current: r.values[0] ?? 0, ytd: r.values[1] ?? null });
  }
  // Company-paid: taxable benefits are imputed income; the rest is employer money.
  if (iTaxable != null && iTotTaxable != null) {
    for (const r of sectionRows(ls, iTaxable + 1, iTotTaxable)) lineItems.push({ name: `Imputed: ${r.name}`, kind: "IMPUTED", current: r.values[0] ?? 0, ytd: r.values[1] ?? null });
  }
  if (iNonTaxable != null && iTotNonTaxable != null) {
    for (const r of sectionRows(ls, iNonTaxable + 1, iTotNonTaxable)) {
      // "LTD*": a taxable benefit with nothing this period moves here, "*" marking it taxable,
      // still carrying its year-to-date imputed income.
      const taxable = r.name.endsWith("*");
      const name = taxable ? `Imputed: ${r.name.slice(0, -1).trim()}` : r.name;
      lineItems.push({ name, kind: taxable ? "IMPUTED" : classifyEmployer(r.name), current: r.values[0] ?? 0, ytd: r.values[1] ?? null });
    }
  }

  const taxes = totalValues(iTotTaxes);
  const deductions = totalValues(iTotDed);
  const net = iNet != null ? moneyTokens(ls[iNet]!) : null;
  const headlineNet = parseMoney(/^USD (\$[\d,]+\.\d{2})$/m.exec(text)?.[1] ?? "");
  const netCurrent = net?.[0] ?? headlineNet;
  if (netCurrent == null) throw new Error("TriNet: net pay not found");
  if (headlineNet != null && net?.[0] != null && headlineNet !== net[0]) warnings.push("The headline net pay and the Net Pay row differ.");
  const sum = (a: number[] | null, b: number[] | null, i: number) => (a?.[i] != null || b?.[i] != null ? (a?.[i] ?? 0) + (b?.[i] ?? 0) : null);

  const deposits: PayStubFacts["deposits"] = [];
  if (iDeposit != null) {
    for (const l of ls.slice(iDeposit + 1, iDeposit + 8)) {
      const m = /^(Checking|Savings)\s+(\d{3,})\s+([\d,]+\.\d{2})$/i.exec(l);
      if (m) deposits.push({ last4: m[2]!.slice(-4), amount: parseMoney(m[3]!)! });
    }
  }
  const period = /Pay Period: (\S+) - (\S+)/.exec(text);
  const employeeLine = ls.find((l) => /NON-NEGOTIABLE$/.test(l));
  return {
    source: "TRINET",
    employee: collapseSpaces((employeeLine ?? "Employee").replace(/NON-NEGOTIABLE$/, "")),
    employer: collapseSpaces((ls[0] ?? "Employer").replace(/^EARNINGS STATEMENT\s+/, "")),
    payDate: parseSlashDate(checkDate[1]!)!,
    periodStart: period ? parseSlashDate(period[1]!) : null,
    periodEnd: period ? parseSlashDate(period[2]!) : null,
    federalFilingStatus: /Marital Status (\w+)/.exec(text)?.[1] ?? null,
    lines: lineItems,
    printed: {
      grossCurrent: printed.grossCurrent,
      grossYtd: printed.grossYtd,
      withheldCurrent: sum(taxes, deductions, 0),
      withheldYtd: sum(taxes, deductions, 1),
      netCurrent,
      netYtd: net?.[1] ?? null,
    },
    deposits,
    warnings,
  };
}
