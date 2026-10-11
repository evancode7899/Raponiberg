import { describe, expect, it } from "vitest";
import { taxYearParams } from "../params";
import { extractFidelityTax } from "./investments";
import { defaultAttribution, taxAuthority } from "./payments";
import { LAYOUT_HEADER } from "../../statements/pdfLayout";
import { stubChecks } from "../../ingest/payroll/checks";
import { classifyDeduction } from "../../ingest/payroll/classify";
import { employerKey } from "../../ingest/payroll/types";
import { extractAdpStubs } from "../../ingest/payroll/adp";
import { extractTrinetStub } from "../../ingest/payroll/trinet";
import { extractVensureStubs } from "../../ingest/payroll/vensure";
import { addDays } from "../../dates/isoDate";
import { projectPayroll, remainingPayDates, type PayStubTax } from "./payroll";

const FP = taxYearParams(2026).federal;

// Synthetic stub in Vensure's column-wise text layout (all names and amounts invented).
const VENSURE = [
  "TOTAL",
  "TOTAL",
  "Earnings - Current",
  "ACME HOLDINGS LP - 1 Main St - HARTFORD, CT 06103 -\tPat Example",
  "Description \tYTD",
  "REGULAR PAY",
  "GROUP TERM LIFE",
  "REIM EXPENSE",
  "BONUS SUPP",
  "90000.00",
  "40.00",
  "100.00",
  "20000.00",
  "40,000.00\t1,500.00",
  "Description \tBalance \tDescription \tAmount \tYTD",
  "Nonelective",
  "HSA MATCH",
  "200.00",
  "100.00",
  "3600.00",
  "1800.00",
  "300.00 \t5,400.00",
  "CHECKING 31234 2,848.00",
  "Voucher #: 000123 Sort Order: 1",
  "09-01-2026",
  "09-15-2026",
  "XXX-XX-0000 \t09-15-2026",
  "MJ/Married Filing Joint",
  "Pay Method: Salary, Exempt",
  "09-15-2026",
  "-",
  "-",
  "REGULAR PAY",
  "GROUP TERM LIFE",
  "REIM EXPENSE",
  "BONUS SUPP",
  "5000.00",
  "2.00",
  "-",
  "-",
  "HSA",
  "DENTAL",
  "VOL LIFE",
  "401KPRETAX",
  "FEDERAL TAX",
  "MEDICARE",
  "SOC SECURITY",
  "CT INCOME TAX",
  "CT PFML",
  "50.00",
  "10.00",
  "5.00",
  "500.00",
  "900.00",
  "72.00",
  "310.00",
  "280.00",
  "25.00",
  "900.00",
  "180.00",
  "90.00",
  "9000.00",
  "20000.00",
  "1600.00",
  "6800.00",
  "6000.00",
  "550.00",
  "Date \tPay Description \tPay Rate \tPay Amount",
  "-- 1 of 1 --",
].join("\n");

describe("Vensure stub extraction", () => {
  const [stub] = extractVensureStubs(VENSURE);

  it("reads header fields and classifies every line", () => {
    expect(stub).toBeDefined();
    expect(stub!.payDate).toBe("2026-09-15");
    expect(stub!.employee).toBe("Pat Example");
    expect(stub!.federalFilingStatus).toBe("Married Filing Joint");
    const kinds = Object.fromEntries(stub!.lines.map((l) => [l.name, l.kind]));
    expect(kinds).toMatchObject({
      "REIM EXPENSE": "NONTAXABLE",
      "GROUP TERM LIFE": "IMPUTED",
      HSA: "HSA",
      DENTAL: "SECTION125",
      "VOL LIFE": "AFTER_TAX",
      "401KPRETAX": "RETIREMENT_PRETAX",
      "CT INCOME TAX": "STATE_TAX",
      "CT PFML": "STATE_PAYROLL",
      "HSA MATCH": "EMPLOYER_HSA",
      Nonelective: "EMPLOYER_RETIREMENT",
    });
  });

  it("derives W-2 boxes the way payroll does", () => {
    const p = projectPayroll([stub!], FP);
    // Box 5 = gross 110,140 − reimbursement 100 − HSA 900 − dental 180.
    expect(p.w2Ytd.box5MedicareWages).toBe(10_896_000);
    // Box 1 = Box 5 − 401(k) 9,000.
    expect(p.w2Ytd.box1Wages).toBe(9_996_000);
    expect(p.w2Ytd.box12.C).toBe(4_000);
  });

  it("projects the remaining semi-monthly paychecks without exceeding the 401(k) limit", () => {
    const p = projectPayroll([stub!], FP);
    expect(p.remainingPayDates).toHaveLength(7);
    expect(p.projected.regular).toBe(9_000_000 + 7 * 500_000);
    expect(p.projected.retirementPretax).toBe(9_000 * 100 + 7 * 50_000);
    expect(p.projected.federalWithheld).toBe(2_000_000 + 7 * 90_000);
  });
});

describe("TriNet stub extraction", () => {
  const text = [
    "Example Partners LP",
    "Check Date: 04/30/2025",
    "Pay Period: 04/16/2025 - 04/30/2025",
    "Pat Example NON-NEGOTIABLE",
    "Current Hours and Earnings",
    "Description Earnings Range Rate Hours Units Earnings",
    "Regular 0.000 0.00 0.00 5,000.00",
    "YTD Hours and Earnings",
    "Description Hours Units Earnings",
    "Regular 600.00 0.00 40,000.00",
    "Gross Pay 600.00 0.00 40,000.00",
    "Taxes and Deductions",
    "Taxes Current Year-to-Date",
    "Fed Withholding 800.00 6,400.00",
    "Fed MED/EE 70.00 580.00",
    "Fed OASDI/EE 300.00 2,480.00",
    "NY OASDI/EE 0.60 4.80",
    "Total Taxes 1,170.60 9,464.80",
    "Before-Tax",
    "Deductions Current Plan Year Year-to-Date",
    "Dental 10.00 0.00 80.00",
    "401k/Roth",
    "Combination 500.00 0.00 4,000.00",
    "Total Before Tax",
    "Deductions 510.00 0.00 4,080.00",
    "Total Deductions 510.00 4,080.00",
    "Net Pay 3,319.40 26,455.20",
    "Company-Paid Benefits",
    "Taxable Benefits Current Year-to-Date",
    "Basic Life 2.00 16.00",
    "Total Taxable 2.00 16.00",
  ].join("\n");

  it("joins wrapped names and skips headers and subtotals", () => {
    const s = extractTrinetStub(text)!;
    const byName = Object.fromEntries(s.lines.map((l) => [l.name, l]));
    expect(byName["Regular"]?.ytd).toBe(4_000_000);
    expect(byName["401k/Roth Combination"]?.kind).toBe("RETIREMENT_PRETAX");
    expect(byName["NY OASDI/EE"]?.kind).toBe("STATE_PAYROLL");
    expect(byName["Imputed: Basic Life"]?.kind).toBe("IMPUTED");
    expect(s.lines.some((l) => /Total/.test(l.name))).toBe(false);
    const p = projectPayroll([s], taxYearParams(2025).federal);
    expect(p.w2Ytd.box1Wages).toBe(4_000_000 + 1_600 - 8_000 - 400_000);
  });

  it("reads older stubs' misspelled withholding lines as taxes", () => {
    expect(classifyDeduction("Fed Withholdng")).toBe("FEDERAL_TAX");
    expect(classifyDeduction("NY Withholdng")).toBe("OTHER_STATE_TAX");
    expect(classifyDeduction("NY NEW YORK Withholdng")).toBe("LOCAL_TAX");
  });
});

describe("ADP stub extraction", () => {
  // Synthetic stub in ADP's positioned layout (names and amounts invented): amounts are
  // right-aligned under "this period" (x≈256) / "year to date" (x≈336), and the benefits
  // panel's under its own headers (x≈505 / x≈586).
  const layout = [
    "@1:771\t101-112 CO.\t128-142 FILE\t161-179 DEPT.",
    "@1:764\t101-117 ABC\t127-213 123456 000000 Z01XX",
    "@1:736\t100-197 EXAMPLE CORP\t209-225 INC.\t354-428 Period Beginning:\t455-500 09/01/2026",
    "@1:724\t354-416 Period Ending:\t455-500 09/14/2026",
    "@1:712\t354-396 Pay Date:\t455-500 09/18/2026",
    "@1:661\t100-214 Filing Status: Married filing jointly",
    "@1:600\t131-144 rate\t155-197 salary/hours\t212-253 this period\t282-331 year to date",
    "@1:587\t21-53 Regular\t110-145 2000 00\t165-190 80 00\t211-256 2 000 00\t286-336 40 000 00\t364-560 Your federal taxable wages this period are",
    "@1:575\t21-47 Bonus\t291-336 5 000 00\t364-409 $1 700 00",
    "@1:563\t21-84 AnnivTaxReimb\t311-336 20 00",
    "@1:551\t21-87 Wireless Reimb\t306-336 300 00",
    "@1:539\t95-142 Gross Pay\t211-256 $2 000 00\t286-336 45 320 00",
    "@1:532\t354-441 Other Benefits and",
    "@1:522\t464-504 this period\t534-582 total to date",
    "@1:509\t95-135 Statutory\t354-425 Group Term Life\t485-505 1 00\t561-586 20 00",
    "@1:497\t95-180 Federal Income Tax\t221-256 -150 00\t291-336 3 000 00\t354-405 401K Match\t480-505 100 00\t546-586 2 000 00",
    "@1:485\t95-178 Social Security Tax\t221-256 -116 00\t291-336 2 600 00",
    "@1:479\t354-424 Totl Hrs Worked\t480-505 80 00",
    "@1:473\t95-152 Medicare Tax\t226-256 -27 13\t306-336 608 00",
    "@1:461\t95-188 CT State Income Tax\t226-256 -90 00\t291-336 1 800 00",
    "@1:449\t95-209 CT Paid Family Leave Ins\t226-256 -9 50\t306-336 210 00",
    "@1:407\t95-134 Critical Ill\t231-256 -5 00",
    "@1:347\t95-167 Medical Premium\t221-260 -100 00*\t291-336 2 000 00",
    "@1:335\t95-116 401K\t221-260 -200 00*\t291-336 4 000 00",
    "@1:317\t95-131 Net Pay\t211-256 $1 302 37",
    "@1:305\t95-121 Check\t211-256 -1 302 37\t286-336 31 002 00",
    "@1:245\t542-568 2000 ADP, Inc.",
    "@1:141\t99-217 Deposited to the account of\t353-420 account number\t553-581 amount",
    "@1:130\t100-160 PAT EXAMPLE\t350-393 xxxxx5555\t541-587 $1 302 37",
  ];
  const text = ["Earnings Statement", "garbled plain text", LAYOUT_HEADER, ...layout].join("\n");

  it("assigns every amount to its row and column", () => {
    const [s] = extractAdpStubs(text);
    expect(s).toMatchObject({ employer: "Example Corp Inc", employee: "PAT EXAMPLE", payDate: "2026-09-18", periodStart: "2026-09-01", deposits: [{ last4: "5555", amount: 130_237 }], warnings: [] });
    const byName = Object.fromEntries(s!.lines.map((l) => [l.name, l]));
    expect(byName["Regular"]).toMatchObject({ kind: "REGULAR", current: 200_000, ytd: 4_000_000 });
    expect(byName["Bonus"]).toMatchObject({ kind: "BONUS", current: 0, ytd: 500_000 });
    expect(byName["AnnivTaxReimb"]?.kind).toBe("OTHER_EARNING");
    expect(byName["Wireless Reimb"]?.kind).toBe("NONTAXABLE");
    expect(byName["Federal Income Tax"]).toMatchObject({ kind: "FEDERAL_TAX", current: 15_000, ytd: 300_000 });
    expect(byName["CT Paid Family Leave Ins"]?.kind).toBe("STATE_PAYROLL");
    expect(byName["Medical Premium"]).toMatchObject({ kind: "SECTION125", current: 10_000 });
    expect(byName["401K"]).toMatchObject({ kind: "RETIREMENT_PRETAX", current: 20_000, ytd: 400_000 });
    expect(byName["Critical Ill"]).toMatchObject({ kind: "AFTER_TAX", current: 500, ytd: null });
    expect(byName["401K Match"]).toMatchObject({ kind: "EMPLOYER_RETIREMENT", current: 10_000, ytd: 200_000 });
    expect(byName["Imputed: Group Term Life"]?.kind).toBe("IMPUTED");
    // Hours and the deposit advice are not money lines.
    expect(s!.lines.some((l) => /Hrs|xxxx/.test(l.name))).toBe(false);
  });

  it("carries deductions ADP printed without a YTD so year-to-date net ties", () => {
    const [s] = extractAdpStubs(text);
    // 45,320 gross − 14,218 printed YTD deductions − 31,002 net = 100 unprinted.
    expect(s!.lines.find((l) => l.name.startsWith("Deductions ADP leaves without a printed YTD"))?.ytd).toBe(10_000);
    expect(s!.printed).toEqual({ grossCurrent: 200_000, grossYtd: 4_532_000, withheldCurrent: null, withheldYtd: null, netCurrent: 130_237, netYtd: 3_100_200 });
  });

  it("reads the payroll company code, which keeps each payroll record's year-to-date chain separate", () => {
    expect(extractAdpStubs(text)[0]!.payrollCode).toBe("ABC");
    expect(employerKey("Example Corp Inc", "ABC")).toBe("EXAMPLE #ABC");
    expect(employerKey("Example Corp Inc", "XYZ")).not.toBe(employerKey("Example Corp Inc", "ABC"));
    expect(employerKey("Example Corp Inc")).toBe("EXAMPLE");
  });

  it("fails its self-check when the line items don't add up to the printed totals", () => {
    const broken = text.replace("221-256 -150 00", "221-256 -151 00");
    const failed = stubChecks(extractAdpStubs(broken)[0]!).filter((c) => !c.ok);
    expect(failed.map((c) => c.label)).toContain("Gross − withheld = net pay (this period)");
    expect(stubChecks(extractAdpStubs(text)[0]!).filter((c) => !c.ok)).toEqual([]);
  });
});

describe("Fidelity tax extraction", () => {
  const text = [
    "INVESTMENT REPORT",
    "August 1, 2026 - August 31, 2026",
    "Account # Z00-000001",
    "PAT EXAMPLE - INDIVIDUAL - TOD\tAccount Summary",
    "Beginning Account Value $1,000.00 $900.00",
    "Ending Account Value $1,100.00 $1,100.00",
    "Income Summary",
    "This Period Year-to-Date",
    "Taxable $12.00 $300.00",
    "Dividends 12.00 300.00",
    "Total $12.00 $300.00",
    "Realized Gains and Losses from Sales",
    "This Period Year-to-Date",
    "Net Short-term Gain/Loss - -50.00",
    "Net Long-term Gain/Loss - 25.00",
    "Dividends, Interest & Other Income",
    "08/15 EXAMPLE INDEX FUNDS S&P 500 ETF",
    "USD",
    "123456789 Dividend Received - - $10.00",
    "08/31 FIDELITY GOVERNMENT MONEY",
    "MARKET",
    "31617H102 Dividend Received - - 2.00",
    "Total Dividends, Interest & Other Income $12.00",
    "-- 1 of 2 --",
    "Account # 200-000002",
    "PAT EXAMPLE - TRADITIONAL IRA\tActivity",
    "Ending Account Value - -",
    "Contributions and Distributions",
    "2026 Contributions $7,500.00 $7,500.00",
    "Distributions",
    "Date Reference Description Amount",
    "08/22 Conv. Or Roll To Roth 300-000003-1 -$7,500.00",
    "Total Distributions -$7,500.00",
  ].join("\n");
  const [brokerage, ira] = extractFidelityTax(text);

  it("reads year-to-date income, realized gains and dividend rows", () => {
    expect(brokerage!.kind).toBe("TAXABLE");
    expect(brokerage!.income?.dividends).toBe(30_000);
    expect(brokerage!.realized).toEqual({ shortTerm: -5_000, longTerm: 2_500 });
    expect(brokerage!.incomeRows.map((r) => [r.date, r.amount, r.moneyMarket])).toEqual([
      ["2026-08-15", 1_000, false],
      ["2026-08-31", 200, true],
    ]);
  });

  it("classifies IRA distributions and reads contributions", () => {
    expect(ira!.kind).toBe("TRADITIONAL_IRA");
    expect(ira!.contributionsYtd).toBe(750_000);
    expect(ira!.distributions).toEqual([{ date: "2026-08-22", description: "Conv. Or Roll To Roth 300-000003-1", amount: 750_000, kind: "ROTH_CONVERSION" }]);
  });
});

describe("tax payments", () => {
  it("recognizes authorities from bank payees", () => {
    expect(taxAuthority("Irs Usataxpymt PPD ID: 1")).toBe("FEDERAL");
    expect(taxAuthority("State of CT Drs Dirpay CCD ID: 1")).toBe("CT");
    expect(taxAuthority("NY State Nysttaxrfd PPD ID: 1")).toBe("OTHER_STATE");
    expect(taxAuthority("FIRST CITYTAXI CORP")).toBeNull();
  });

  it("attributes by date", () => {
    expect(defaultAttribution("2027-01-12", 500_000)).toEqual({ kind: "ESTIMATE", taxYear: 2026 });
    expect(defaultAttribution("2027-04-10", 500_000)).toEqual({ kind: "BALANCE_DUE", taxYear: 2026 });
    expect(defaultAttribution("2026-06-15", 500_000)).toEqual({ kind: "ESTIMATE", taxYear: 2026 });
    expect(defaultAttribution("2026-03-01", -100_000)).toEqual({ kind: "REFUND", taxYear: 2025 });
  });

  it("lists remaining semi-monthly and biweekly pay dates", () => {
    expect(remainingPayDates("2026-11-30", "SEMIMONTHLY")).toEqual(["2026-12-15", "2026-12-31"]);
    expect(remainingPayDates("2026-12-04", "BIWEEKLY")).toEqual(["2026-12-18"]);
  });
});

describe("paycheck basis for the rest of the year", () => {
  // Biweekly stubs: four regular $3,500 paychecks, then a short $1,000 one.
  let ytdGross = 0;
  let ytdFed = 0;
  const stub = (payDate: string, gross: number, fed: number): PayStubTax => {
    ytdGross += gross;
    ytdFed += fed;
    return {
      source: "ADP",
      employee: "Pat Example",
      employer: "Acme",
      payDate,
      periodStart: addDays(payDate, -13),
      periodEnd: payDate,
      federalFilingStatus: null,
      lines: [
        { name: "Regular", kind: "REGULAR", current: gross, ytd: ytdGross },
        { name: "Federal", kind: "FEDERAL_TAX", current: fed, ytd: ytdFed },
      ],
      printed: {} as PayStubTax["printed"],
      deposits: [],
      warnings: [],
    };
  };
  const stubs = [
    stub("2026-08-07", 350_000, 30_000),
    stub("2026-08-21", 350_000, 30_000),
    stub("2026-09-04", 360_000, 31_000),
    stub("2026-09-18", 350_000, 30_000),
    stub("2026-10-02", 100_000, 0),
  ];

  it("repeats the latest paycheck by default and the median one when asked", () => {
    const latest = projectPayroll(stubs, FP);
    const typical = projectPayroll(stubs, FP, { basis: "TYPICAL" });
    expect(latest.remainingPayDates).toHaveLength(6);
    expect(latest.latestRegular?.amounts.gross).toBe(100_000);
    expect(latest.typicalRegular?.amounts.gross).toBe(350_000);
    expect(latest.projected.gross).toBe(ytdGross + 6 * 100_000);
    expect(typical.projected.gross).toBe(ytdGross + 6 * 350_000);
    expect(typical.projected.federalWithheld).toBe(ytdFed + 6 * 30_000);
  });

  it("stops paying after the last pay date", () => {
    const p = projectPayroll(stubs, FP, { basis: "TYPICAL", payThrough: "2026-11-01" });
    expect(p.remainingPayDates).toEqual(["2026-10-16", "2026-10-30"]);
    expect(p.projected.gross).toBe(ytdGross + 2 * 350_000);
  });
});
