import { describe, expect, it } from "vitest";
import { insuranceKind, parseBill, parsePolicy } from "./parse";
import { buildInsuranceReport, type PremiumRow } from "./report";
import type { BillingNotice } from "./types";

/** A made-up packet, laid out the way the extracted text of the real one comes out. */
const PACKET = `AGENCY: ZZ001
AGENT: SAM SAMPLE
POLICY: 9900011122
March 2, 2025
PAT EXAMPLE
Policy Number: 9900011122
Product Name: Example Term
The following item(s) require your immediate attention. To avoid policy cancellation, please respond
by April 30, 2025.
Your policy details:
Policy Number: 9900011122
Owner: PAT EXAMPLE
Insured: PAT EXAMPLE
Billing Frequency: Annually
Billing Type: Direct Billing
Signatures Required:
Policy Acceptance and Amendment of Application
Total Modal Premium Due: $812.00
If you have questions after reading your policy, please contact your agent directly or the Corebridge
Financial Contact Center at 1-800-555-0100 (Life Insurance) or 1-800-555-0101 (Variable Universal
Life only).
Policies issued by American General Life Insurance Company (AGL) except in New York.
This is an INDETERMINATE PREMIUM TERM LIFE INSURANCE POLICY. This policy is ANNUALLY
RENEWABLE, CONVERTIBLE and contains RE-ENTRY OPTION. NONPARTICIPATING - THIS POLICY
WILL NOT PAY DIVIDENDS.
NOTICE OF RIGHT TO EXAMINE POLICY
You may return this policy within ten* days after delivery if You are not satisfied with it for any reason.
15 YEAR LEVEL PREMIUM PERIOD
INDEX
Table of Premiums and Face Amounts 4
POLICY SCHEDULE
Insured: PAT EXAMPLE Policy Number: 9900011122
Insurance Age: 35 Date of Issue: March 15, 2025
Sex: Female Initial Face Amount: $500,000.00
This Is A Sex Distinct Policy Premium Class: Preferred Plus Non-Tobacco
SCHEDULE OF BENEFITS AND PREMIUMS
Life Insurance: $500,000.00 $812.00* 15 Years*
Terminal Illness Accelerated Death Benefit Rider
Providing For Payment Of Accelerated Benefits None ---
Terminal Illness Percentage: 40.00%
Maximum Benefit Amount: $200,000.00
Total Initial Annual Premium: $812.00
*For Level Premium Period. The Annual Premium shown above includes a policy fee of $60.00.
March 15, 2040 is the Termination Date of the Level Premium Period. For future term periods, see the Table
of Premiums and Face Amounts.
March 15, 2088 is the Termination Date of the Last Renewal Term Period referred to in the Renewal Option
provision. The first Annual premium is $812.00.
This Is A Springfield Policy
Conversions are allowed prior to the Conversion Expiry Date. The Conversion Expiry Date is
March 15, 2040. The Minimum Face Amount required for this policy after conversion is $50,000.00.
Payment Options Guaranteed Interest Rate: 0.25% Annual Effective
TABLE OF PREMIUMS AND FACE AMOUNTS
Policy
Year
1 $812.00 $500,000.00 3 $812.00 $500,000.00
2 $812.00 $500,000.00
16 $2,100.50 $40,000.00
17 $2,300.75 $40,000.00
*See Right To Change Premium provision.
Premium Payment Interval Premium Percentage
Semi-annual: 52.00%
Quarterly: 26.50%
Monthly (Pre-authorized checking): 8.50%
Grace Period. The Grace Period is the 31-day
period following a premium due date.
Incontestability. We rely on the statements made in the application. This policy will not be contested
after it has been in force during the Insured's lifetime for two years from the Date of Issue.
Suicide Exclusion. If the Insured takes his or her
own life, while sane or insane, within two years from the Date of Issue, We will limit the Death Benefit.`;

const BILL = `American General Life
Insurance Company
Notice of Payment Due Prepared Date: 2026-03-01
Payor Name: EXAMPLE, PAT
Due Date Premium Company Code Policy Number Payable Insurance Type
2026-03-15 $812.00 001 9900011122 Annual Life Insurance
Premiums are payable to the American General Life Insurance Company. Unless such payment is made`;

describe("insurance documents", () => {
  it("tells a policy packet and a billing notice from statements", () => {
    expect(insuranceKind(PACKET)).toBe("POLICY");
    expect(insuranceKind(BILL)).toBe("BILL");
    expect(insuranceKind("Account Summary\nPrevious Balance $10.00")).toBeNull();
  });

  it("reads the policy schedule, its table, riders and provisions", () => {
    const p = parsePolicy(PACKET);
    expect(p).toMatchObject({
      insurer: "American General Life Insurance Company",
      brand: "Corebridge Financial",
      product: "Example Term",
      policyNumber: "9900011122",
      insured: "Pat Example",
      owner: "Pat Example",
      state: "Springfield",
      issueDate: "2025-03-15",
      issueAge: 35,
      premiumClass: "Preferred Plus Non-Tobacco",
      faceCents: 50_000_000,
      annualPremiumCents: 81_200,
      policyFeeCents: 6_000,
      levelYears: 15,
      levelEndDate: "2040-03-15",
      finalEndDate: "2088-03-15",
      conversionExpiryDate: "2040-03-15",
      conversionMinFaceCents: 5_000_000,
      features: { renewable: true, convertible: true, reEntry: true, participating: false },
      modal: { semiannual: 0.52, quarterly: 0.265, monthly: 0.085 },
      graceDays: 31,
      freeLookDays: 10,
      contestableYears: 2,
      suicideYears: 2,
      paymentOptionsRate: 0.0025,
      billing: { frequency: "Annually", type: "Direct Billing" },
      requirements: { items: ["Policy Acceptance and Amendment of Application"], respondBy: "2025-04-30" },
      agent: "Sam Sample",
      servicePhone: "1-800-555-0100",
      packetDate: "2025-03-02",
    });
    // Two triples on one line, out of order, and the index's mention of the table skipped.
    expect(p.schedule.map((r) => r.year)).toEqual([1, 2, 3, 16, 17]);
    expect(p.schedule.at(-1)).toEqual({ year: 17, maxPremiumCents: 230_075, faceCents: 4_000_000 });
    expect(p.riders).toEqual([
      {
        name: "Terminal Illness Accelerated Death Benefit Rider",
        terms: [
          { label: "Terminal Illness Percentage", value: "40.00%" },
          { label: "Maximum Benefit Amount", value: "$200,000.00" },
        ],
      },
    ]);
  });

  it("refuses a packet without its schedule rather than guessing", () => {
    expect(() => parsePolicy(PACKET.replace(/Initial Face Amount: \$500,000\.00/, ""))).toThrow(/Policy schedule not found/);
  });

  it("reads a billing notice", () => {
    expect(parseBill(BILL)).toEqual({
      kind: "BILL",
      insurer: "American General Life Insurance Company",
      policyNumber: "9900011122",
      preparedDate: "2026-03-01",
      dueDate: "2026-03-15",
      premiumCents: 81_200,
      mode: "Annual",
    });
  });
});

describe("insurance report", () => {
  const policy = parsePolicy(PACKET);
  const bill = parseBill(BILL) satisfies BillingNotice;
  const row = (id: string, date: string, cents: number, payee: string): PremiumRow => ({ id, date, amountCents: -cents, payee, accountId: "card" });

  it("schedules each year's due date and age, and finds the next premium", () => {
    const r = buildInsuranceReport({ policies: [{ file: "a.pdf", policy }], bills: [], rows: [], today: "2026-01-10" });
    const p = r.policies[0]!;
    expect(p.years[0]).toMatchObject({ year: 1, start: "2025-03-15", end: "2026-03-14", age: 35 });
    expect(p.years.find((y) => y.year === 16)).toMatchObject({ start: "2040-03-15", age: 50 });
    expect(p.currentYear).toBe(1);
    expect(p.nextDue).toEqual({ date: "2026-03-15", cents: 81_200, year: 2 });
    expect(p.levelTotalCents).toBe(81_200 * 15);
    // Paying monthly: 12 × 8.50% of the annual premium.
    expect(p.modes.find((m) => m.mode === "Monthly")).toEqual({ mode: "Monthly", perPaymentCents: 6_902, payments: 12, yearCents: 82_824, extraCents: 1_624 });
  });

  it("matches premiums in the statements to each policy year, and only the insurer's charges", () => {
    const rows = [
      row("r1", "2025-03-01", 81_200, "AGL*INSURANCE PREMIUM 2727 ALLEN PKWY"),
      row("r2", "2025-06-01", 81_200, "SPRINGFIELD GROCERY"),
      row("r3", "2026-03-16", 81_200, "COREBRIDGE FINANCIAL LIFE"),
    ];
    const r = buildInsuranceReport({ policies: [{ file: "a.pdf", policy }], bills: [{ file: "b.pdf", bill }], rows, today: "2026-04-01" });
    const p = r.policies[0]!;
    // Paid with the application, two weeks before the date of issue: still year 1.
    expect(p.payments.map((x) => [x.rowId, x.year])).toEqual([
      ["r1", 1],
      ["r3", 2],
    ]);
    expect(p.paidCents).toBe(162_400);
    expect(p.bills).toEqual([{ file: "b.pdf", dueDate: "2026-03-15", premiumCents: 81_200, mode: "Annual", paidBy: "r3" }]);
    expect(p.nextDue).toEqual({ date: "2027-03-15", cents: 81_200, year: 3 });
  });

  it("keys the policy dates to today", () => {
    const r = buildInsuranceReport({ policies: [{ file: "a.pdf", policy }], bills: [], rows: [], today: "2026-04-01" });
    const dates = Object.fromEntries(r.policies[0]!.dates.map((d) => [d.key, d.date]));
    expect(dates).toMatchObject({ issue: "2025-03-15", contestable: "2027-03-15", level: "2040-03-15", conversion: "2040-03-15", final: "2088-03-15" });
  });
});
