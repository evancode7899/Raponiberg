import { describe, expect, it } from "vitest";
import { parseStatementText } from "./index.ts";

// A synthetic Empower quarterly statement (figures and names are made up).

const TEXT = (funding: string, activity = "Contribution Dec 29, 2023 Dec 29, 2023 9.17") => `PAT EXAMPLE Statement Period: 10/01/2023 - 12/31/2023
Participant ID: 1234567 Plan: 111111-01
Mail: Empower
How has my account changed?
Employee Employer Total
Balance as of September 30, 2023 $1,000.00 $500.00 $1,500.00
Payroll Contributions 300.00 259.17 559.17
Change in Value 10.00 5.00 15.00
Balance as of December 31, 2023 $1,310.00 $764.17 $2,074.17
EXAMPLE 401(K) PLAN CO LP
How is my account being funded?
${funding}
What activity took place this period?
Deposits/Contributions
Contribution Nov 30, 2023 Dec 05, 2023 550.00
${activity}
`;

const funded = `Deferred Salary 1,000.00 300.00 10.00 0.00 1,310.00 100% 1,310.00
Qualified Non-Elective 0.00 9.17 9.17 100% 9.17
Safe Harbor Match 500.00 250.00 5.00 0.00 755.00 100% 755.00`;

function employerRows(text: string) {
  const o = parseStatementText(text);
  if (!o.ok) throw new Error(JSON.stringify(o));
  return o.doc.sections[0]!.transactions.filter((t) => t.section === "Employer contributions").map((t) => [t.description, t.amountCents]);
}

describe("Empower QNEC", () => {
  it("splits a qualified non-elective deposit out of the payroll employer money", () => {
    expect(employerRows(TEXT(funded))).toEqual([
      ["Qualified Non-Elective contribution (employer)", 917],
      ["Payroll Contributions (employer)", 25_000],
    ]);
  });

  it("ignores a QNEC row whose only new figure is earnings on an older deposit", () => {
    const earningsOnly = `Qualified Non-Elective 9.17 0.79 9.96 100% 9.96
Safe Harbor Match 500.00 259.17 5.00 0.00 764.17 100% 764.17`;
    expect(employerRows(TEXT(earningsOnly, "Contribution Nov 30, 2023 Dec 05, 2023 1.00"))).toEqual([["Payroll Contributions (employer)", 25_917]]);
  });

  it("leaves payroll contributions whole when no QNEC is funded", () => {
    expect(employerRows(TEXT("Safe Harbor Match 500.00 259.17 5.00 0.00 764.17 100% 764.17"))).toEqual([["Payroll Contributions (employer)", 25_917]]);
  });
});
