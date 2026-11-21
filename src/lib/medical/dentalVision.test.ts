import { describe, expect, it } from "vitest";
import { medicalDerived } from "../book/derived/medical.ts";
import { careKind } from "./codes.ts";
import { eobCoverage, planDocument } from "./parse.ts";
import { planProblem, type HealthPlan } from "./plans.ts";
import { isMetLifeDentalEob, parseMetLifeDentalEob } from "./readers/metlifeDental.ts";
import { isVspEob, parseVspEob } from "./readers/vsp.ts";
import { addMonths, buildMedicalReport, latestBalances, statementChecks } from "./report.ts";

// ---------------------------------------------------------------- made-up statements, as the insurers' PDFs read as text

const dental = (o: { who: string; claim: string; date: string; lines: string; totals: string; overview: string; paid: string; owe: string; submitted: string }) => `7	Explanation of Dental Benefits
This shows how we determined your benefits after a recent visit to the dentist.
Claim summary
Your dentist submitted $ ${o.submitted}
MetLife paid your dentist $ ${o.paid}
You owe your dentist $ ${o.owe}
This is not a bill. You may receive a bill from your dentist.
Note : Because your dentist is part of the Preferred Dentist Program, all in-network
covered services are billed at a negotiated rate.
Your information
Name/Relationship
${o.who}
Name
Pat Example
Employer
EXAMPLE EMPLOYER CO
Group
0000001
Claim
${o.claim}
Dentist
Dr. Example Smile, DDS
Date processed
${o.date}
Metropolitan Life
Insurance Company
Page 1 of 4
Plan overview
${o.overview}
Claim detail
Date of
service
Service code, description Your Dentist
submitted
Negotiated fee Allowed
Amount
MetLife paid You owe your
dentist
${o.lines}
Totals1234567890000 ${o.totals}
Additional Information:`;

const DENTAL_A = dental({
  who: "Pat Q. Example/Self",
  claim: "1111111111 99",
  date: "February 3, 2025",
  submitted: "400.00",
  paid: "170.00",
  owe: "60.00",
  overview: "Individual - Pat Q. Example/Self\nPlan deductible $0.00 remaining\n$50.00 deductible\nPlan maximum $1,830.00 available\n$2,000.00 maximum",
  lines: "01/20/25 D0150, Comprehensive\noral evaluation\n$120.00 $60.00 $60.00 100% $60.00 $0.00\n01/20/25 D0210, Intraoral-series of\nradiographs\n$200.00 $100.00 $100.00 90% $45.00 $50.00 applied to\ndeductible.\n$55.00\n01/20/25 D1206, Topical\nfluoride-varnish\n$80.00 $5.00 Fluorides not covered on\nee/spouse.\n$5.00",
  totals: "$400.00 $165.00 $160.00 $105.00 $60.00",
});
// The totals row says what MetLife paid in all; the summary above it says the same.
const DENTAL_A_FIXED = DENTAL_A.replace("MetLife paid your dentist $ 170.00", "MetLife paid your dentist $ 105.00");

const DENTAL_B = dental({
  who: "Sam Example/Dependent",
  claim: "2222222222 99",
  date: "July 9, 2025",
  submitted: "150.00",
  paid: "90.00",
  owe: "0.00",
  overview: "Individual - Sam Example/Dependent\nPlan maximum $1,910.00 available\n$2,000.00 maximum",
  lines: "06/30/25 D1110, Prophylaxis- adult $150.00 $90.00 $90.00 100% $90.00 $0.00",
  totals: "$150.00 $90.00 $90.00 $90.00 $0.00",
});

const VSP = `.
VBS 22-06 Page 1 of 8
Vision Benefit Statement
*** This is not a bill. Do not pay. ***
Date of Notice: 05/10/2025
Name of Plan: VSP
For Inquiries: VSP
Case Details
Name: Pat Example Case Number: 000000001
Subscriber: Pat Example Relationship: Member
Claim #: 12345678-00 Network: In Network Claim Date of Service: 04/28/2025
Provider: Example Optometry, OD
Total
Amount
Billed:
$500.00
Total
Amount
Paid:
$230.00
Your Costs:
The provider may bill
you for this amount if
you have not yet paid.
$35.00 Total
Savings: $235.00
VBS 22-06 Page 3 of 8
Services
Received
Service
Code Service Description
Amount
Billed Discounts
Amount
Not
Covered
Allowed
Charges
Copay/
Coinsurance
Other
Insurance
Amount
Paid
Claim Line
Status
PD=paid
DN=denied
Remark
Code**
04-28-2025 S0620 Routine Ophthalmological
Examination Including Ref
$150.00 $80.00 $0.00 $70.00 $10.00 $0.00 $60.00 PD
04-28-2025 V2020 Frames Purchases $250.00 $100.00 $0.00 $150.00 $0.00 $0.00 $150.00 PD
04-28-2025 V2103 Spherocylinder 1vis
$100.00 $55.00 $0.00 $45.00 $25.00 $0.00 $20.00 PD
Interest Paid: $0.00
Deductible Amount: Not Applicable`;

describe("MetLife dental EOB", () => {
  it("is recognized as a dental EOB", () => {
    expect(eobCoverage(DENTAL_A)).toBe("DENTAL");
    expect(isMetLifeDentalEob(DENTAL_A)).toBe(true);
    expect(isVspEob(DENTAL_A)).toBe(false);
  });

  it("reads covered lines, a deductible, a line the plan doesn't cover, and the overview", () => {
    const s = parseMetLifeDentalEob(DENTAL_A_FIXED);
    expect(s).toMatchObject({ coverage: "DENTAL", insurer: "MetLife", statementDate: "2025-02-03", sponsor: "EXAMPLE EMPLOYER CO", group: "0000001", balancesFrom: "2025-01-01", balancesTo: "2025-12-31" });
    const c = s.claims[0]!;
    expect(c).toMatchObject({ id: "1111111111 99", patient: "Pat", relationship: "self", provider: "Dr. Example Smile, DDS", inNetwork: true });
    expect(c.lines.map((l) => [l.code, l.service, l.billedCents, l.memberRateCents, l.planCents, l.deductibleCents, l.coinsuranceCents, l.yourShareCents])).toEqual([
      ["D0150", "Comprehensive oral evaluation", 12_000, 6_000, 6_000, 0, 0, 0],
      ["D0210", "Intraoral-series of radiographs", 20_000, 10_000, 4_500, 5_000, 500, 5_500],
      ["D1206", "Topical fluoride-varnish", 8_000, 0, 0, 0, 0, 500],
    ]);
    expect(c.lines[2]!.note).toBe("Fluorides not covered on ee/spouse.");
    expect(s.balances).toEqual([
      { person: "Pat", benefit: "Dental", inNetwork: true, kind: "DEDUCTIBLE", limitCents: 5_000, usedCents: 5_000, remainingCents: 0, includesPharmacy: false },
      { person: "Pat", benefit: "Dental", inNetwork: true, kind: "ANNUAL_MAXIMUM", limitCents: 200_000, usedCents: 17_000, remainingCents: 183_000, includesPharmacy: false },
    ]);
    expect(statementChecks("a.pdf", s).every((x) => x.ok)).toBe(true);
  });

  it("holds the claim summary to the lines", () => {
    const wrong = statementChecks("a.pdf", parseMetLifeDentalEob(DENTAL_A));
    // The summary's paid amount isn't checked (only what you owe is); what you owe agrees.
    expect(wrong.find((x) => x.id.startsWith("medical.summary"))).toMatchObject({ ok: true });
  });

  it("refuses a covered line whose paid and owed amounts don't add to the allowed amount", () => {
    expect(() => parseMetLifeDentalEob(DENTAL_B.replace("$90.00 100% $90.00 $0.00", "$90.00 100% $80.00 $0.00"))).toThrow(/don't add to the allowed amount/);
  });
});

describe("VSP vision statement", () => {
  it("reads each line's seven amounts and the claim's printed totals", () => {
    expect(eobCoverage(VSP)).toBe("VISION");
    const s = parseVspEob(VSP);
    expect(s).toMatchObject({ coverage: "VISION", insurer: "VSP", statementDate: "2025-05-10", balances: [] });
    const c = s.claims[0]!;
    expect(c).toMatchObject({ id: "12345678-00", baseId: "12345678", version: 0, patient: "Pat", relationship: "self", provider: "Example Optometry, OD", inNetwork: true });
    expect(c.lines.map((l) => [l.code, l.service, l.memberRateCents, l.copayCents, l.planCents, l.yourShareCents])).toEqual([
      ["S0620", "Routine Ophthalmological Examination Including Ref", 7_000, 1_000, 6_000, 1_000],
      ["V2020", "Frames Purchases", 15_000, 0, 15_000, 0],
      ["V2103", "Spherocylinder 1vis", 4_500, 2_500, 2_000, 2_500],
    ]);
    expect(c.totals).toMatchObject({ billedCents: 50_000, planCents: 23_000, yourShareCents: 3_500 });
    expect(statementChecks("v.pdf", s).every((x) => x.ok)).toBe(true);
  });

  it("fails its own check when the lines don't add to the printed totals", () => {
    const s = parseVspEob(VSP.replace("Paid:\n$230.00", "Paid:\n$231.00"));
    expect(statementChecks("v.pdf", s)[0]).toMatchObject({ ok: false });
  });
});

describe("plan documents and kinds of care", () => {
  it("names dental and vision plan printouts", () => {
    expect(planDocument("HOW DOES YOUR PLAN WORK?\nYour total dental benefit is $2,000.00\nShowing coverage details for")).toMatchObject({ coverage: "DENTAL", title: "Coverage details" });
    expect(planDocument("Example Vision Care - Benefits Detail for PAT EXAMPLE\nBenefits in this section")).toMatchObject({ coverage: "VISION", title: "Benefits summary" });
  });

  it("groups dental and vision codes", () => {
    expect(careKind("D1110")).toBe("Dental exams & cleanings");
    expect(careKind("D0210")).toBe("Dental X-rays");
    expect(careKind("D2740")).toBe("Fillings & crowns");
    expect(careKind("D7140")).toBe("Oral surgery");
    expect(careKind("S0620")).toBe("Eye exams");
    expect(careKind("V2020")).toBe("Glasses: frames");
    expect(careKind("V2103")).toBe("Glasses: lenses");
    expect(careKind("V2520")).toBe("Contact lenses");
    expect(careKind("V2799")).toBe("Other vision");
  });
});

// ---------------------------------------------------------------- the report over dental

const DENTAL_PLAN: HealthPlan = {
  id: "example-dental-2025",
  coverage: "DENTAL",
  insurer: "Example Dental Co",
  name: "Example Dental PPO",
  coverageFrom: "2025-01-01",
  coverageTo: "2025-12-31",
  accumulator: "CALENDAR_YEAR",
  hsaEligible: false,
  deductible: { inNetwork: { individualCents: 5_000, familyCents: null }, outOfNetwork: null },
  outOfPocket: null,
  annualMaximum: { individualCents: 200_000, familyCents: null },
  allowances: [{ id: "x", service: "Night guard", cents: 30_000, per: "36_MONTHS" }],
  services: [],
  limits: [{ id: "cleanings", service: "Cleanings", limit: 1, unit: "cleaning", per: "12_MONTHS", codes: ["D1110"] }],
  excluded: [],
  otherCovered: [],
  rules: [],
  sources: [],
};

describe("buildMedicalReport over dental", () => {
  const a = parseMetLifeDentalEob(DENTAL_A_FIXED);
  const b = parseMetLifeDentalEob(DENTAL_B);
  const r = buildMedicalReport({ statements: [{ file: "a.pdf", statement: a }, { file: "b.pdf", statement: b }], pending: [], plans: [DENTAL_PLAN], today: "2025-08-01" });

  it("keeps each person's latest balance, though each statement prints only its own patient's", () => {
    const y = r.years.find((x) => x.coverage === "DENTAL" && x.year === 2025)!;
    expect(y.balances!.rows.map((x) => [x.person, x.kind, x.usedCents, x.asOf])).toEqual([
      ["Pat", "DEDUCTIBLE", 5_000, "2025-02-03"],
      ["Pat", "ANNUAL_MAXIMUM", 17_000, "2025-02-03"],
      ["Sam", "ANNUAL_MAXIMUM", 9_000, "2025-07-09"],
    ]);
    expect(latestBalances([{ file: "a.pdf", statement: a }, { file: "a2.pdf", statement: { ...a, statementDate: "2025-03-01", balances: a.balances.map((x) => ({ ...x, usedCents: 1 })) } }])[0]).toMatchObject({ usedCents: 1, asOf: "2025-03-01" });
  });

  it("holds the plan's deductible and annual maximum to the EOBs", () => {
    expect(r.checks.find((c) => c.id === `medical.plan:${DENTAL_PLAN.id}`)).toMatchObject({ ok: true, detail: expect.stringMatching(/deductible, annual maximum are the ones its EOBs count against/) });
    const wrong = buildMedicalReport({ statements: [{ file: "a.pdf", statement: a }], pending: [], plans: [{ ...DENTAL_PLAN, annualMaximum: { individualCents: 150_000, familyCents: null } }], today: "2025-08-01" });
    expect(wrong.checks.find((c) => c.id.startsWith("medical.plan"))).toMatchObject({ ok: false, detail: expect.stringMatching(/annual maximum: the plan file says 1500/) });
  });

  it("says when a rolling limit that's used up is covered again", () => {
    expect(r.planLimits[DENTAL_PLAN.id]![0]).toMatchObject({ tracked: true, from: "2024-08-01", to: "2025-08-01", people: [{ person: "Sam", used: 1, dates: ["2025-06-30"], nextOn: "2026-06-30" }] });
    expect(addMonths("2025-01-31", 1)).toBe("2025-02-28");
    expect(addMonths("2025-03-15", -12)).toBe("2024-03-15");
  });

  it("lists the dental figures: balances, the annual maximum and allowances", () => {
    const figures = medicalDerived(r);
    expect(figures.find((f) => f.figure === "balance-used" && f.key === "DENTAL|2025|Sam|ANNUAL_MAXIMUM|in")).toMatchObject({ value: { cents: 9_000 } });
    expect(figures.find((f) => f.figure === "plan-max" && f.key === `${DENTAL_PLAN.id}|in|individual`)).toMatchObject({ value: { cents: 200_000 } });
    expect(figures.find((f) => f.figure === "plan-allowance")).toMatchObject({ key: `${DENTAL_PLAN.id}|x`, value: { cents: 30_000 } });
    expect(figures.some((f) => f.figure === "plan-oop")).toBe(false);
  });

  it("accepts a dental plan without an out-of-pocket limit, but not a medical one", () => {
    expect(planProblem(DENTAL_PLAN)).toBeNull();
    expect(planProblem({ ...DENTAL_PLAN, coverage: "MEDICAL" })).toMatch(/out-of-pocket limit/);
    expect(planProblem({ ...DENTAL_PLAN, allowances: [{ id: "x", service: "Frames", cents: 1.5, per: "24_MONTHS" }] })).toMatch(/allowance "Frames"/);
  });
});
