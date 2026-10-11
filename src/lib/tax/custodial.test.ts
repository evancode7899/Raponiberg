import { describe, expect, it } from "vitest";
import { childIncome, investmentAccounts, type FidelitySnapshot } from "./buildTaxReport";
import { extractFidelityTax } from "./facts/investments";
import { taxYearParams } from "./params";
import { DEFAULT_PROFILE, type TaxProfile } from "./profile";

const kiddie = taxYearParams(2026).federal.kiddie;

const snapshot = (accountNumber: string, ownerLine: string, kind: FidelitySnapshot["kind"], dividends: number, longTerm = 0): FidelitySnapshot => ({
  id: accountNumber,
  documentId: "d",
  institution: "Fidelity",
  accountNumber,
  ownerLine,
  kind,
  periodStart: "2026-12-01",
  periodEnd: "2026-12-31",
  isYearEnd: false,
  endingValue: 1_000_000,
  income: { dividends, interest: 0, capGainDistShort: 0, capGainDistLong: 0, taxExempt: 0, taxDeferred: 0 },
  realized: longTerm ? { shortTerm: 0, longTerm } : null,
  incomeRows: [],
  distributions: [],
  contributionsYtd: null,
  isChet: false,
});

const profile = (p: Partial<TaxProfile> = {}): TaxProfile => ({ ...structuredClone(DEFAULT_PROFILE), dependents: [{ name: "Kit", birthYear: 2024 }], ...p });
const personFor = (t: string) => DEFAULT_PROFILE.persons.find((p) => p.match.some((m) => t.toUpperCase().includes(m)));

describe("custodial (UTMA/UGMA) accounts", () => {
  it("are recognized from the statement's owner line", () => {
    const text = ["INVESTMENT REPORT", "August 1, 2026 - August 31, 2026", "Account # Z00-000009", "KIT EXAMPLE - UTMA\tAccount Summary"].join("\n");
    expect(extractFidelityTax(text)[0]!.kind).toBe("CUSTODIAL");
  });

  it("belong to the dependent named on the account, not a parent", () => {
    const warnings: string[] = [];
    const [a] = investmentAccounts([snapshot("Z00-000009", "KIT EXAMPLE - UTMA", "CUSTODIAL", 50_000)], 2026, profile(), personFor, warnings);
    expect(a).toMatchObject({ kind: "CUSTODIAL", ownerId: "CHILD", child: "Kit", label: "Fidelity UTMA/UGMA ••0009" });
    expect(warnings).toEqual([]);
  });

  it("an unrecognized account warns until its type is set under Inputs", () => {
    const snap = snapshot("Z00-000009", "KIT EXAMPLE - SOMETHING", "OTHER", 50_000);
    const warnings: string[] = [];
    expect(investmentAccounts([snap], 2026, profile(), personFor, warnings)[0]!.kind).toBe("OTHER");
    expect(warnings[0]).toMatch(/unrecognized type.*Inputs/);

    const fixed: string[] = [];
    const [a] = investmentAccounts([snap], 2026, profile({ accountKinds: { "Z00-000009": "CUSTODIAL" } }), personFor, fixed);
    expect(a).toMatchObject({ kind: "CUSTODIAL", statementKind: "OTHER", child: "Kit" });
    expect(fixed).toEqual([]);
  });

  it("applies the kiddie-tax tiers to the child's projected income", () => {
    const rule = (dividends: number, longTerm = 0) => {
      const warnings: string[] = [];
      const assumptions: string[] = [];
      const accounts = investmentAccounts([snapshot("Z00-000009", "KIT EXAMPLE - UTMA", "CUSTODIAL", dividends, longTerm)], 2026, profile(), personFor, []);
      const [c] = childIncome(accounts, kiddie, 2026, false, warnings, assumptions);
      return { ...c!, warnings, assumptions };
    };
    expect(rule(100_000)).toMatchObject({ rule: "UNDER_EXEMPT", projected: 100_000, warnings: [], assumptions: [expect.stringMatching(/no tax and no return/)] });
    expect(rule(200_000)).toMatchObject({ rule: "CHILD_RATE", parentElectionAllowed: true, warnings: [expect.stringMatching(/return must be filed for Kit/)] });
    expect(rule(300_000)).toMatchObject({ rule: "KIDDIE_TAX", parentElectionAllowed: true, warnings: [expect.stringMatching(/Form 8615.*Form 8814/)] });
    // Realized gains rule out reporting it on the parents' return.
    expect(rule(300_000, 50_000)).toMatchObject({ rule: "KIDDIE_TAX", projected: 350_000, parentElectionAllowed: false });
  });
});
