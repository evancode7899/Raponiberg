import { describe, expect, it } from "vitest";
import { insuranceKind, parseBill, parseInsuranceDoc, parsePolicy } from "./parse";
import { buildInsuranceReport, type PremiumRow } from "./report";
import type { BillingNotice, PaymentReceipt, PolicyStatus, TermPolicy } from "./types";

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

/** A made-up Protective policy: values ahead of their labels, words split by tabs and stray spaces, as its extracted text comes out. */
const PROTECTIVE_POLICY = `ZZ1234567
TERM 	LIFE 	INSURANCE
$500,000
Annually 	$250.00
20 	Years
18 	Years
Select 	Preferred
March 	15, 	2025
March 	15, 	2090
Pat 	Example
Pat 	Example
30
Female
None
Protective 	Life 	Insurance 	Company
SAM 	Q 	SAMPLE
ABCD
Owner 	Name:
Policy 	Summary 	Sheet
-- 2 of 9 --
P RO TECTI V E 	L I F E 	I NS U RA N CE 	C O MPAN Y
P. 	O. 	Box 	1000; 	Birmingham, 	Alabama 	35000; 	(800) 	555-0100
Y OU 	HAVE 	THE 	RIGHT 	TO 	CANCEL 	THIS 	INSURANCE 	POLICY. 	If 	you 	decide 	not 	to 	keep 	this
Policy, 	return 	it 	to 	us 	within 	thirty 	(30) 	days 	after 	it
is 	first 	delivered 	to 	you.
RENEWABLE 	TERM 	COVERAGE 	TO 	AGE 	95
POLICY 	IS 	CONVERTIBLE
NON-PARTICIPATING 	- 	DOES 	NOT 	PAY 	DIVIDENDS
ZZ1234567
PAT 	EXAMPLE 	30 	FEMALE
SELECT 	PREFERRED
MARCH 	15, 	2025 	MARCH 	15, 	2090
MARCH 	15, 	2043
$500,000 	$100,000
OWNER:
PAT 	EXAMPLE
SPRINGFIELD 	(555) 	555-0199
LIFE 	INSURANCE 	$500,000 	$250.00 	* 	20 	YEARS
$60.00
$250.00 	$130.00 	$67.50 	$21.25
$250.00 	$260.00 	$270.00 	$255.00
ICC22-TL21RS 	PAGE 	S1
POLICY 	S CH EDULE
ZZ1234567 	PAT 	EXAMPLE
1 	30 	$250.00 	$500,000 	21 	50 	$1,200.00 	$500,000
2 	31 	250.00 	500,000 	22 	51 	2,400.00 	500,000
ICC22-TL21RS 	PAGE 	S2
S CH EDULE 	OF 	GUARANTEED 	ANNUAL 	PREMIUMS 	AND 	F ACE 	AMOU NTS
R epresentations 	and 	Contestability: 	we 	cannot 	contest 	the 	validity 	of 	this 	Policy 	or 	resist 	any 	claim 	after 	the 	Policy 	has 	be en 	in 	force 	for 	two 	years 	during 	the 	life 	of 	the 	Insured.
S uicide 	E xclusions: 	If, 	while 	sane 	or 	insane, 	the 	Insured 	commits 	suicide 	within 	two 	years 	of 	the 	Policy 	being 	in 	force.
Grace 	Period: 	A 	31-day 	Grace 	P eriod 	follows 	each 	premium 	due 	date.
CONVERS IO N 	On 	or 	before 	the 	Standard 	Latest 	Conversion 	Date 	shown 	on 	the 	Policy 	Schedule, 	you 	may 	convert.
TE RMINAL 	ILLNESS 	ACCELE RATED 	DEATH 	BENEFIT 	ENDORSEMENT
is 	equal 	to: 	(a) 	The 	lesser 	of 	60% 	of 	the 	current 	face 	amount 	of 	the 	Policy 	or 	$1,000,000; 	minus
PAT 	EXAMPLE 	SAM 	Q 	SAMPLE 	1 	MAIN 	ST 	2 	ELM 	ST
ZZ1234567 	MARCH 	1, 	2025 	1 	$250.00 	$500,000`;

const PROTECTIVE_SUMMARY = `March 20, 2025
Protective Life Insurance Company
PAT EXAMPLE RE:
Policy Number: ZZ1234567
This information provided is as of 03/20/2025.
Policy Summary
Issue Date: 	03/15/2025 	Expiry Date: 	03/15/2090
Conversion Expiry Date: 03/15/2043	Paid to Date of Policy: 	03/15/2026
Current Premium
Amount:
$250.00 	Mode of Payment: 	Annually`;

const PROTECTIVE_RECEIPT = `From: payments@protective.com
Subject: Thank you for your recent payment.
Thank you for your recent payment. This is to confirm your authorization for an
electronic payment from your Debit / Credit Card that is payable to Protective
IDG/IAD NB on March 01, 2025 for the following policy:
Policy Number: ZZ1234567
Confirmation Number: 00TEST0001
Payment Amount: $250.00`;

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

describe("Protective Life documents", () => {
  it("tells its policy, summary and receipt apart", () => {
    expect(insuranceKind(PROTECTIVE_POLICY)).toBe("POLICY");
    expect(insuranceKind(PROTECTIVE_SUMMARY)).toBe("STATUS");
    expect(insuranceKind(PROTECTIVE_RECEIPT)).toBe("RECEIPT");
  });

  it("reads the policy schedule by position and the contract with its spaces squashed", () => {
    const p = parseInsuranceDoc(PROTECTIVE_POLICY);
    expect(p).toMatchObject({
      kind: "TERM_LIFE",
      insurer: "Protective Life Insurance Company",
      policyNumber: "ZZ1234567",
      insured: "Pat Example",
      owner: "Pat Example",
      state: "Springfield",
      issueDate: "2025-03-15",
      issueAge: 30,
      premiumClass: "Select Preferred",
      faceCents: 50_000_000,
      annualPremiumCents: 25_000,
      policyFeeCents: 6_000,
      levelYears: 20,
      levelEndDate: "2045-03-15",
      finalEndDate: "2090-03-15",
      conversionExpiryDate: "2043-03-15",
      conversionThroughExpiry: true,
      features: { renewable: true, convertible: true, reEntry: false, participating: false },
      modal: { semiannual: 0.52, quarterly: 0.27, monthly: 0.085 },
      schedule: [
        { year: 1, maxPremiumCents: 25_000, faceCents: 50_000_000 },
        { year: 2, maxPremiumCents: 25_000, faceCents: 50_000_000 },
        { year: 21, maxPremiumCents: 120_000, faceCents: 50_000_000 },
        { year: 22, maxPremiumCents: 240_000, faceCents: 50_000_000 },
      ],
      riders: [{ name: "Terminal Illness Accelerated Death Benefit Endorsement", terms: [{ label: "Most paid early", value: "60% of the face amount, up to $1,000,000" }] }],
      graceDays: 31,
      freeLookDays: 30,
      contestableYears: 2,
      suicideYears: 2,
      billing: { frequency: "Annually", type: null },
      agent: "Sam Q Sample",
      servicePhone: "(800) 555-0100",
      packetDate: "2025-03-01",
    });
  });

  it("refuses a policy without its schedule page rather than guessing", () => {
    expect(() => parseInsuranceDoc(PROTECTIVE_POLICY.replace("PAGE \tS1", ""))).toThrow(/Policy schedule not found/);
  });

  it("reads the policy summary and the payment receipt", () => {
    expect(parseInsuranceDoc(PROTECTIVE_SUMMARY)).toEqual({
      kind: "STATUS",
      insurer: "Protective Life Insurance Company",
      policyNumber: "ZZ1234567",
      asOf: "2025-03-20",
      paidToDate: "2026-03-15",
      premiumCents: 25_000,
      mode: "Annually",
    });
    expect(parseInsuranceDoc(PROTECTIVE_RECEIPT)).toEqual({
      kind: "RECEIPT",
      insurer: "Protective Life Insurance Company",
      policyNumber: "ZZ1234567",
      date: "2025-03-01",
      amountCents: 25_000,
      confirmation: "00TEST0001",
      method: "Debit / Credit Card",
    });
  });

  it("matches each insurer's charges to its own policy, with the receipt and paid-to date", () => {
    const agl = parsePolicy(PACKET);
    const protective = parseInsuranceDoc(PROTECTIVE_POLICY) as TermPolicy;
    const row = (id: string, date: string, cents: number, payee: string): PremiumRow => ({ id, date, amountCents: -cents, payee, accountId: "card" });
    const r = buildInsuranceReport({
      policies: [
        { file: "agl.pdf", policy: agl },
        { file: "protective.pdf", policy: protective },
      ],
      bills: [],
      receipts: [{ file: "receipt.pdf", receipt: parseInsuranceDoc(PROTECTIVE_RECEIPT) as PaymentReceipt }],
      statuses: [{ file: "summary.pdf", status: parseInsuranceDoc(PROTECTIVE_SUMMARY) as PolicyStatus }],
      rows: [
        row("a1", "2025-03-01", 81_200, "AGL*INSURANCE PREMIUM"),
        row("p1", "2025-03-02", 25_000, "PROTECTIVE LIFE NB BIRMINGHAM"),
        // The AGL premium's amount, paid to someone else: neither policy's.
        row("x1", "2025-03-03", 25_000, "SPRINGFIELD GROCERY"),
      ],
      today: "2025-04-01",
    });
    const [a, p] = r.policies;
    expect(a!.payments.map((x) => x.rowId)).toEqual(["a1"]);
    expect(p!.payments.map((x) => [x.rowId, x.year])).toEqual([["p1", 1]]);
    expect(p!.receipts).toEqual([{ file: "receipt.pdf", date: "2025-03-01", cents: 25_000, confirmation: "00TEST0001", method: "Debit / Credit Card", paidBy: "p1" }]);
    expect(p!.paidTo).toEqual({ date: "2026-03-15", asOf: "2025-03-20", file: "summary.pdf" });
    expect(a!.paidTo).toBeNull();
    // "On or before" the conversion date: the date itself still counts.
    expect(p!.dates.find((d) => d.key === "conversion")?.note).toMatch(/Up to and including this date/);
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
