import { addDays } from "../../dates/isoDate.ts";
import type { ParsedDocument, ParsedTransaction } from "../types.ts";
import { collapseSpaces, lines, moneyTokens, parseMoney, parseSlashDate } from "../text.ts";

export const AMEX_PARSER_ID = "amex-card";
/** Bump when a change would read already-imported documents differently: they are read again on the next folder scan or launch. */
export const VERSION = 1;

export function detectAmex(text: string): boolean {
  return /americanexpress\.com/i.test(text) && /Closing Date \d{2}\/\d{2}\/\d{2}/.test(text) && /Account Ending/.test(text);
}

const ROW_START = /^(\d{2}\/\d{2}\/\d{2})\*?\s+(.*)$/;
/** A USD amount ending a row: "$9.78 ⧫", "-$1,234.56", "$44.37 t" (older PDFs render ⧫ as t). */
const ROW_AMOUNT_END = /(-?\$[\d,]+\.\d{2})(?:\s*[⧫t])?$/;
const MONEY_LINE = /^[+-]?(?:CR)?-?\$[\d,]+\.\d{2}(?:\s*[⧫t])?$/;

/**
 * Amex card statements. Row sections (payments vs credits vs charges) are scrambled in
 * the text layer of older PDFs, so each row stands on its own: its sign comes from the
 * printed amount and its section from its description. Correctness is enforced by the
 * statement's printed totals (payments & credits, new charges, fees, interest) and the
 * account-level balance identity.
 */
export function parseAmex(text: string): ParsedDocument {
  const ls = lines(text);
  const warnings: string[] = [];

  const product = ls.find((l) => /American Express®? .*Card$|^Blue Cash .*American Express$|^The Platinum Card/.test(l)) ??
    ls.find((l) => /®/.test(l) && /(Card|Everyday|Preferred)/.test(l)) ?? "American Express Card";
  const productName = collapseSpaces(product.replace(/ from American Express$/, "").replace(/^American Express®?\s*/, "Amex "));

  const closingLine = ls.find((l) => /Closing Date \d{2}\/\d{2}\/\d{2}/.test(l))!;
  const periodEnd = parseSlashDate(closingLine.split("Closing Date")[1]!)!;
  const daysLine = ls.find((l) => /Days in Billing Period:\s*\d+/.test(l));
  const days = daysLine ? Number(/Days in Billing Period:\s*(\d+)/.exec(daysLine)![1]) : null;
  if (!days) warnings.push("Billing-period length not printed; assumed one month");
  const periodStart = days ? addDays(periodEnd, -(days - 1)) : addDays(periodEnd, -29);

  const acctLine = ls.find((l) => /Account Ending \d-\d{5}/.test(l))!;
  const accountNumber = /Account Ending (\d-\d{5})/.exec(acctLine)![1]!;

  // ---- Rows ----
  const transactions: ParsedTransaction[] = [];
  let printedNeg = 0;
  let printedPos = 0;
  let pending: { date: string; parts: string[] } | null = null;
  let cardMember: string | undefined;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i]!;
    const cm = /^Card Ending (\d-\d{5})/.exec(l);
    if (cm && i > 0) cardMember = collapseSpaces(ls[i - 1]!.replace(/\s*Closing Date.*$/, ""));
    // Lodging rows print "Arrival Date Departure Date" then a line starting with the
    // arrival date — that line continues the row rather than starting a new one.
    const start: RegExpExecArray | null = pending &&/Arrival Date/.test(pending.parts.at(-1)!) ? null : ROW_START.exec(l);
    if (start) {
      if (pending) warnings.push(`Row without amount dropped: ${pending.date} ${pending.parts.join(" ")}`);
      pending = { date: parseSlashDate(start[1]!)!, parts: [start[2]!] };
    } else if (pending) {
      pending.parts.push(l);
    } else {
      continue;
    }
    const joined = pending.parts.join(" ");
    const m = ROW_AMOUNT_END.exec(joined);
    if (m) {
      let printed = parseMoney(m[1]!)!;
      // Foreign-transaction and cash-advance fee rows print the underlying charge first,
      // then the fee itself.
      if (/(TRANSACTION|ADVANCE) FEE/i.test(pending.parts[0]!) && MONEY_LINE.test(ls[i + 1] ?? "")) {
        printed = parseMoney(ls[i + 1]!.replace(/\s*[⧫t]$/, ""))!;
        i++;
      }
      const body = joined.slice(0, m.index).trim();
      const [first, ...rest] = pending.parts;
      const description = collapseSpaces(first!.replace(ROW_AMOUNT_END, ""));
      const detail = collapseSpaces(
        rest
          .join(" ")
          .replace(ROW_AMOUNT_END, "")
          .replace(/\b[\d.,]+\s+[A-Z][a-z]+ (Dollars|Euro|Pounds|Pesos|Francs|Yen)\b/g, ""),
      );
      if (printed < 0) printedNeg += printed;
      else printedPos += printed;
      transactions.push({
        date: pending.date,
        datePrecision: "EXACT",
        description: description || body,
        amountCents: -printed,
        section: sectionFor(description, printed),
        detail: detail || undefined,
        cardMember,
      });
      pending = null;
    } else if (pending.parts.length > 16) {
      warnings.push(`Unterminated row dropped: ${pending.date} ${pending.parts[0]}`);
      pending = null;
    }
  }

  // ---- Printed totals ----
  const lastMoneyOn = (re: RegExp): number | null => {
    const line = ls.find((l) => re.test(l));
    if (!line) return null;
    const vals = moneyTokens(line);
    return vals.length ? vals.at(-1)! : null;
  };
  const totalPaymentsCredits = lastMoneyOn(/^Total Payments and Credits\b/) ?? 0;
  const totalCharges = lastMoneyOn(/^Total New Charges\b/) ?? 0;
  const totalFees = lastMoneyOn(/^Total Fees for this Period\b/) ?? 0;
  const totalInterest = lastMoneyOn(/^Total Interest Charged for this Period\b/) ?? 0;
  const totalCashAdvances = lastMoneyOn(/^Total Cash Advances for this Period\b/) ?? 0;
  const totalDebits = totalCharges + totalCashAdvances + totalFees + totalInterest;

  const newBalanceLine = ls.find((l) => /^New Balance (CR)?\$[\d,]+\.\d{2}(CR)?$/.test(l));
  if (!newBalanceLine) throw new Error("Amex: New Balance not found");
  const newBalance = owedFromPrinted(newBalanceLine.replace(/^New Balance\s*/, ""));

  const derivedPrevious = newBalance - (totalPaymentsCredits + totalDebits);
  const printedPrevious = findPreviousBalance(ls);
  let previous = derivedPrevious;
  const checks = [
    { label: "Payments and credits", expectedCents: totalPaymentsCredits, actualCents: printedNeg },
    {
      label: "New charges + cash advances + fees + interest",
      expectedCents: totalDebits,
      actualCents: printedPos,
    },
  ];
  if (printedPrevious != null) {
    previous = printedPrevious;
    checks.push({
      label: "Previous balance + activity = new balance",
      expectedCents: newBalance,
      actualCents: printedPrevious + totalPaymentsCredits + totalDebits,
    });
  } else {
    warnings.push("Previous balance not printed in a readable spot; derived from totals");
  }

  return {
    parserId: AMEX_PARSER_ID,
    parserVersion: VERSION,
    institution: "American Express",
    kind: "STATEMENT",
    title: `${productName} statement`,
    periodStart,
    periodEnd,
    sections: [
      {
        institution: "American Express",
        accountNumber,
        accountName: productName,
        kind: "CREDIT_CARD",
        subtype: "CREDIT_CARD",
        periodStart,
        periodEnd,
        // Owed amounts are debts: flip to the household's sign convention.
        openingBalanceCents: -previous,
        closingBalanceCents: -newBalance,
        growthCents: 0,
        feesCents: 0,
        transactions,
        checks,
      },
    ],
    warnings,
  };
}

/** Printed balance owed → cents owed (a "CR" credit balance is negative owed). */
function owedFromPrinted(token: string): number {
  const t = token.trim();
  const v = parseMoney(t.replace(/CR/g, ""))!;
  return /CR/.test(t) ? -Math.abs(v) : v;
}

/**
 * The account-total previous balance. Gold statements print a Pay-In-Full bucket first,
 * so prefer the "Account Total" block; otherwise a one-line "Previous Balance $x"; else
 * the first money value after a bare "Previous Balance" label run.
 */
function findPreviousBalance(ls: string[]): number | null {
  const firstMoneyAfter = (idx: number): number | null => {
    for (let j = idx + 1; j < Math.min(ls.length, idx + 14); j++) {
      if (MONEY_LINE.test(ls[j]!)) return owedFromPrinted(ls[j]!.replace(/^[+]/, "").replace(/\s*[⧫t]$/, ""));
    }
    return null;
  };
  const totalIdx = ls.findIndex((l) => l === "Account Total");
  if (totalIdx >= 0) {
    const prevIdx = ls.findIndex((l, j) => j > totalIdx && l === "Previous Balance");
    if (prevIdx >= 0) {
      const v = firstMoneyAfter(prevIdx);
      if (v != null) return v;
    }
  }
  const single = ls.find((l) => /^Previous Balance (CR)?\$[\d,]+\.\d{2}$/.test(l));
  if (single) return owedFromPrinted(single.replace(/^Previous Balance\s*/, ""));
  const bare = ls.findIndex((l) => l === "Previous Balance");
  return bare >= 0 ? firstMoneyAfter(bare) : null;
}

function sectionFor(description: string, printed: number): string {
  const d = description.toUpperCase();
  if (printed < 0) {
    return /PAYMENT|AUTOPAY|THANK YOU/.test(d) && !/CREDIT$/.test(d) ? "Payments" : "Credits";
  }
  if (/INTEREST CHARGE/.test(d)) return "Interest";
  if (/\bFEE\b/.test(d)) return "Fees";
  return "Charges";
}
