import { describe, expect, it } from "vitest";
import { amountsFromLines, stubChecks } from "../payroll/index.ts";
import { parseStatementText } from "./index.ts";

// Synthetic stubs in TriNet's real text layouts (figures and names are made up).

function stub(text: string) {
  const o = parseStatementText(text);
  if (!o.ok) throw new Error(JSON.stringify(o));
  expect(o.doc.parserId).toBe("trinet-paystub");
  return o.doc.payStubs![0]!;
}

const COMMON = `Check Date: 03/15/2023
Pay Period: 03/01/2023 - 03/15/2023
Pat Example NON-NEGOTIABLE
Current Hours and Earnings
Description Rate Hours Units Earnings
Regular 10,000.00
Gross Pay 10,000.00
YTD Hours and Earnings
Description Hours Units Earnings
Regular 80.00 20,000.00
Gross Pay 20,000.00
Taxes and Deductions
Taxes Current Year-to-Date
Fed Withholding 3,000.00 6,000.00
Total Taxes 3,000.00 6,000.00`;

describe("TriNet pay stub", () => {
  it("reads the 2022–2024 layout: heading on the employer line, wrapped section headings, 401(k) amount a line below", () => {
    const s = stub(`EARNINGS STATEMENT Example Partners LP
DBA: Example Partners
${COMMON}
Before-Tax
Deductions
Current Plan Year Year-to-Date
401k/Roth
Combination
500.00 0.00 1,000.00
Total Before Tax
Deductions
500.00 0.00 1,000.00
Total Deductions 500.00 1,000.00
Net Pay 6,500.00 13,000.00
Non-Taxable Benefits Current Year-to-Date
401k/Roth Combination 250.00 500.00
Total Non-Taxable 250.00 500.00
Direct Deposit
Account Type Account No. Deposit Amount
Checking 1234 6,500.00
USD $6,500.00`);
    expect(s.employer).toBe("Example Partners LP");
    const cur = amountsFromLines(s.lines, "current");
    expect(cur.retirementPretax).toBe(50_000);
    expect(cur.employerRetirement).toBe(25_000);
    expect(s.printed).toMatchObject({ grossCurrent: 1_000_000, grossYtd: 2_000_000, withheldCurrent: 350_000, withheldYtd: 700_000, netCurrent: 650_000, netYtd: 1_300_000 });
    expect(s.deposits).toEqual([{ last4: "1234", amount: 650_000 }]);
    expect(stubChecks(s).filter((c) => !c.ok)).toEqual([]);
  });

  it("reads the 2025 layout: 401(k) amount beside Combination", () => {
    const s = stub(`Example Partners LP
DBA : Example Partners
${COMMON}
Before-Tax
Deductions Current Plan Year Year-to-Date
401k/Roth
Combination 468.75 0.00 1,000.00
Total Before Tax
Deductions 468.75 0.00 1,000.00
Total
Deductions 468.75 1,000.00
Net Pay 6,531.25 13,000.00
USD $6,531.25`);
    expect(s.employer).toBe("Example Partners LP");
    expect(amountsFromLines(s.lines, "current").retirementPretax).toBe(46_875);
    expect(stubChecks(s).filter((c) => !c.ok)).toEqual([]);
  });

  it("stitches an after-tax list continued on the next page", () => {
    const s = stub(`Example Partners LP
${COMMON}
After-Tax
Deductions Current Year-to-Date
Accident
Insurance 4.00 8.00
Tax Withholding
Description Federal NY State
Marital Status Married Married
Direct Deposit
Checking 1234 6,991.00
-- 1 of 2 --
Hospital
Indemnity 5.00 10.00
Total After Tax
Deductions 9.00 18.00
Total
Deductions 9.00 18.00
Net Pay 6,991.00 13,982.00
USD $6,991.00`);
    expect(s.lines.filter((l) => l.kind === "AFTER_TAX").map((l) => l.name)).toEqual(["Accident Insurance", "Hospital Indemnity"]);
    expect(stubChecks(s).filter((c) => !c.ok)).toEqual([]);
  });

  it("leaves the deferral at zero before 401(k) enrollment", () => {
    const s = stub(`EARNINGS STATEMENT Example Partners LP
${COMMON}
Net Pay 7,000.00 14,000.00
USD $7,000.00`);
    expect(amountsFromLines(s.lines, "current").retirementPretax).toBe(0);
    expect(stubChecks(s).filter((c) => !c.ok)).toEqual([]);
  });
});
