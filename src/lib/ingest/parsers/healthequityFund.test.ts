import { describe, expect, it } from "vitest";
import { classifyTransaction, type ClassifyContext } from "../../classifier/classify.ts";
import { compileHousehold } from "../../household/patterns.ts";
import { validateDocument } from "../validate.ts";
import { parseStatementText } from "./index.ts";

// Synthetic statements in each provider's real text layout (figures are made up).

const CTX: ClassifyContext = { mergeDate: "2024-12-01", userRules: [] };

function parse(text: string) {
  const o = parseStatementText(text);
  if (!o.ok) throw new Error(JSON.stringify(o));
  return o;
}

describe("HealthEquity HSA", () => {
  const text = `Date Description of Transaction
Deposit or
(Withdrawal)
Account
Balance
Beginning Balance $ 1,000.00
01/05/2026 Investment Admin Fee December 2025. Average
HealthEquity investments of $7,000.00 at 0.0300%.
(2.00) 998.00
01/07/2026 Employee Contribution for 2025 100.00 1,098.00
01/07/2026 Card: Clinic, 800-0000000, CT (50.00) 1,048.00
01/08/2026 Investment: FUND (48.00) 1,000.00
HealthEquity Account Statement
Health Savings Account
Account Number: 11112222
Period: 01/01/26 through 01/31/26
01/31/2026 Interest for 1/1/2026 - 1/31/2026 (Annual percentage
yield earned for period is 0.10% on
average collected balance of $1,000.00)
0.10 1,000.10
Ending Balance $ 1,000.10
Investment Portfolio
Closing Account Value $ 7,500.00
FUND 40.0 187.50 7,500.00
`;
  const o = parse(text);
  const s = o.doc.sections[0]!;

  it("keeps fund transfers out of the flows and chains the opening from the prior statement", () => {
    expect(o.parserId).toBe("healthequity-hsa");
    expect(s).toMatchObject({ subtype: "HSA", openingFromPrior: true, feesCents: -200, closingBalanceCents: 850_010 });
    expect(s.transactions.map((t) => [t.section, t.amountCents])).toEqual([
      ["Employee contributions", 10_000],
      ["Withdrawals", -5_000],
    ]);
    expect(s.checks.every((c) => c.expectedCents === c.actualCents)).toBe(true);
    expect(validateDocument(o.doc).ok).toBe(true);
  });

  it("counts payroll deferrals as contributions and card spend as health spending", () => {
    const c = (section: string, amountCents: number) =>
      classifyTransaction({ institution: "HealthEquity", accountSubtype: "HSA", section, description: "x", amountCents, date: "2026-01-07" }, CTX);
    expect(c("Employee contributions", 10_000).lane).toBe("CONTRIBUTION_EMPLOYEE");
    expect(c("Withdrawals", -5_000)).toMatchObject({ lane: "EXPENSE", category: "Health & insurance" });
  });
});

describe("private fund capital statement", () => {
  const text = `Statement of Partner's Capital Activity
Quarter To Date Inception To Date
Beginning Capital $ 10 $ -
Contributions/(Distributions)
Contributions 2,000 2,000
Distributions - -
Net Contributions/(Distributions) 2,000 2,000
Income/(Loss) Allocation
Management fee expense - -
Income/(loss) from operations 100 110
Total Income/(Loss) 100 110
Carried Interest - -
Transfer In/(Out) - -
Ending Capital $ 2,110 $ 2,110
Less: Contributions (2,000)
Example Credit Fund II Feeder LP
Partner's Capital Statement | March 31, 2026
StartTNR0000009999EndTNR`;
  // A made-up household that invests in the fund.
  const household = compileHousehold({
    version: 1,
    funds: [{ institution: "Example Partners", statementName: "Example Credit Fund II Feeder LP", accountName: "Example Credit Fund II (private credit)", wirePattern: "EXAMPLE CREDIT FUND" }],
  });
  const o = parseStatementText(text, household);
  if (!o.ok) throw new Error(JSON.stringify(o));
  const s = o.doc.sections[0]!;

  it("reads the quarter's capital roll-forward in whole dollars, filed under the household's fund", () => {
    expect(o.parserId).toBe("lp-capital-statement");
    expect(s).toMatchObject({ institution: "Example Partners", accountName: "Example Credit Fund II (private credit)", periodStart: "2026-01-01", periodEnd: "2026-03-31", openingBalanceCents: 1_000, closingBalanceCents: 211_000, growthCents: 10_000 });
    expect(s.transactions).toHaveLength(1);
    expect(validateDocument(o.doc).ok).toBe(true);
  });

  it("files a fund the household file doesn't list under the name the statement prints", () => {
    expect(parse(text).doc.sections[0]).toMatchObject({ institution: "Example Credit Fund II Feeder LP", accountName: "Example Credit Fund II Feeder LP" });
  });

  it("treats the capital call and its wire as the two legs of an own-account transfer", () => {
    const ctx: ClassifyContext = { ...CTX, household };
    const fund = classifyTransaction({ institution: "Example Partners", accountSubtype: "OTHER", section: "Capital contributions", description: "Capital contributions", amountCents: 200_000, date: "2026-03-31" }, ctx);
    const wire = classifyTransaction({ institution: "Chase", accountSubtype: "CHECKING", description: "Online Domestic Wire Transfer A/C: Example Credit Fund II Ref: Capitalcall", amountCents: -200_000, date: "2026-01-20" }, ctx);
    expect(fund).toMatchObject({ lane: "TRANSFER", counterparty: { kind: "OWN_ACCOUNT" } });
    expect(wire).toMatchObject({ lane: "TRANSFER", counterparty: { kind: "OWN_ACCOUNT", institution: "Example Partners" } });
  });
});
