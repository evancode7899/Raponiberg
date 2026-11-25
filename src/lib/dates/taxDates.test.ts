import { describe, expect, it } from "vitest";
import { estimateInstallments, filingDate, taxDueDate } from "./taxDates";

describe("tax due dates", () => {
  it("keeps a weekday", () => {
    expect(filingDate(2025)).toBe("2026-04-15");
    expect(filingDate(2026)).toBe("2027-04-15");
    expect(estimateInstallments(2026)[3]).toEqual({ quarter: 4, date: "2027-01-15" });
  });

  it("moves a weekend to the next business day, past a holiday on it", () => {
    // April 15, 2028 is a Saturday and Emancipation Day is kept on Monday the 17th.
    expect(filingDate(2027)).toBe("2028-04-18");
    // January 15, 2028 is a Saturday, and Monday the 17th is Martin Luther King Jr. Day.
    expect(estimateInstallments(2027)[3]!.date).toBe("2028-01-18");
    // As the IRS set them in past years.
    expect(taxDueDate("2022-04-15")).toBe("2022-04-18");
    expect(taxDueDate("2023-04-15")).toBe("2023-04-18");
    expect(taxDueDate("2024-01-15")).toBe("2024-01-16");
    expect(taxDueDate("2024-06-15")).toBe("2024-06-17");
    expect(taxDueDate("2024-09-15")).toBe("2024-09-16");
  });

  it("lists a year's four installments in order", () => {
    expect(estimateInstallments(2027).map((x) => x.date)).toEqual(["2027-04-15", "2027-06-15", "2027-09-15", "2028-01-18"]);
  });
});
