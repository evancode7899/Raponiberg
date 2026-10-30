import type { LayoutRow } from "../statements/pdfLayout.ts";
import { CENTS, findLabels, mode, moneyCents, readBoxes, WHOLE, type BoxSpec } from "./boxes.ts";
import type { Brokerage1099, Int1099, K1Form, R1099, Sa5498 } from "./types.ts";

/**
 * 1099s, the HSA 5498-SA and partnership K-1s. Brokerage consolidated 1099s print
 * "1a Total Ordinary Dividends ....... 1,234.56" lines, so they're read from the text;
 * the single-form PDFs are boxed and read by position like a W-2.
 */

const money = (s: string | undefined) => (s ? (moneyCents(s) ?? 0) : 0);

/** The amount after a dotted label in a consolidated 1099 ("1b Qualified Dividends ....... 987.65"). */
function dotted(text: string, label: RegExp, nth = 0): number {
  const re = new RegExp(`${label.source}[^\\n]*?\\.{3,}\\s*\\(?(-?[\\d,]+\\.\\d{2})\\)?`, "g");
  const all = [...text.matchAll(re)];
  return money(all[nth]?.[1]);
}

/** A 1099-B summary row: proceeds, cost, market discount, wash sale, gain, withheld. */
function bRow(text: string, label: RegExp): number[] {
  const m = new RegExp(`${label.source}\\s+((?:\\(?-?[\\d,]+\\.\\d{2}\\)?\\s*){6})`).exec(text);
  return m ? m[1]!.trim().split(/\s+/).map((v) => money(v)) : [0, 0, 0, 0, 0, 0];
}

export function parseBrokerage1099(text: string): { f1099: Brokerage1099; warnings: string[] } {
  const warnings: string[] = [];
  const st = [bRow(text, /Short-term transactions for which basis is reported to the IRS/), bRow(text, /Short-term transactions for which basis is not reported to the IRS/)];
  const lt = [bRow(text, /Long-term transactions for which basis is reported to the IRS/), bRow(text, /Long-term transactions for which basis is not reported to the IRS/)];
  const unknown = bRow(text, /Transactions for which basis is not reported to the IRS and Term is Unknown/);
  const col = (rows: number[][], i: number) => rows.reduce((s, r) => s + (r[i] ?? 0), 0);
  const f1099: Brokerage1099 = {
    payer: /^(FIDELITY [A-Z ]+LLC)$/m.exec(text)?.[1] ?? /Payer's Name and Address:\s*\n([^\n]+)/.exec(text)?.[1]?.trim() ?? "",
    recipient: /Account No\.\s+([A-Z][A-Z .'-]+)\n/.exec(text)?.[1]?.trim() ?? "",
    account: /\b[A-Z]\d{2}-\d{2}(\d{4})\b/.exec(text)?.[1] ?? null,
    div: {
      ordinary: dotted(text, /1a Total Ordinary Dividends/),
      qualified: dotted(text, /1b Qualified Dividends/),
      capitalGainDistributions: dotted(text, /2a Total Capital Gain Distributions/),
      unrecaptured1250: dotted(text, /2b Unrecap\. Sec 1250 Gain/),
      nondividend: dotted(text, /3 Nondividend Distributions/),
      federalWithheld: dotted(text, /4 Federal Income Tax Withheld/, 0),
      section199a: dotted(text, /5 Section 199A Dividends/),
      foreignTax: dotted(text, /7 Foreign Tax Paid/),
      exemptInterest: dotted(text, /12 Exempt Interest Dividends/),
    },
    int: {
      interest: dotted(text, /\n1 Interest Income/),
      earlyWithdrawalPenalty: dotted(text, /2 Early Withdrawal Penalty/),
      usTreasury: dotted(text, /3 Interest on U\.S\. Savings Bonds and Treas\. Obligations/),
      federalWithheld: dotted(text, /4 Federal Income Tax Withheld/, 1),
      foreignTax: dotted(text, /6 Foreign Tax Paid/),
      taxExempt: dotted(text, /8 Tax-Exempt Interest/),
    },
    misc: { other: dotted(text, /3 Other Income/), substitutePayments: dotted(text, /8 Substitute Payments in Lieu of Dividends or Interest/) },
    proceedsInvestmentExpenses: dotted(text, /Proceeds Investment Expenses/),
    dividendPayments: [...text.matchAll(/^(\d{2})\/(\d{2})\/(\d{2})\s+\(?(-?[\d,]+\.\d{2})\)?/gm)].map((m) => ({ date: `20${m[3]}-${m[1]}-${m[2]}`, amount: money(m[4]) })),
    b: {
      shortTermProceeds: col(st, 0),
      shortTermBasis: col(st, 1),
      shortTermGain: col(st, 4),
      longTermProceeds: col(lt, 0),
      longTermBasis: col(lt, 1),
      longTermGain: col(lt, 4),
      unknownTermGain: unknown[4] ?? 0,
      washDisallowed: col(st, 3) + col(lt, 3) + (unknown[3] ?? 0),
    },
  };
  if (!/1a Total Ordinary Dividends/.test(text)) warnings.push("The 1099-DIV summary wasn't found.");
  if (!/Long-term transactions for which basis is reported/.test(text)) warnings.push("The 1099-B summary wasn't found.");
  if (f1099.b.unknownTermGain) warnings.push("Some sales have an unknown holding period; check Form 8949.");
  return { f1099, warnings };
}

/** The first line of text printed under a label (a payer's or recipient's name), voted across copies. */
export function nameUnder(rows: LayoutRow[], label: RegExp, maxDy = 45): string | null {
  const names: string[] = [];
  for (const h of findLabels(rows, [{ id: "x", label }])) {
    const below = rows.filter((r) => r.page === h.page && r.y < h.y && h.y - r.y <= maxDy).sort((a, b) => b.y - a.y);
    for (const r of below) {
      const c = r.cells.find(
        (c) => Math.abs(c.x0 - h.x0) <= 30 && /[A-Za-z]{2}/.test(c.text) && !/postal|street|address|province|ZIP|number|TIN|instructions|Batch/i.test(c.text),
      );
      if (c) {
        names.push(c.text.trim());
        break;
      }
    }
  }
  return mode(names);
}

const INT_BOXES: BoxSpec[] = [
  { id: "1", label: /\b1 Interest income/i },
  { id: "2", label: /Early withdrawal penalty/i },
  { id: "3", label: /Interest on U\.S\. Savings Bonds/i },
  { id: "4", label: /Federal income tax withheld/i },
  { id: "_5", label: /Investment expenses/i },
  { id: "6", label: /Foreign tax paid/i },
  { id: "8", label: /Tax-exempt interest/i },
  { id: "_9", label: /Specified private activity/i },
  { id: "_10", label: /Market discount/i },
  { id: "_11", label: /Bond premium/i },
];

export function parseInt1099(rows: LayoutRow[], text: string): { int: Int1099; warnings: string[] } {
  const page1 = rows.filter((r) => r.page === 1);
  const b = readBoxes(page1, INT_BOXES, { value: CENTS, maxDy: 30 });
  const warnings = b["1"] == null ? ["Box 1 (interest) wasn't found."] : [];
  return {
    int: {
      payer: nameUnder(page1, /PAYER.S name/) ?? "",
      recipient: nameUnder(page1, /RECIPIENT.S name/) ?? "",
      account: /X{3,}(\d{4})\b/.exec(text)?.[1] ?? null,
      interest: b["1"] ?? 0,
      earlyWithdrawalPenalty: b["2"] ?? 0,
      usTreasury: b["3"] ?? 0,
      federalWithheld: b["4"] ?? 0,
      taxExempt: b["8"] ?? 0,
      foreignTax: b["6"] ?? 0,
    },
    warnings,
  };
}

const R_BOXES: BoxSpec[] = [
  { id: "_1", label: /\b1 Gross distribution/i },
  { id: "_2a", label: /\b2a Taxable amount/i },
  { id: "_2b", label: /\b2b Taxable amount/i },
  { id: "_3", label: /\b3 Capital gain/i },
  { id: "4", label: /\b4 Federal income tax/i },
];

/**
 * 1099-R. Fidelity's layout right-aligns box 1's amount into box 2a's column, so boxes 1
 * and 2a come from the text, where they print as a pair under their labels; box 4 is read
 * by position, only from the row right under its label.
 */
export function parseR1099(rows: LayoutRow[], text: string): { r: R1099; warnings: string[] } {
  const page1 = rows.filter((r) => r.page === 1);
  const b = readBoxes(page1, R_BOXES, { value: CENTS, maxDy: 12 });
  const pair = /1 Gross distribution\s+2a Taxable amount\s*\n\s*\$?\s*([\d,]+\.\d{2})\s+\$?\s*([\d,]+\.\d{2})?/.exec(text);
  b["1"] = pair ? moneyCents(pair[1]!)! : (undefined as unknown as number);
  b["2a"] = pair?.[2] ? moneyCents(pair[2])! : (b["1"] ?? 0);
  const code = /code\(s\)\s*\n\s*([0-9A-Z]{1,2})\s*\n/.exec(text)?.[1] ?? "";
  return {
    r: {
      payer: /\n([A-Z][A-Z ]+INVESTMENTS)\n/.exec(text)?.[1] ?? nameUnder(page1, /PAYER.S name/) ?? "",
      recipient: nameUnder(page1, /RECIPIENT.S Name/i) ?? /\n([A-Z]+ [A-Z]+)\n\d+ /.exec(text)?.[1] ?? "",
      account: /\b\d{3}-\d{2}(\d{4})-\d{3}\b/.exec(text)?.[1] ?? null,
      gross: b["1"] ?? 0,
      taxable: b["2a"] ?? 0,
      taxableNotDetermined: /Taxable amount\s*\n?\s*not determined\s*\n?\s*X/i.test(text),
      federalWithheld: b["4"] ?? 0,
      codes: code,
      ira: /IRA\/\s*\n?\s*SEP\/\s*\n?\s*SIMPLE\s*\n?\s*X/.test(text),
    },
    warnings: b["1"] == null ? ["Box 1 (gross distribution) wasn't found."] : [],
  };
}

const SA_BOXES: BoxSpec[] = [
  { id: "_1", label: /\b1 Employee.s or self-/i },
  { id: "2", label: /\b2 Total contributions made in/i },
  { id: "_3", label: /\b3 Total HSA or Archer MSA contributions/i },
  { id: "4", label: /\b4 Rollover contributions/i },
  { id: "5", label: /\b5 Fair market value/i },
];

export function parseSa5498(rows: LayoutRow[]): { sa: Sa5498; warnings: string[] } {
  const page1 = rows.filter((r) => r.page === 1);
  const b = readBoxes(page1, SA_BOXES, { value: CENTS, maxDy: 30 });
  return {
    sa: {
      trustee: nameUnder(page1, /TRUSTEE.S name/) ?? "",
      recipient: nameUnder(page1, /PARTICIPANT.S name/) ?? "",
      contributions: b["2"] ?? 0,
      rollover: b["4"] ?? 0,
      fairMarketValue: b["5"] ?? 0,
    },
    // The trustee's copy often leaves the boxes blank: employer contributions are on the W-2 (box 12 W).
    warnings: b["2"] == null ? ["No contribution amounts are printed; HSA contributions are taken from W-2 box 12 (code W)."] : [],
  };
}

const K1_BOXES: BoxSpec[] = [
  { id: "1", label: /Ordinary business income/i },
  { id: "2", label: /Net rental real estate income/i },
  { id: "3", label: /Other net rental income/i },
  { id: "4a", label: /Guaranteed payments for services/i },
  { id: "_4b", label: /Guaranteed payments for capital/i },
  { id: "_4c", label: /Total guaranteed payments/i },
  { id: "5", label: /^Interest income$/i },
  { id: "6a", label: /Ordinary dividends/i },
  { id: "6b", label: /Qualified dividends/i },
  { id: "_6c", label: /Dividend equivalents/i },
  { id: "7", label: /^Royalties$/i },
  { id: "8", label: /Net short-term capital gain/i },
  { id: "9a", label: /Net long-term capital gain/i },
  { id: "_9b", label: /Collectibles \(28%\)/i },
  { id: "_9c", label: /Unrecaptured section 1250/i },
  { id: "10", label: /Net section 1231 gain/i },
  { id: "_11", label: /Other income \(loss\)/i },
  { id: "_13", label: /Other deductions/i },
  { id: "_14", label: /Self-employment earnings/i },
  { id: "_15", label: /^Credits$/i },
  { id: "_16", label: /Schedule K-3 is attached/i },
  { id: "_17", label: /Alternative minimum tax \(AMT\) items/i },
  { id: "_18", label: /Tax-exempt income and/i },
  { id: "_19", label: /^Distributions$/i },
  { id: "_20", label: /^Other information$/i },
  { id: "21", label: /Foreign taxes paid or accrued/i },
];

export function parseK1(rows: LayoutRow[], text: string): { k1: K1Form; warnings: string[] } {
  const page1 = rows.filter((r) => r.page === 1);
  // Box numbers ("14", "19") print as their own small cells right before their captions; they're not amounts.
  const amounts = page1.map((r) => ({
    ...r,
    cells: r.cells.filter((c, i) => {
      const next = r.cells[i + 1];
      return !(/^\d{1,2}[a-c]?$/.test(c.text.trim()) && c.x1 - c.x0 <= 12 && next && next.x0 - c.x1 <= 16 && /[A-Za-z]{4}/.test(next.text));
    }),
  }));
  const b = readBoxes(amounts, K1_BOXES, { value: WHOLE, maxDy: 20, slack: 70 });
  const d = (id: string) => b[id] ?? 0;
  const iso = (m: RegExpExecArray | null) => (m ? `${m[3]}-${m[1]}-${m[2]}` : null);
  const warnings: string[] = [];
  if (/\bOther income \(loss\)[\s\S]{0,80}SEE STMT|ZZ\*/.test(text)) warnings.push("Box 11 (other income) refers to a statement; check the supporting schedule.");
  return {
    k1: {
      partnership: nameUnder(page1, /Partnership.s name, address/i, 20) ?? "",
      ein: /\b(\d{2}-\d{7})\b/.exec(text)?.[1] ?? null,
      partner: nameUnder(page1, /Name, address, city, state, and ZIP code for partner/i, 20) ?? "",
      limitedPartner: /X\s*Limited partner/.test(text) || page1.some((r) => r.cells.some((c) => /^X Limited partner/.test(c.text))),
      final: page1.some((r) => r.cells.some((c) => /^X\s*Final K-1/.test(c.text))),
      periodStart: iso(/beginning\s+(\d{2}) \/ (\d{2}) \/ (\d{4})/.exec(page1.map((r) => r.cells.map((c) => c.text).join(" ")).join("\n"))),
      periodEnd: iso(/ending\s+(\d{2}) \/ (\d{2}) \/ (\d{4})/.exec(page1.map((r) => r.cells.map((c) => c.text).join(" ")).join("\n"))),
      ordinaryBusiness: d("1"),
      rentalRealEstate: d("2"),
      otherRental: d("3"),
      guaranteedPayments: d("4a"),
      interest: d("5"),
      ordinaryDividends: d("6a"),
      qualifiedDividends: d("6b"),
      royalties: d("7"),
      shortTermGain: d("8"),
      longTermGain: d("9a"),
      section1231: d("10"),
      foreignTax: d("21"),
    },
    warnings,
  };
}
