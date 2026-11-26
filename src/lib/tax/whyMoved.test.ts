import { describe, expect, it, vi } from "vitest";

// The comparison table is the source: each invented year is its household column.
const table: Record<number, Record<string, number>> = {
  2025: { "ordinary-tax": 30_000_00, credits: -2_000_00, ct: 9_000_00, "social-security": 11_000_00, medicare: 3_000_00, total: 51_500_00 },
  2026: { "ordinary-tax": 34_000_00, niit: 1_200_00, credits: -2_200_00, ct: 9_800_00, "social-security": 11_500_00, medicare: 3_200_00, total: 58_100_00 },
};
vi.mock("./comparison", () => ({
  taxComparison: (r: { year: number }) => ({ cols: [{ id: "joint", name: "Joint" }], rows: Object.entries(table[r.year]!).map(([id, v]) => ({ id, label: id, kind: "usd", values: [v] })) }),
}));
const { taxMoved } = await import("./whyMoved");
const year = (y: number) => ({ year: y }) as unknown as Parameters<typeof taxMoved>[0];

describe("why tax moved", () => {
  it("splits the change in the total into the return's parts, adding up to the cent", () => {
    const m = taxMoved(year(2026), year(2025));
    expect(m.total).toMatchObject({ priorCents: 51_500_00, cents: 58_100_00, deltaCents: 6_600_00 });
    expect(m.rows.find((r) => r.id === "niit")).toMatchObject({ priorCents: 0, deltaCents: 1_200_00 });
    expect(m.rows.reduce((s, r) => s + r.deltaCents, 0)).toBe(m.total.deltaCents);
    // The totals hold $500 and $600 beyond the parts (paid leave): one line of its own.
    expect(m.rows.at(-1)).toMatchObject({ id: "other", priorCents: 500_00, cents: 600_00 });
  });

  it("leaves out parts neither year has, and adds no other line when the parts make the total", () => {
    table[2024] = { "ordinary-tax": 10_00, total: 10_00 };
    table[2023] = { "ordinary-tax": 10_00, total: 10_00 };
    const m = taxMoved(year(2024), year(2023));
    expect(m.rows.map((r) => r.id)).toEqual(["ordinary-tax"]);
    expect(m.total.deltaCents).toBe(0);
  });
});
