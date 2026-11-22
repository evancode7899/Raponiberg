import { describe, expect, it } from "vitest";
import { insuranceDerived } from "../book/derived/insurance";
import { buildCoverReport, overviewPolicies, paidInYear } from "./cover";
import { insuranceKind, needsLayout, parseInsuranceDoc } from "./parse";
import type { PremiumRow } from "./report";
import type { AutoPolicy, AutoRenewal, PolicyForm, PropertyPolicy } from "./types";
import { segment, spaced, spacedCity, spacedName, spacedStreet } from "./words";

describe("words printed without spaces", () => {
  it("splits on capitals, digits and punctuation, and lowercase runs only when the words spell all of it", () => {
    expect(spaced("DamagetothePropertyofOthers")).toBe("Damage to the Property of Others");
    expect(spaced("Fungus(InclMold)LimitedCov")).toBe("Fungus (Incl Mold) Limited Cov");
    expect(spaced("10%ofCoverageBamount/$750peritem")).toBe("10% of Coverage B amount / $750 per item");
    expect(spaced("Additional5%available")).toBe("Additional 5% available");
    expect(spaced("CreditCard,BankFundTransferCard,Forgery,andCounterfeitMoney")).toBe("Credit Card, Bank Fund Transfer Card, Forgery, and Counterfeit Money");
    expect(spaced("$41,800")).toBe("$41,800");
    // Not every letter run is words: an unknown one is left as printed.
    expect(segment("springfield")).toBeNull();
    expect(spaced("Springfield")).toBe("Springfield");
  });

  it("spaces names and addresses without breaking words that only contain a street word", () => {
    expect(spacedName("SAMSAMPLEINSAGENCYINC")).toBe("SAMSAMPLE INS AGENCY INC");
    expect(spacedName("EXAMPLE,PAT")).toBe("EXAMPLE, PAT");
    expect(spacedStreet("12ELMBLVDAPT4")).toBe("12 ELM BLVD APT 4");
    expect(spacedStreet("77ANDREWSWAY")).toBe("77 ANDREWSWAY");
    expect(spacedCity("SPRINGFIELDIL62701-1234")).toBe("SPRINGFIELD IL 62701-1234");
  });
});

/**
 * A made-up State Farm renters declarations page: its plain text (words run together, the
 * right-aligned values mirrored) and the positioned layout the scan appends, with the
 * mirrored runs already turned back round.
 */
const STATE_FARM = `StateFarmFireandCasualtyCompany
RENEWALDECLARATIONS
EXAMPLE,PAT
SECTIONI-PROPERTYCOVERAGESANDLIMITS
BPersonalProperty $	008,14

[pdf-layout]
@1:740	56-203 StateFarmFireandCasualtyCompany
@1:669	333-508 RENEWALDECLARATIONS
@1:624	333-398 AMOUNTDUE:	531-555 None
@1:608	333-521 Paymentisdueby BILLEDTHROUGHSFPP	641-670 ____
@1:582	333-400 PolicyNumber:	419-475 99-Z9-Z999-9
@1:551	333-394 PolicyPeriod:	404-449 12Months
@1:537	333-527 EffectiveDates: AUG152025 to AUG152026
@1:490	333-431 YourStateFarmAgent
@1:485	35-117 RentersPolicy
@1:477	333-492 SAMSAMPLEINSAGENCYINC
@1:467	36-176 LocationofResidencePremises
@1:464	333-418 1MAINST
@1:455	36-173 12ELMBLVDAPT4
@1:451	333-469 SPRINGFIELDIL 62701
@1:443	36-167 SPRINGFIELDIL62701-1234	660-667 28
@1:419	333-425 Phone: (555)010-0199
@1:365	36-122 AutomaticRenewal
@1:260	35-80 PREMIUM
@1:246	35-106 AnnualPremium	559-590 $312.00
@1:236	35-284 Yourpremiumhasalreadybeenadjustedbythefollowing:
@1:222	37-135 ClaimRecordDiscount	177-244 LoyalCustomer
@1:191	35-98 TotalPremium	564-595 $312.00
@1:9	35-111 Prepared JUN012025
@2:682	35-112 NAMEDINSURED	305-495 MORTGAGEEANDADDITIONALINTERESTS
@2:668	35-156 EXAMPLE,PAT
@2:616	35-249 SECTIONI-PROPERTYCOVERAGESANDLIMITS
@2:602	35-75 Coverage	497-567 LimitofLiability
@2:588	35-124 BPersonalProperty	498-504 $	539-570 41,800
@2:576	35-98 CLossofUse	498-504 $	539-570 12,540
@2:549	35-137 AdditionalCoverages
@2:537	35-98 ArsonReward	539-570 $1,000
@2:501	35-106 DebrisRemoval	466-570 Additional5%available
@2:453	35-180 Trees,Shrubs,andLandscaping	382-570 10%ofCoverageBamount/$750peritem
@2:436	35-247 SECTIONII-LIABILITYCOVERAGESANDLIMITS
@2:422	35-75 Coverage	497-567 LimitofLiability
@2:408	35-206 LPersonalLiability(EachOccurrence)	498-504 $	525-570 300,000
@2:396	35-239 MMedicalPaymentstoOthers(EachPerson)	498-504 $	545-570 2,000
@2:381	35-137 AdditionalCoverages	660-697 JUN012025
@2:357	35-185 DamagetothePropertyofOthers	498-504 $	545-570 1,000
@2:340	35-83 INFLATION
@2:324	35-174 InflationCoverageIndex:301.7
@2:309	11-96 o1F1081A DEDUCTIBLES
@2:293	35-123 SectionIDeductible	485-568 DeductibleAmount
@2:279	35-80 AllLosses	498-504 $	553-570 1,000
@2:262	35-178 LOSSSETTLEMENTPROVISIONS
@2:246	35-232 B1LimitedReplacementCost-CoverageB
@3:682	63-245 FORMS,OPTIONS,ANDENDORSEMENTS
@3:666	63-102 H4-2107	183-247 RentersPolicy
@3:630	63-112 HO-2221.2	180-301 *AmendatoryEndorsement
@3:618	180-272 *NewFormAttached
@3:601	63-172 ADDITIONALMESSAGES
`;

describe("State Farm home declarations", () => {
  it("is recognized from its run-together text and read from the layout", () => {
    expect(insuranceKind(STATE_FARM)).toBe("PROPERTY");
    expect(needsLayout("PROPERTY")).toBe(true);
    const p = parseInsuranceDoc(STATE_FARM) as PropertyPolicy;
    expect(p).toMatchObject({
      kind: "PROPERTY",
      line: "RENTERS",
      form: "Renters Policy",
      insurer: "State Farm Fire and Casualty Company",
      policyNumber: "99-Z9-Z999-9",
      namedInsured: ["Example, Pat"],
      premises: ["12 ELM BLVD APT 4", "SPRINGFIELD IL 62701-1234"],
      periodStart: "2025-08-15",
      periodEnd: "2026-08-15",
      termMonths: 12,
      renewal: true,
      autoRenews: true,
      annualPremiumCents: 31_200,
      totalPremiumCents: 31_200,
      discounts: ["Claim Record Discount", "Loyal Customer"],
      inflationIndex: "301.7",
      billing: "Billed through SFPP",
      amountDue: "None",
      agent: { name: "SAMSAMPLE INS AGENCY INC", phone: "(555)010-0199" },
      preparedDate: "2025-06-01",
      lossSettlement: ["B1 Limited Replacement Cost - Coverage B"],
      deductibles: [{ name: "All Losses", cents: 100_000, text: "$1,000" }],
      forms: [
        { code: "H4-2107", name: "Renters Policy", isNew: false },
        { code: "HO-2221.2", name: "Amendatory Endorsement", isNew: true },
      ],
    });
    expect(p.property.map((c) => [c.code, c.name, c.limit, c.limitCents, c.additional])).toEqual([
      ["B", "Personal Property", "$41,800", [4_180_000], false],
      ["C", "Loss of Use", "$12,540", [1_254_000], false],
      [null, "Arson Reward", "$1,000", [100_000], true],
      [null, "Debris Removal", "Additional 5% available", [], true],
      [null, "Trees, Shrubs, and Landscaping", "10% of Coverage B amount / $750 per item", [75_000], true],
    ]);
    expect(p.liability.map((c) => [c.code, c.name, c.per, c.limit, c.additional])).toEqual([
      ["L", "Personal Liability", "Each Occurrence", "$300,000", false],
      ["M", "Medical Payments to Others", "Each Person", "$2,000", false],
      [null, "Damage to the Property of Others", null, "$1,000", true],
    ]);
  });

  it("names what's missing rather than guessing", () => {
    expect(() => parseInsuranceDoc(STATE_FARM.replace(/AnnualPremium\t559-590 \$312\.00/, "AnnualPremium"))).toThrow(/annual premium/);
  });
});

/** A made-up GEICO declarations page, as its text extracts (columns tab-separated). */
const GEICO_DEC = `Renewal Page 3 of 9
DEC_PAGE (03-14) (Page 1 of 2)
Declarations Page
This is a description of your coverage.
PAT EXAMPLE
12 ELM ST
SPRINGFIELD IL 62701
Date Issued: \tFebruary 2, 2026
GEICO Casualty Example Company
Tel: \t1-800-555-0100
Policy Number: 1111-22-33-44
Coverage Period:
03-01-26 through 09-01-26
Named Insured
Pat Example
Additional Drivers
Sam Example
Vehicle \tVIN \tVehicle Location \tFinance Company/
Lienholder
1 2021 Example Sedan \t1EXAMPLE0XYZ00001 \tSPRINGFIELD IL 62701
2 2019 Example Wagon \t2EXAMPLE0XYZ00002 \tSPRINGFIELD IL 62701 \tEXAMPLE AUTO FINANCE
Coverages* \tLimits and/or Deductibles \tVehicle 1 \tVehicle 2
Bodily Injury Liability
Each Person/Each Occurrence \t$100,000/$300,000 \t$201.10 \t$188.40
Property Damage Liability \t$50,000 \t$140.20 \t$131.90
Uninsured/Underinsured Motorists
Non-Stacked
Each Person/Each Occurrence \t$100,000/$300,000 \t$31.05 \t$29.95
Comprehensive (Excluding Collision) \t$250 Ded/Full Glass \t$66.30 \t$58.70
Collision \t$1,000 Ded \t$170.40 \t$152.00
Total Six Month Premium \t$1,170.00
Discounts
The total value of your discounts is \t$222.10
Multi-Vehicle .......................................................................$140.00
Good Driver .........................................................................$82.10
Financial Responsibility ..............................................................Included
Contract Type: \tA30IL
Contract Amendments: \tALL VEHICLES - A30IL M373
Unit Endorsements: \tA161(VEH 1)
`;

const GEICO_LETTER = `Policy Number: \t1111-22-33-44
GEICO Casualty Example Company
February 2, 2026
Dear Pat Example,
You're ready for renewal!
Policy Summary
Policy Term: \t03-01-26 - 09-01-26
New Premium: \t$1,170.00
Prior Premium: \t$1,098.50
`;

const GEICO_NOTICE = `Renewal Page 7 of 9
IMPORTANT NOTICE
M-308(4-94)
As a GEICO family auto policyholder, a rental car is covered.
Policy Number: 1111-22-33-44
`;

const GEICO_CONTRACT = `New Business Page 21 of 46
ONE GEICO PLAZA
Illinois
Family
Automobile
Insurance
Policy
A30IL (12-22)
GEICO Casualty Example Company
`;

describe("GEICO auto documents", () => {
  it("reads the declarations: drivers, vehicles, each coverage's limit and premium per vehicle, discounts", () => {
    expect(insuranceKind(GEICO_DEC)).toBe("AUTO");
    const p = parseInsuranceDoc(GEICO_DEC) as AutoPolicy;
    expect(p).toMatchObject({
      insurer: "GEICO Casualty Example Company",
      policyNumber: "1111-22-33-44",
      namedInsured: ["Pat Example"],
      drivers: ["Sam Example"],
      issuedDate: "2026-02-02",
      periodStart: "2026-03-01",
      periodEnd: "2026-09-01",
      termMonths: 6,
      renewal: true,
      termPremiumCents: 117_000,
      discountTotalCents: 22_210,
      contractType: "A30IL",
      servicePhone: "1-800-555-0100",
    });
    expect(p.vehicles).toEqual([
      { n: 1, year: 2021, make: "Example Sedan", vin: "1EXAMPLE0XYZ00001", garaged: "SPRINGFIELD IL 62701", lienholder: null },
      { n: 2, year: 2019, make: "Example Wagon", vin: "2EXAMPLE0XYZ00002", garaged: "SPRINGFIELD IL 62701", lienholder: "EXAMPLE AUTO FINANCE" },
    ]);
    expect(p.coverages.map((c) => [c.name, c.per, c.limit, c.limitCents, c.deductibleCents, c.premiumCents])).toEqual([
      ["Bodily Injury Liability", "Each Person/Each Occurrence", "$100,000/$300,000", [10_000_000, 30_000_000], null, [20_110, 18_840]],
      ["Property Damage Liability", null, "$50,000", [5_000_000], null, [14_020, 13_190]],
      ["Uninsured/Underinsured Motorists (Non-Stacked)", "Each Person/Each Occurrence", "$100,000/$300,000", [10_000_000, 30_000_000], null, [3_105, 2_995]],
      ["Comprehensive (Excluding Collision)", null, "$250 Ded/Full Glass", [], 25_000, [6_630, 5_870]],
      ["Collision", null, "$1,000 Ded", [], 100_000, [17_040, 15_200]],
    ]);
    // The coverages add up to the term premium the page prints.
    expect(p.coverages.flatMap((c) => c.premiumCents).reduce((s: number, x) => s + (x ?? 0), 0)).toBe(p.termPremiumCents);
    expect(p.discounts).toEqual([
      { name: "Multi-Vehicle", cents: 14_000 },
      { name: "Good Driver", cents: 8_210 },
      { name: "Financial Responsibility", cents: null },
    ]);
  });

  it("reads the renewal letter and keeps the packet's other pages as reference forms", () => {
    expect(insuranceKind(GEICO_LETTER)).toBe("AUTO_RENEWAL");
    expect(parseInsuranceDoc(GEICO_LETTER)).toEqual({ kind: "AUTO_RENEWAL", insurer: "GEICO Casualty Example Company", policyNumber: "1111-22-33-44", date: "2026-02-02", periodStart: "2026-03-01", periodEnd: "2026-09-01", newPremiumCents: 117_000, priorPremiumCents: 109_850 });
    expect(insuranceKind(GEICO_NOTICE)).toBe("FORM");
    expect(parseInsuranceDoc(GEICO_NOTICE)).toMatchObject({ kind: "FORM", policyNumber: "1111-22-33-44", code: "M-308", title: "Important Notice" });
    expect(parseInsuranceDoc(GEICO_CONTRACT)).toMatchObject({ kind: "FORM", policyNumber: null, code: "A30IL", title: "Illinois Family Automobile Insurance Policy" });
    // Text that merely names GEICO (a card statement's charge) isn't a policy document.
    expect(insuranceKind("GEICO *AUTO 800-555-0100 DC  $195.00")).toBeNull();
  });
});

describe("home and auto cover report", () => {
  const home = parseInsuranceDoc(STATE_FARM) as PropertyPolicy;
  const auto = parseInsuranceDoc(GEICO_DEC) as AutoPolicy;
  const letter = parseInsuranceDoc(GEICO_LETTER) as AutoRenewal;
  const forms = [
    { file: "Auto/notice.pdf", form: parseInsuranceDoc(GEICO_NOTICE) as PolicyForm },
    { file: "Auto/contract.pdf", form: parseInsuranceDoc(GEICO_CONTRACT) as PolicyForm },
  ];
  const row = (id: string, date: string, cents: number, payee: string): PremiumRow => ({ id, date, amountCents: -cents, payee, accountId: "card" });
  const rows = [
    row("h0", "2025-07-20", 2_400, "STATE FARM INSURANCE 800-555-0101 IL"),
    row("h1", "2025-08-20", 2_600, "STATE FARM INSURANCE 800-555-0101 IL"),
    row("h2", "2025-09-20", 2_600, "STATE FARM INSURANCE 800-555-0101 IL"),
    row("a0", "2025-10-01", 18_400, "GEICO *AUTO 800-555-0100 DC"),
    row("a1", "2026-03-01", 19_600, "GEICO *AUTO 800-555-0100 DC"),
    row("x", "2026-03-02", 4_000, "EXAMPLE GROCER"),
  ];
  const report = buildCoverReport({ homes: [{ file: "Home/dec.pdf", policy: home }], autos: [{ file: "Auto/dec.pdf", policy: auto }], renewals: [{ file: "Auto/letter.pdf", renewal: letter }], forms, rows, today: "2026-04-10" });

  it("counts each premium toward the term it paid for, and earlier ones to no term on file", () => {
    const h = report.homes[0]!;
    expect(h.status).toBe("IN_FORCE");
    expect(h.payments.map((x) => [x.rowId, x.term])).toEqual([
      ["h0", null],
      ["h1", "2025-08-15"],
      ["h2", "2025-08-15"],
    ]);
    expect(h.paidTermCents).toBe(5_200);
    expect(h.annualCents).toBe(31_200);
  });

  it("adds the term a renewal letter renews, at its prior premium, and links the packet's pages", () => {
    const a = report.autos[0]!;
    expect(a.terms.map((x) => [x.start, x.end, x.premiumCents, x.from])).toEqual([
      ["2026-03-01", "2026-09-01", 117_000, "DECLARATIONS"],
      ["2025-09-01", "2026-03-01", 109_850, "RENEWAL_LETTER"],
    ]);
    expect(a.payments.map((x) => [x.rowId, x.term])).toEqual([
      ["a0", "2025-09-01"],
      ["a1", "2026-03-01"],
    ]);
    expect(a.annualCents).toBe(234_000);
    expect(a.forms.map((f) => f.title)).toEqual(["Illinois Family Automobile Insurance Policy", "Important Notice"]);
  });

  it("feeds the Overview: a year of cover per policy, and the premiums of the year to the proven date", () => {
    const all = overviewPolicies([], report);
    expect(all.map((p) => [p.line, p.annualCents, p.next])).toEqual([
      ["HOME", 31_200, { date: "2026-08-15", label: "Renews" }],
      ["AUTO", 234_000, { date: "2026-09-01", label: "Term ends" }],
    ]);
    expect(paidInYear(all, "2026-02-28").map((x) => x.rowId)).toEqual(["h0", "h1", "h2", "a0"]);

    const figs = insuranceDerived({ policies: [], ...report, through: "2026-02-28" });
    const val = (figure: string, key?: string) => figs.find((f) => f.figure === figure && (f.key ?? null) === (key ?? null))?.value;
    expect(val("annual-total")).toEqual({ cents: 265_200 });
    expect(val("paid-year")).toEqual({ cents: 26_000 });
    expect(val("annual", "AUTO|1111-22-33-44")).toEqual({ cents: 234_000 });
    expect(val("renewal-change", "1111-22-33-44")).toEqual({ cents: 7_150 });
    expect(val("paid-term", "99-Z9-Z999-9")).toEqual({ cents: 5_200 });
    expect(val("limit", "99-Z9-Z999-9|L0")).toEqual({ text: "$300,000" });
    expect(val("coverage-premium", "1111-22-33-44|4|1")).toEqual({ cents: 15_200 });
    // Every figure the tabs draw has a unique key, so a proof always finds the one it shows.
    const keys = figs.map((f) => `${f.figure}|${f.key ?? ""}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
