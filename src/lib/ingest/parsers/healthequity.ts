import { extractHealthEquityHoldings } from "../holdings/index.ts";
import type { ParsedDocument, ParsedTransaction } from "../types.ts";
import { lines, parseMoney, parseSlashDate, trailingAmounts } from "../text.ts";

export const HEALTHEQUITY_PARSER_ID = "healthequity-hsa";
/** Bump when a change would read already-imported documents differently (re-import them with --reparse-outdated). */
export const VERSION = 1;

export function detectHealthEquity(text: string): boolean {
  return /HealthEquity/.test(text) && /Health Savings Account/.test(text) && /Account Statement/.test(text) && /Account Number:\s*\d+/.test(text);
}

const DATE_ROW = /^(\d{2}\/\d{2}\/\d{4})\s*(.*)$/;

/**
 * HealthEquity HSA statements. Activity rows print "date, description, deposit or
 * (withdrawal), running cash balance"; long descriptions (interest, the monthly
 * investment admin fee) wrap, with the two amounts on a later line.
 *
 * Money in the account is cash plus, once the owner invests, a fund holding ("Investment
 * Portfolio", closing value only). "Investment: VTSAX" rows just move cash to or from
 * that holding, so they are not household flows. What counts as flows are payroll
 * contributions and card spending on medical care; interest and fund performance are
 * growth, and the admin fee is a fee. The statement doesn't print the holding's opening
 * value, so for invested statements the opening is chained from the previous statement
 * at commit (see openingFromPrior); the cash side ties to the cent on its own.
 */
export function parseHealthEquity(text: string): ParsedDocument {
  const ls = lines(text);
  const warnings: string[] = [];
  const period = /Period:\s*(\d{2}\/\d{2}\/\d{2,4})\s+through\s+(\d{2}\/\d{2}\/\d{2,4})/.exec(text);
  if (!period) throw new Error("HealthEquity: statement period not found");
  const periodStart = parseSlashDate(period[1]!)!;
  const periodEnd = parseSlashDate(period[2]!)!;
  const accountNumber = /Account Number:\s*(\d+)/.exec(text)![1]!;

  const openingTok = /Beginning Balance\s+\$?\s*([\d,]+\.\d{2})/.exec(text);
  if (!openingTok) throw new Error("HealthEquity: beginning balance not found");
  const cashOpen = parseMoney(openingTok[1]!)!;
  const printedEnd = /Ending Balance[\s\S]*?\$?\s*([\d,]+\.\d{2})/.exec(text);
  if (!printedEnd) throw new Error("HealthEquity: ending balance not found");
  const cashClose = parseMoney(printedEnd[1]!)!;
  const portfolio = /Closing Account Value\s+\$?\s*([\d,]+\.\d{2})/.exec(text);
  const holdingClose = portfolio ? parseMoney(portfolio[1]!)! : 0;

  const transactions: ParsedTransaction[] = [];
  let interest = 0;
  let fees = 0;
  let toHolding = 0;
  let balance = cashOpen;
  const apply = (date: string, desc: string, amount: number, running: number) => {
    // The running cash balance decides direction: a debit lowers it.
    const signed = running < balance ? -Math.abs(amount) : Math.abs(amount);
    if (balance + signed !== running) warnings.push(`${date}: "${desc}" does not follow the running balance`);
    balance = running;
    if (/^Interest\b/i.test(desc)) interest += signed;
    else if (/^Investment Admin Fee/i.test(desc)) fees += signed;
    else if (/^Investment:/i.test(desc)) toHolding -= signed;
    else {
      const section =
        signed < 0 ? "Withdrawals" : /Employer/i.test(desc) ? "Employer contributions" : /Employee/i.test(desc) ? "Employee contributions" : "Deposits";
      transactions.push({ date, datePrecision: "EXACT", description: desc, amountCents: signed, section });
    }
  };

  for (let i = 0; i < ls.length; i++) {
    const head = DATE_ROW.exec(ls[i]!);
    if (!head) continue;
    // Gather the row: its own line, then wrapped lines until one ends in two amounts.
    const parts: string[] = [];
    let amounts: number[] | null = null;
    for (let j = i; j < Math.min(ls.length, i + 6); j++) {
      const raw = j === i ? head[2]! : ls[j]!;
      if (j > i && (DATE_ROW.test(raw) || /^Ending Balance/.test(raw))) break;
      const t = trailingAmounts(raw);
      if (t.values.length >= 2) {
        amounts = t.values.slice(-2);
        if (t.rest) parts.push(t.rest);
        break;
      }
      if (raw) parts.push(raw);
    }
    if (!amounts) continue;
    const desc = parts.join(" ").replace(/\s+/g, " ").trim() || "Interest";
    apply(parseSlashDate(head[1]!)!, desc, amounts[0]!, amounts[1]!);
  }

  const closing = cashClose + holdingClose;
  const flows = transactions.reduce((a, t) => a + t.amountCents, 0);
  // With the holding's opening unknown here, growth assumes none; at commit the
  // previous statement's closing replaces it (see openingFromPrior).
  const growth = closing - cashOpen - flows - fees;
  const invested = holdingClose > 0 || toHolding !== 0;
  if (!invested && interest !== growth) warnings.push("Interest does not explain the change in balance");
  return {
    parserId: HEALTHEQUITY_PARSER_ID,
    parserVersion: VERSION,
    institution: "HealthEquity",
    kind: "STATEMENT",
    title: "HealthEquity HSA statement",
    periodStart,
    periodEnd,
    sections: [
      {
        institution: "HealthEquity",
        accountNumber,
        accountName: "HealthEquity HSA",
        kind: "INVESTMENT",
        subtype: "HSA",
        periodStart,
        periodEnd,
        openingBalanceCents: cashOpen,
        closingBalanceCents: closing,
        growthCents: growth,
        feesCents: fees,
        transactions,
        ...(invested ? { openingFromPrior: true } : {}),
        checks: [{ label: "Cash activity ties to the printed ending cash balance", expectedCents: cashClose, actualCents: balance }],
      },
    ],
    holdings: [extractHealthEquityHoldings(text, accountNumber, periodEnd, cashClose)],
    warnings,
  };
}
