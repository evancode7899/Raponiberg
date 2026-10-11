import { describe, expect, it } from "vitest";
import { stubChecks } from "../ingest/payroll/checks";
import { sumPositions } from "../ingest/holdings/types";
import { validateSection } from "../ingest/validate";
import { generateDemoData } from "./generate";

describe("demo household", () => {
  const data = generateDemoData();
  const sections = data.documents.flatMap((d) => d.sections);
  const stubs = data.documents.flatMap((d) => d.payStubs ?? []);

  it("is the same every time", () => {
    expect(JSON.stringify(generateDemoData())).toBe(JSON.stringify(data));
  });

  it("covers January 2025 through June 2026, every account every month", () => {
    const byAccount = new Map<string, string[]>();
    for (const s of sections) byAccount.set(s.accountNumber, [...(byAccount.get(s.accountNumber) ?? []), s.periodStart]);
    expect(byAccount.size).toBe(8);
    for (const starts of byAccount.values()) {
      expect(starts).toHaveLength(18);
      expect(starts[0]).toBe("2025-01-01");
      expect(starts.at(-1)).toBe("2026-06-01");
    }
  });

  it("every statement ties out and opens where the last one closed", () => {
    for (const s of sections) expect(validateSection(s).problems.concat(validateSection(s).deltaCents ? ["delta"] : [])).toEqual([]);
    const last = new Map<string, number>();
    for (const s of sections) {
      if (last.has(s.accountNumber)) expect(s.openingBalanceCents).toBe(last.get(s.accountNumber));
      last.set(s.accountNumber, s.closingBalanceCents);
    }
  });

  it("every pay stub proves itself, and pay is about $2M a year", () => {
    expect(stubs.length).toBeGreaterThan(70);
    for (const s of stubs) expect(stubChecks(s).filter((c) => !c.ok)).toEqual([]);
    const lastOf2025 = (employee: string) => stubs.filter((s) => s.employee === employee && s.payDate.startsWith("2025")).at(-1)!;
    const gross = ["ALEX RIVERA", "JORDAN RIVERA"].reduce((t, e) => t + lastOf2025(e).printed.grossYtd!, 0);
    expect(gross).toBeGreaterThan(190_000_000);
    expect(gross).toBeLessThan(210_000_000);
  });

  it("holdings add up to the balance they describe", () => {
    for (const d of data.documents) for (const h of d.holdings ?? []) expect(sumPositions(h.positions)).toBe(h.printedTotalCents);
  });

  it("ends near $10M", () => {
    const total = Object.values(data.closing).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(950_000_000);
    expect(total).toBeLessThan(1_050_000_000);
  });
});
