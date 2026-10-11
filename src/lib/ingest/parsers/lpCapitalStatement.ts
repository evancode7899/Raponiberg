import { NO_HOUSEHOLD, type HouseholdPatterns } from "../../household/patterns.ts";
import type { ParsedDocument, ParsedTransaction } from "../types.ts";
import { lines, parseMonthNameDate } from "../text.ts";

export const LP_CAPITAL_PARSER_ID = "lp-capital-statement";
/** Bump when a change would read already-imported documents differently (re-import them with --reparse-outdated). */
export const VERSION = 1;

export function detectLpCapitalStatement(text: string): boolean {
  return /Statement of Partner's Capital Activity/.test(text) && /Partner's Capital Statement\s*\|/.test(text);
}

/** Whole-dollar amounts as the fund prints them: "2,000", "(1,200)", "$ -" → cents. */
function dollars(token: string | undefined): number | null {
  if (token == null) return null;
  const t = token.replace(/[$\s]/g, "");
  if (/^[-–—]$/.test(t)) return 0;
  const m = /^(\()?(-)?([\d,]+)(\.\d+)?\)?$/.exec(t);
  if (!m) return null;
  const v = Math.round(Number(m[3]!.replace(/,/g, "") + (m[4] ?? "")) * 100);
  return m[1] || m[2] ? -v : v;
}

/** First column ("Quarter To Date") of a labelled row. */
function qtd(ls: string[], label: string): number | null {
  const line = ls.find((l) => l.startsWith(`${label} `));
  if (!line) return null;
  const toks = line.slice(label.length).replace(/\$/g, " ").trim().split(/\s+/).filter(Boolean);
  return dollars(toks[0]);
}

/**
 * A private fund's quarterly Statement of Partner's Capital Activity. The investor's
 * capital account is the balance; capital calls are contributions that arrive from
 * checking by wire, income/(loss) from operations is growth, and the management fee and
 * carried interest are fees. Amounts are printed in whole dollars.
 *
 * Which fund (and the institution its account is filed under) comes from the household
 * file's funds, matched by the name the statement prints; an unknown fund is filed under
 * its own name.
 */
export function parseLpCapitalStatement(text: string, household: HouseholdPatterns = NO_HOUSEHOLD): ParsedDocument {
  const ls = lines(text);
  const warnings: string[] = [];
  const known = household.funds.find((f) => text.includes(f.statementName));
  const fund = known?.statementName ?? ls.find((l) => /\bL\.?P\.?$/.test(l)) ?? "Private fund";
  const institution = known?.institution ?? fund;
  const periodEnd = parseMonthNameDate(/Partner's Capital Statement\s*\|\s*(.+)$/m.exec(text)?.[1] ?? "");
  if (!periodEnd) throw new Error("Fund statement: statement date not found");
  const [y, mm] = periodEnd.split("-").map(Number) as [number, number];
  const periodStart = `${y}-${String(Math.floor((mm - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
  const id = /Start(TNR\d+)End/.exec(text)?.[1] ?? "TNR";

  const opening = qtd(ls, "Beginning Capital");
  const closing = qtd(ls, "Ending Capital");
  if (opening == null || closing == null) throw new Error("Fund statement: capital balances not found");
  const contributions = qtd(ls, "Contributions") ?? 0;
  const distributions = qtd(ls, "Distributions") ?? 0;
  const income = qtd(ls, "Total Income/(Loss)") ?? 0;
  const mgmtFee = Math.abs(qtd(ls, "Management fee expense") ?? 0);
  const carry = Math.abs(qtd(ls, "Carried Interest") ?? 0);
  const transfer = qtd(ls, "Transfer In/(Out)") ?? 0;

  const transactions: ParsedTransaction[] = [];
  const flow = (description: string, amountCents: number, section: string) => {
    if (amountCents !== 0) transactions.push({ date: periodEnd, datePrecision: "PERIOD", description, amountCents, section });
  };
  flow("Capital contributions (capital calls)", contributions, "Capital contributions");
  flow("Distributions", -Math.abs(distributions), "Distributions");
  flow("Transfer in/(out)", transfer, "Transfers");

  // Total Income/(Loss) is stated after the management fee, so growth adds it back and
  // the fee (plus carried interest, taken below it) is reported as fees.
  const growth = income + mgmtFee;
  const fees = -(mgmtFee + carry);
  const flows = transactions.reduce((a, t) => a + t.amountCents, 0);
  return {
    parserId: LP_CAPITAL_PARSER_ID,
    parserVersion: VERSION,
    institution,
    kind: "STATEMENT",
    title: "Fund capital statement",
    periodStart,
    periodEnd,
    sections: [
      {
        institution,
        accountNumber: id,
        accountName: known?.accountName ?? fund,
        kind: "INVESTMENT",
        subtype: "OTHER",
        periodStart,
        periodEnd,
        openingBalanceCents: opening,
        closingBalanceCents: closing,
        growthCents: growth,
        feesCents: fees,
        transactions,
        checks: [
          {
            label: "Opening + contributions + income − carried interest = ending capital",
            expectedCents: closing,
            actualCents: opening + flows + income - carry,
            // The fund prints whole dollars, so its own rows can be a dollar apart.
            toleranceCents: 100,
          },
        ],
      },
    ],
    warnings,
  };
}
