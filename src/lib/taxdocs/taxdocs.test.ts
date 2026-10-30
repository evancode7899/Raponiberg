import { describe, expect, it } from "vitest";
import type { LayoutRow } from "../statements/pdfLayout";
import { parseBrokerage1099, parseK1 } from "./forms";
import { readReturnLines } from "./lines";
import { unshift } from "./pdf";
import { federalSummary, parseReturns, stateSummary } from "./returns";
import { classify, docYear } from "./scan";
import { parseW2 } from "./w2";

// Every name and figure here is made up.
const row = (page: number, y: number, ...cells: [number, number, string][]): LayoutRow => ({ page, y, cells: cells.map(([x0, x1, text]) => ({ x0, x1, text })) });

describe("filed return lines", () => {
  it("reads a federal 1040: line number, then its amount on the same row", () => {
    const rows = [
      row(1, 760, [36, 300, "Form 1040 U.S. Individual Income Tax Return"]),
      row(1, 567, [99, 286, "X Married filing jointly (even if only one had income)"]),
      row(1, 332, [96, 105, "1a"], [115, 315, "Total amount from Form(s) W-2, box 1"], [489, 498, "1a"], [519, 577, "200,000."]),
      row(1, 200, [96, 105, "3a"], [115, 194, "Qualified dividends"], [237, 246, "3a"], [282, 325, "1,500."], [338, 422, "b Ordinary dividends"], [489, 498, "3b"], [534, 577, "2,000."]),
      row(1, 33, [92, 105, "11a"], [115, 346, "Adjusted gross income"], [486, 500, "11a"], [519, 577, "202,000."]),
      row(2, 760, [36, 200, "Form 1040 (2025) Page 2"]),
      row(2, 531, [92, 101, "24"], [115, 265, "This is your total tax"], [489, 498, "24"], [519, 577, "40,000."]),
      row(2, 231, [36, 71, "You Owe"], [489, 498, "37"], [534, 577, "1,234."]),
      row(3, 749, [36, 99, "SCHEDULE 2"]),
      row(3, 177, [40, 50, "11"], [65, 240, "Additional Medicare Tax"], [488, 498, "11"], [534, 577, "99."]),
    ];
    const lines = readReturnLines(rows, "?", "FED");
    expect(lines.find((l) => l.line === "3a")!.values).toEqual([1500]);
    expect(lines.find((l) => l.line === "3b")!.values).toEqual([2000]);
    const s = federalSummary(lines);
    expect(s).toMatchObject({ wages: 20_000_000, qualifiedDividends: 150_000, ordinaryDividends: 200_000, agi: 20_200_000, totalTax: 4_000_000, amountOwed: 123_400, additionalMedicareTax: 9_900 });
    const [ret] = parseReturns(rows, "Printed on 04/05/2026");
    expect(ret).toMatchObject({ jurisdiction: "FEDERAL", form: "1040", filingStatus: "MFJ", printedOn: "2026-04-05" });
  });

  it("reads the filing status from the spouse line when the box is a graphic", () => {
    const head = [
      row(1, 738, [42, 290, "Form 1040 U.S. Individual Income Tax Return"]),
      row(1, 718, [36, 80, "Filing Status"], [108, 130, "Single"], [151, 230, "Married filing jointly"]),
      row(1, 676, [40, 200, "Your first name and middle initial"], [242, 280, "Last name"]),
      row(1, 662, [42, 80, "ALEX Q"], [242, 290, "SAMPLE"]),
      row(1, 652, [40, 230, "If joint return, spouse’s first name and middle initial"], [242, 280, "Last name"]),
    ];
    const tail = [
      row(1, 332, [96, 105, "1a"], [115, 315, "Total amount from Form(s) W-2, box 1"], [489, 498, "1a"], [519, 577, "90,000."]),
    ];
    const single = parseReturns([...head, row(1, 628, [40, 300, "Home address (number and street). If you have a P.O. box, see instructions."]), ...tail], "");
    expect(single[0]!.filingStatus).toBe("SINGLE");
    const joint = parseReturns([...head, row(1, 638, [42, 80, "JORDAN R"], [242, 290, "SAMPLE"]), row(1, 628, [40, 300, "Home address (number and street)."]), ...tail], "");
    expect(joint[0]!.filingStatus).toBe("MFJ");
  });

  it("takes an amount printed just off its line's baseline (Intuit) for the nearest empty line", () => {
    const rows = [
      row(1, 760, [36, 300, "Form 1040 (2023)"]),
      row(1, 261, [96, 105, "2a"], [237, 246, "2a"], [309, 321, "0."], [338, 405, "b Taxable interest"], [489, 498, "2b"]),
      row(1, 251, [36, 80, "if required."], [309, 321, "12."], [525, 560, "3,210."]),
      row(1, 248, [96, 105, "3a"], [237, 246, "3a"], [338, 422, "b Ordinary dividends"], [489, 498, "3b"]),
    ];
    const lines = readReturnLines(rows, "?", "FED");
    expect(lines.find((l) => l.line === "3b")!.values).toEqual([3210]);
    expect(lines.find((l) => l.line === "3a")!.values).toEqual([12]);
    expect(lines.find((l) => l.line === "2b")).toBeUndefined();
  });

  it("reads Connecticut's part-year return, line numbers ending in a period", () => {
    const rows = [
      row(1, 710, [317, 496, "Form CT-1040NR/PY - 2025"]),
      row(1, 447, [72, 461, "1. Federal adjusted gross income (from federal Form 1040, Line 11a) 1."], [505, 548, "100000"]),
      row(1, 399, [72, 332, "5. Connecticut adjusted gross income: Line 4 subtracted from Line 3."], [454, 461, "5."], [505, 548, "100000"]),
      row(1, 387, [72, 317, "6. Income from Connecticut sources (from Schedule CT-SI, Line 30)"], [454, 461, "6."], [505, 548, "25000"]),
      row(1, 363, [72, 124, "8. Income tax"], [454, 461, "8."], [512, 548, "5000"]),
      row(1, 351, [72, 388, "9. Line 6 divided by Line 5."], [454, 461, "9."], [505, 548, "0.2500"]),
      row(1, 279, [72, 325, "18. Total tax: Add Line 16 and Line 17."], [450, 461, "18."], [519, 548, "1250"]),
      row(1, 327, [73, 348, "28. Tax due: If Line 19 is more than Line 23"], [450, 461, "28."], [519, 548, "50"]),
      row(1, 267, [73, 247, "32. Total amount due: Add Lines 28 through 31."], [450, 461, "32."], [519, 569, "50 .00"]),
    ];
    const lines = readReturnLines(rows, "?", "CT");
    expect(lines.find((l) => l.line === "5")!.label).toMatch(/Connecticut adjusted gross income/);
    expect(stateSummary(lines, "CT")).toMatchObject({ federalAgi: 10_000_000, stateAgi: 10_000_000, sourceIncome: 2_500_000, incomePercentage: 2500, taxBeforeAllocation: 500_000, totalTax: 125_000, amountOwed: 5_000 });
  });

  it("joins New York's federal and New York columns into one line", () => {
    const rows = [
      row(1, 749, [36, 83, "Page 2 of 4"], [92, 146, "IT-203 (2025)"]),
      row(1, 206, [41, 279, "31 New York adjusted gross income (subtract line 30 from line 23 )"], [288, 298, "31"], [369, 424, "100000 . 00"]),
      row(1, 204, [438, 448, "31"], [518, 574, "60000 . 00"]),
      row(1, 150, [41, 284, "62 Total New York State tax withheld ......"], [294, 304, "62"], [382, 430, "4000 . 00"]),
      row(1, 140, [41, 429, "68 Amount of line 67 available for refund ......"], [438, 448, "68"], [525, 574, "300 . 00"]),
      row(1, 130, [41, 279, "4 Taxable refunds"], [293, 298, "4 00"]),
    ];
    const lines = readReturnLines(rows, "?", "NY");
    expect(lines.find((l) => l.line === "31")!.values).toEqual([100000, 60000]);
    expect(lines.find((l) => l.line === "4")).toBeUndefined();
    expect(stateSummary(lines, "NY")).toMatchObject({ stateAgi: 10_000_000, sourceIncome: 6_000_000, withheld: 400_000, refund: 30_000 });
  });

  it("decodes text from a font shifted by 29", () => {
    expect(unshift("123456 . \u0013\u0013")).toBe("123456 . 00");
    expect(unshift("1 \u0003 :DJHV")).toBe("1   Wages");
    expect(unshift("plain text")).toBe("plain text");
  });
});

describe("W-2", () => {
  it("reads every box by position, from labels above or below their amounts", () => {
    const rows = [
      row(1, 749, [100, 164, "1 Wages, tips, other comp."], [200, 271, "2 Federal income tax withheld"]),
      row(1, 740, [161, 194, "90000.00"], [261, 294, "15000.00"]),
      row(1, 730, [99, 154, "3 Social security wages"], [201, 270, "4 Social security tax withheld"]),
      row(1, 722, [19, 87, "b Employer ID number (EIN)"], [157, 194, "100000.00"], [266, 294, "6200.00"]),
      row(1, 713, [100, 162, "5 Medicare wages and tips"], [201, 257, "6 Medicare tax withheld"]),
      row(1, 708, [23, 65, "00-0000000"]),
      row(1, 704, [157, 194, "100000.00"], [265, 293, "1450.00"]),
      row(1, 694, [21, 120, "c Employer's name, address, and ZIP code"]),
      row(1, 681, [21, 131, "EXAMPLE PAYROLL LLC"]),
      row(1, 622, [19, 122, "e Employee's name, address, and ZIP code"]),
      row(1, 611, [23, 79, "PAT EXAMPLE"]),
      row(1, 550, [19, 84, "1 0 Dependent care benefits"], [112, 163, "11 Nonqualified plans"], [205, 277, "1 2a Code See inst. for box 12"]),
      row(1, 540, [209, 215, "D"], [239, 263, "10000.00"]),
      row(1, 532, [206, 229, "1 2b Code"]),
      row(1, 523, [210, 216, "W"], [240, 268, "3000.00"]),
      // The state line prints over its labels on this layout.
      row(1, 473, [22, 31, "CT"], [43, 87, "12345-000"], [182, 210, "90000.00"], [273, 297, "4000.00"]),
      row(1, 456, [19, 106, "15 State Employer's state ID number"], [127, 187, "1 6 State wages, tips, etc."], [213, 262, "17 State income tax"]),
      row(1, 450, [19, 79, "18 Local wages, tips, etc."], [112, 159, "1 9 Local income tax"], [207, 247, "2 0 Locality name"]),
    ];
    const { w2, warnings } = parseW2(rows);
    expect(warnings).toEqual([]);
    expect(w2).toMatchObject({
      employer: "EXAMPLE PAYROLL LLC",
      employee: "PAT EXAMPLE",
      wages: 9_000_000,
      federalWithheld: 1_500_000,
      ssWages: 10_000_000,
      ssWithheld: 620_000,
      medicareWages: 10_000_000,
      medicareWithheld: 145_000,
      dependentCare: 0,
      box12: [
        { code: "D", amount: 1_000_000 },
        { code: "W", amount: 300_000 },
      ],
      states: [{ state: "CT", wages: 9_000_000, withheld: 400_000 }],
      locals: [],
    });
  });
});

describe("1099s and K-1s", () => {
  it("reads a consolidated brokerage 1099", () => {
    const text = [
      "Form 1099-DIV * 2025 Dividends and Distributions",
      "1a Total Ordinary Dividends ........................1,000.00",
      "1b Qualified Dividends ...........................800.00",
      "5 Section 199A Dividends ..........................50.00",
      "2025 TAX REPORTING STATEMENT",
      "Account No.\tPAT EXAMPLE",
      "Z00-001234",
      "1 Interest Income ...........................12.34",
      "Long-term transactions for which basis is reported to the IRS 5,000.00 4,000.00 0.00 0.00 1,000.00 0.00",
    ].join("\n");
    const { f1099 } = parseBrokerage1099(text);
    expect(f1099).toMatchObject({ recipient: "PAT EXAMPLE", account: "1234", div: { ordinary: 100_000, qualified: 80_000, section199a: 5_000 }, int: { interest: 1_234 }, b: { longTermGain: 100_000, longTermProceeds: 500_000 } });
  });

  it("reads a K-1's boxes, not its box numbers", () => {
    const rows = [
      row(1, 713, [318, 322, "1"], [334, 431, "Ordinary business income (loss)"], [453, 461, "14"], [471, 571, "Self-employment earnings (loss)"]),
      row(1, 698, [431, 442, "(7)"]),
      row(1, 568, [318, 322, "5"], [334, 383, "Interest income"]),
      row(1, 555, [432, 442, "21"], [566, 571, "5"]),
      row(1, 544, [316, 324, "6a"], [334, 393, "Ordinary dividends"]),
      row(1, 531, [432, 442, "36"]),
      row(1, 448, [318, 322, "8"], [334, 436, "Net short-term capital gain (loss)"]),
      row(1, 438, [453, 461, "19"], [471, 510, "Distributions"]),
      row(1, 424, [316, 324, "9a"], [334, 434, "Net long-term capital gain (loss)"]),
      row(1, 411, [426, 442, "(9)"]),
      row(1, 448 - 200, [181, 283, "X Limited partner or other LLC"]),
    ];
    const { k1 } = parseK1(rows, "Schedule K-1 (Form 1065) X Limited partner");
    expect(k1).toMatchObject({ limitedPartner: true, ordinaryBusiness: -700, interest: 2_100, ordinaryDividends: 3_600, shortTermGain: 0, longTermGain: -900 });
  });
});

describe("folder", () => {
  it("sorts documents by kind and year", () => {
    expect(classify("Form W-2 Wage and Tax Statement 2025", "2025/w2.pdf")).toBe("W2");
    expect(classify("U.S. Individual Income Tax Return ... adjusted gross income", "2025/return.pdf")).toBe("RETURN");
    expect(classify("anything", "2024/2024_FEDERALWORKSHEETS.pdf")).toBe("OTHER");
    expect(classify("Statement of remuneration paid", "2020/t4.pdf")).toBe("FOREIGN");
    expect(docYear("2024/1. Pat Documents/W2.pdf")).toBe(2024);
    expect(docYear("2023-Individual-Consolidated-Form-1099.pdf")).toBe(2023);
  });
});
