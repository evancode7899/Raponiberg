import { describe, expect, it } from "vitest";
import { buildCoverReport } from "../insurance/cover";
import type { AutoPolicy, PropertyPolicy } from "../insurance/types";
import { generateDemoData } from "./generate";

describe("the demo's home and auto cover", () => {
  const data = generateDemoData();
  const entries = Object.entries(data.insurance.files);
  const homes = entries.flatMap(([file, e]) => (e.doc?.kind === "PROPERTY" ? [{ file, policy: e.doc as PropertyPolicy }] : []));
  const autos = entries.flatMap(([file, e]) => (e.doc?.kind === "AUTO" ? [{ file, policy: e.doc as AutoPolicy }] : []));

  it("has a renters policy each March and six-month auto terms through the demo's last month", () => {
    expect(homes.map((h) => h.policy.periodStart)).toEqual(["2025-03-01", "2026-03-01"]);
    expect(autos[0]!.policy.periodStart).toBe("2025-01-05");
    expect(autos.at(-1)!.policy.periodEnd >= "2026-06-30").toBe(true);
    for (const a of autos) expect(a.policy.coverages.reduce((s, c) => s + (c.premiumCents[0] ?? 0), 0)).toBe(a.policy.termPremiumCents);
  });

  it("pays each from the demo's own statements, so every premium finds its policy", () => {
    const rows = data.documents.flatMap((d) => d.sections.flatMap((s) => s.transactions.map((t, i) => ({ id: `${d.title}-${i}`, date: t.date, amountCents: t.amountCents, payee: t.description, accountId: s.accountNumber ?? "" }))));
    const r = buildCoverReport({ homes, autos, renewals: [], forms: [], rows, today: "2026-07-15" });
    const json = JSON.stringify(r);
    expect(rows.filter((x) => /STATE FARM/.test(x.payee))).toHaveLength(2);
    expect(rows.filter((x) => /GEICO/.test(x.payee))).toHaveLength(18);
    expect(json).toContain("STATE FARM INSURANCE PREM");
    expect(json).toContain("GEICO AUTO INSURANCE");
  });
});
