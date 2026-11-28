import { describe, expect, it } from "vitest";
import { buildCoverReport, overviewPolicies } from "./cover";
import { insuranceKind, needsLayout, parseInsuranceDoc } from "./parse";
import type { PremiumRow } from "./report";
import type { AutoPolicy, PolicyForm, PropertyPolicy } from "./types";

// Made-up documents in the shape Progressive and its ASI group print them (no real person, policy or address).

const AUTO_DEC = `Form_SCTNID_CTGRY.IL11246489_DECPAGE
900000001 N IC00000 INS DECPAGE E POLWHITEFONT BDF_AA
Policy Number: 900000001
Underwritten by:
Progressive Example Insurance Co
March 1, 2026
Policy Period: Mar 15, 2026 - Sep 15, 2026
1-800-555-0100
PROGRESSIVE
Auto Insurance
This is your Declarations Page
The policy contract is form 9611D IL (06/14). The
contract is modified by form A331 (11/21).
Total 6 month policy premium $1,000.00

[pdf-layout]
@1:706	408-520 Policy Number: 900000001
@1:695	424-476 Underwritten by:
@1:683	424-519 Progressive Example Insurance Co
@1:674	48-107 PAT Q EXAMPLE	424-487 March 1, 2026
@1:660	424-560 Policy Period: Mar 15, 2026 - Sep 15, 2026
@1:531	108-332 This is your Declarations Page
@1:421	48-209 Drivers and household residents
@1:402	108-170 Pat Q Example
@1:388	108-239 Additional information: Named insured
@1:371	108-170 Sam R Example
@1:352	48-146 Outline of coverage
@1:336	108-272 2021 EXAMPLE MOTORS SEDAN
@1:323	108-218 VIN: 1HGEXAMPLE0000001
@1:310	108-229 Garaging Address: 12 Elm St
@1:297	173-186 4
@1:284	173-241 Springfield, IL 62701
@1:272	108-233 Primary use of the vehicle: Commute
@1:219	295-310 Limits	480-508 Deductible	541-564 Premium
@1:215	108-563 ……………………………………………………………
@1:206	108-168 Liability To Others	546-564 $400
@1:195	115-184 Bodily Injury Liability	294-455 $100,000 each person/$300,000 each accident
@1:182	115-200 Property Damage Liability	294-376 $50,000 each accident
@1:177	108-563 ……………………………………………………………
@1:168	108-266 Uninsured/Underinsured Motorist - Nonstacked	294-455 $100,000 each person/$300,000 each accident	555-564 60
@1:154	108-160 Comprehensive	294-355 Actual Cash Value	478-497 $500	555-564 90
@1:141	108-137 Collision	294-355 Actual Cash Value	478-497 $1,000	551-564 450
@1:126	108-232 Total 6 month policy premium	531-564 $1,000.00
@2:702	48-142 Premium discounts
@2:688	108-123 Policy
@2:673	108-149 900000001	294-559 Multi-Policy, Paid in Full, Online Signature - First Policy
@2:660	294-530 Period Only, Paperless and
@2:647	294-373 Three-Year Safe Driving
@2:623	48-197 Coverage on rented vehicle(s)
`;

const HOME_DEC = `Homeowners Declaration Page
AMERICAN STRATEGIC INSURANCE CORP.
Total Policy Premium:
$300.00
ASI HOR IL DEC 03 18	The ASI Group is an affiliate of The Progressive Corporation

[pdf-layout]
@1:774	156-336 AMERICAN STRATEGIC INSURANCE CORP.
@1:712	29-169 Homeowners Declaration Page
@1:684	36-61 Agent:	336-421 Total Policy Premium:	468-497 $300.00
@1:672	36-164 Example Insurance Agency, Inc	336-395 Policy Number:	468-512 ILZ000001
@1:660	36-94 P.O. Box 100	336-377 Plan Type:	468-487 HOR
@1:648	336-400 Policy Inception:	468-509 04/01/2026
@1:636	336-405 Policy Expiration:	468-509 04/01/2027
@1:612	36-127 For Policy Service, Call:	162-216 (800)555-0102
@1:570	29-90 Named Insured:
@1:558	29-187 PAT Q EXAMPLE AND SAM R EXAMPLE
@1:546	29-109 12 ELM ST
@1:486	29-137 Activity of This Transaction:	156-207 New Business
@1:462	29-106 Residence Premises:
@1:450	29-143 12 ELM ST APT 4
@1:438	29-139 SPRINGFIELD, IL 62701
@1:399	24-150 Coverages and Limits of Liability	407-428 Limit	487-522 Premium
@1:380	27-72 SECTION I:	102-176 C. Personal Property	402-431 $40,000	498-522 210.00
@1:368	102-156 D. Loss of Use	402-431 $12,000	491-522 Included
@1:356	27-75 SECTION II:	102-245 E. Personal Liability - Each Occurrence	402-436 $300,000	502-522 40.00
@1:344	102-265 F. Medical Payments to Others - Each Person	402-427 $1,000	507-522 5.00
@1:322	24-207 OTHER COVERAGES AND ENDORSEMENTS:
@1:284	24-83 DEDUCTIBLE:	101-121 $1,000
@1:35	24-65 Page 1 of 2	187-406 The ASI Group is an affiliate of The Progressive Corporation	464-558 ASI HOR IL DEC 03 18
@2:768	30-100 Named Insured(s):	120-278 PAT Q EXAMPLE AND SAM R EXAMPLE	372-431 Policy Number:	456-500 ILZ000001
@2:733	33-172 Other Coverages and Endorsements:
@2:727	330-384 Form Number	462-483 Limit	509-544 Premium
@2:715	33-124 Renters Protection Policy	330-401 ASI HOR IL 09 21
@2:704	33-204 Progressive Home Advantage Benefits Package	330-408 ASI HO PHAA 12 17
@2:693	33-288 Limited Fungi, Wet or Dry Rot, or Bacteria Coverage $10,000/$50,000
@2:682	32-106 E-Policy (Paperless)	521-544 -10.00
@2:670	32-107 Tier Factor Premium	521-544 -20.00
@2:657	32-96 Household Factor	524-544 15.00
@2:621	32-109 Paid in Full Discount	521-544 -25.00
@2:585	32-108 All Perils Deductible	471-485 1,000	513-544 Included
@2:567	29-94 Scheduled Items:
@2:35	24-118 ASI HOR IL DEC 03 18	187-406 The ASI Group is an affiliate of The Progressive Corporation	517-558 Page 2 of 2
`;

const AUTO_APPLICATION = `Form_SCTNID_CTGRY.IL11244905_APPLICAT
<docindex><index>APPSIGN</index></docindex> BDF_AA
Policyholder:
Pat Q Example
March 1, 2026
Application for Insurance
Insurance company: Progressive Example Insurance Co
Form 4905 IL (11/24)`;

const AUTO_CONTRACT = `ILLINOIS
AUTO POLICY
Form 9611D IL (06/14)
version 2.0`;

const HOME_RECEIPT = `AMERICAN STRATEGIC INSURANCE CORP
Payment Receipt
POLICY NUMBER:
PAYMENT DATE: 03/01/2026
Thank you for allowing Progressive to service your insurance needs.`;

const HOME_ENDORSEMENT = `THIS ENDORSEMENT CHANGES THE POLICY. PLEASE READ IT CAREFULLY.
ASI HO PHAA 12 17 Page 1 of 1
Progressive Home & Auto
Bundle Package`;

describe("Progressive auto documents", () => {
  it("reads the declarations from the layout: drivers, the vehicle, each coverage's limit, deductible and premium, the discounts", () => {
    expect(insuranceKind(AUTO_DEC)).toBe("AUTO");
    expect(needsLayout("AUTO", AUTO_DEC)).toBe(true);
    const p = parseInsuranceDoc(AUTO_DEC) as AutoPolicy;
    expect(p).toMatchObject({
      kind: "AUTO",
      insurer: "Progressive Example Insurance Co",
      policyNumber: "900000001",
      namedInsured: ["Pat Q Example"],
      drivers: ["Sam R Example"],
      issuedDate: "2026-03-01",
      periodStart: "2026-03-15",
      periodEnd: "2026-09-15",
      termMonths: 6,
      renewal: false,
      termPremiumCents: 100_000,
      contractType: "9611D IL (06/14)",
      amendments: "A331 (11/21)",
      servicePhone: "1-800-555-0100",
    });
    expect(p.vehicles).toEqual([{ n: 1, year: 2021, make: "Example Motors Sedan", vin: "1HGEXAMPLE0000001", garaged: "12 Elm St, 4, Springfield, IL 62701", lienholder: null }]);
    expect(p.coverages.map((c) => [c.name, c.limit, c.deductibleCents, c.premiumCents])).toEqual([
      ["Liability To Others (Bodily Injury Liability, Property Damage Liability)", "$100,000 each person/$300,000 each accident; $50,000 each accident", null, [40_000]],
      ["Uninsured/Underinsured Motorist - Nonstacked", "$100,000 each person/$300,000 each accident", null, [6_000]],
      ["Comprehensive", "Actual Cash Value, $500 deductible", 50_000, [9_000]],
      ["Collision", "Actual Cash Value, $1,000 deductible", 100_000, [45_000]],
    ]);
    // The coverages add up to the term premium printed beneath them.
    expect(p.coverages.reduce((s, c) => s + (c.premiumCents[0] ?? 0), 0)).toBe(p.termPremiumCents);
    expect(p.discounts.map((d) => d.name)).toEqual(["Multi-Policy", "Paid in Full", "Online Signature - First Policy Period Only", "Paperless", "Three-Year Safe Driving"]);
  });

  it("keeps the packet's other pages as reference forms, the contract included", () => {
    expect(parseInsuranceDoc(AUTO_APPLICATION)).toMatchObject({ kind: "FORM", line: "AUTO", code: "4905 IL (11/24)", title: "Application for Insurance" });
    expect(parseInsuranceDoc(AUTO_CONTRACT)).toMatchObject({ kind: "FORM", line: "AUTO", code: "9611D IL (06/14)", title: "Auto policy contract" });
  });
});

describe("Progressive (ASI) home documents", () => {
  it("reads the declaration page: coverages, deductible, forms and the premium's discounts", () => {
    expect(insuranceKind(HOME_DEC)).toBe("PROPERTY");
    const p = parseInsuranceDoc(HOME_DEC) as PropertyPolicy;
    expect(p).toMatchObject({
      kind: "PROPERTY",
      line: "RENTERS",
      form: "Renters Protection Policy",
      insurer: "American Strategic Insurance Corp",
      policyNumber: "ILZ000001",
      namedInsured: ["Pat Q Example", "Sam R Example"],
      premises: ["12 ELM ST APT 4", "SPRINGFIELD, IL 62701"],
      periodStart: "2026-04-01",
      periodEnd: "2027-04-01",
      termMonths: 12,
      renewal: false,
      totalPremiumCents: 30_000,
      deductibles: [{ name: "All Perils", cents: 100_000, text: "$1,000" }],
      agent: { name: "Example Insurance Agency, Inc", phone: "(800)555-0102" },
    });
    expect(p.property.map((c) => [c.code, c.name, c.limit, c.additional])).toEqual([
      ["C", "Personal Property", "$40,000", false],
      ["D", "Loss of Use", "$12,000", false],
      [null, "Limited Fungi, Wet or Dry Rot, or Bacteria Coverage", "$10,000/$50,000", true],
    ]);
    expect(p.liability.map((c) => [c.code, c.name, c.per, c.limit])).toEqual([
      ["E", "Personal Liability", "Each Occurrence", "$300,000"],
      ["F", "Medical Payments to Others", "Each Person", "$1,000"],
    ]);
    expect(p.forms.map((f) => f.code)).toEqual(["ASI HOR IL 09 21", "ASI HO PHAA 12 17"]);
    // A negative rating factor isn't a discount.
    expect(p.discounts).toEqual(["E-Policy (Paperless)", "Paid in Full Discount"]);
  });

  it("keeps the receipt and endorsements as reference forms", () => {
    expect(parseInsuranceDoc(HOME_RECEIPT)).toMatchObject({ kind: "FORM", line: "HOME", insurer: "American Strategic Insurance Corp", title: "Payment receipt" });
    expect(parseInsuranceDoc(HOME_ENDORSEMENT)).toMatchObject({ kind: "FORM", line: "HOME", code: "ASI HO PHAA 12 17" });
  });

  it("leaves a statement that only shows a Progressive charge alone", () => {
    expect(insuranceKind("Card statement\n03/01 PROGRESSIVE *INSURANCE 800-555-0100 OH 1,000.00")).toBeNull();
  });
});

describe("switching to Progressive", () => {
  const auto = parseInsuranceDoc(AUTO_DEC) as AutoPolicy;
  const home = parseInsuranceDoc(HOME_DEC) as PropertyPolicy;
  // The policies they replace: same VIN, same premises, terms that would run past the new ones' start.
  const oldAuto: AutoPolicy = { ...auto, insurer: "GEICO Example Company", policyNumber: "1111-22-33-44", periodStart: "2026-01-10", periodEnd: "2026-07-10", termPremiumCents: 90_000 };
  const oldHome: PropertyPolicy = { ...home, insurer: "State Farm Fire and Casualty Company", policyNumber: "99-Z9-Z999-9", premises: ["12 ELM ST APT 4", "SPRINGFIELD IL 62701"], periodStart: "2025-06-01", periodEnd: "2026-06-01", totalPremiumCents: 20_000 };
  const row = (id: string, date: string, cents: number, payee: string): PremiumRow => ({ id, date, amountCents: -cents, payee, accountId: "card" });
  const rows = [
    // Both new policies paid in full when bought, weeks before they start, to the same payee.
    row("home", "2026-02-20", 30_000, "PROGRESSIVE *HOME 800-555-0102 FL"),
    row("auto", "2026-02-25", 100_000, "PROGRESSIVE *INSURANCE 800-555-0100 OH"),
    // Not a premium of either (a different amount, before either term's usual window).
    row("other", "2026-02-01", 5_000, "PROGRESSIVE *INSURANCE 800-555-0100 OH"),
  ];
  const report = (today: string) =>
    buildCoverReport({
      homes: [
        { file: "Old/home.pdf", policy: oldHome },
        { file: "New/home.pdf", policy: home },
      ],
      autos: [
        { file: "Old/auto.pdf", policy: oldAuto },
        { file: "New/auto.pdf", policy: auto },
      ],
      renewals: [],
      forms: [
        { file: "New/contract.pdf", form: parseInsuranceDoc(AUTO_CONTRACT) as PolicyForm },
        { file: "New/receipt.pdf", form: parseInsuranceDoc(HOME_RECEIPT) as PolicyForm },
      ],
      rows,
      today,
    });

  it("ends the old policies the day the new ones start, and opens each tab on the new one", () => {
    const before = report("2026-03-05");
    // Before the switch the old one is still in force, but the tab already opens on the one replacing it.
    expect(before.autos.map((v) => [v.policy.policyNumber, v.status, v.ends, v.replacedBy?.policyNumber ?? null])).toEqual([
      ["900000001", "NOT_STARTED", "2026-09-15", null],
      ["1111-22-33-44", "IN_FORCE", "2026-03-15", "900000001"],
    ]);
    const after = report("2026-04-10");
    expect(after.autos.map((v) => [v.policy.policyNumber, v.status])).toEqual([
      ["900000001", "IN_FORCE"],
      ["1111-22-33-44", "ENDED"],
    ]);
    expect(after.homes.map((v) => [v.policy.policyNumber, v.status, v.ends])).toEqual([
      ["ILZ000001", "IN_FORCE", "2027-04-01"],
      ["99-Z9-Z999-9", "ENDED", "2026-04-01"],
    ]);
    expect(overviewPolicies([], before).find((p) => p.key === "1111-22-33-44")?.next).toEqual({ date: "2026-03-15", label: "Replaced by Progressive Example Insurance Co" });
  });

  it("counts a premium paid in full weeks ahead toward its term, telling the two policies apart by amount", () => {
    const r = report("2026-04-10");
    const auto = r.autos.find((v) => v.policy.policyNumber === "900000001")!;
    const home = r.homes.find((v) => v.policy.policyNumber === "ILZ000001")!;
    expect(auto.payments.map((x) => [x.rowId, x.term])).toEqual([["auto", "2026-03-15"]]);
    expect(home.payments.map((x) => [x.rowId, x.term])).toEqual([["home", "2026-04-01"]]);
    expect(auto.paidTermCents).toBe(100_000);
    expect(home.paidTermCents).toBe(30_000);
    // The packet's pages are linked by the contract's full form code, and the home receipt to the only ASI home policy.
    expect(auto.forms.map((f) => f.file)).toEqual(["New/contract.pdf"]);
    expect(home.forms.map((f) => f.file)).toEqual(["New/receipt.pdf"]);
  });
});
