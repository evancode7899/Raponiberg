import { describe, expect, it } from "vitest";
import { endOfMonth, periodLabel } from "../../dates/isoDate";
import type { HouseholdPeriod, NetWorthPeriod } from "../../ledger/netWorthReport";
import type { CashFlowPeriod, CategoryAmount } from "./cashFlow";
import { highlightText, netWorthChangesOf } from "./netWorthChanges";

// An invented household, Jan – Jun 2025: every amount is made up.

type Lanes = Partial<Pick<HouseholdPeriod, "incomeCents" | "spendingCents" | "externalCents" | "retirementEmployeeCents" | "retirementEmployerCents" | "transferResidualCents" | "growthNetOfFeesCents" | "newlyTrackedCents">>;

/** Months chained from $50,000.00: each closes at its opening plus every lane. */
function months(lanes: Lanes[], opts: { through?: string } = {}): NetWorthPeriod[] {
  let bal = 5_000_000;
  return lanes.map((l, i) => {
    const start = `2025-${String(i + 1).padStart(2, "0")}-01`;
    const h: HouseholdPeriod = {
      openingCents: bal,
      closingCents: 0,
      newlyTrackedCents: l.newlyTrackedCents ?? 0,
      principalCents: 0,
      incomeCents: l.incomeCents ?? 0,
      spendingCents: l.spendingCents ?? 0,
      externalCents: l.externalCents ?? 0,
      retirementEmployeeCents: l.retirementEmployeeCents ?? 0,
      retirementEmployerCents: l.retirementEmployerCents ?? 0,
      transferResidualCents: l.transferResidualCents ?? 0,
      growthNetOfFeesCents: l.growthNetOfFeesCents ?? 0,
      feesCents: 0,
      unexplainedCents: 0,
      quality: "EXACT",
      portfolioReturn: 0.01,
    };
    h.principalCents = h.incomeCents + h.spendingCents + h.externalCents + h.retirementEmployeeCents + h.retirementEmployerCents;
    h.closingCents = h.openingCents + h.principalCents + h.newlyTrackedCents + h.transferResidualCents + h.growthNetOfFeesCents;
    bal = h.closingCents;
    const last = i === lanes.length - 1 && opts.through;
    return { label: periodLabel(start, "month"), start, end: last ? opts.through! : endOfMonth(start), through: last ? opts.through! : null, household: h, byAccount: [], byGroup: [] };
  });
}

const cat = (category: string, cents: number): CategoryAmount => ({ category, group: null, cents });

/** Cash flow over the same span: income and spending as given, by category. */
function cash(start: string, end: string, income: CategoryAmount[], spending: CategoryAmount[], g: "month" | "quarter" = "month", extra: Partial<CashFlowPeriod> = {}): CashFlowPeriod {
  const sum = (cs: CategoryAmount[]) => cs.reduce((t, c) => t + c.cents, 0);
  return {
    label: periodLabel(start, g),
    start,
    end,
    through: null,
    incomeCents: sum(income),
    spendingCents: sum(spending),
    netCents: sum(income) - sum(spending),
    savingsRate: null,
    incomeByCategory: income,
    spendingByCategory: spending,
    externalByCategory: [],
    retirementEmployeeCents: 0,
    retirementEmployerCents: 0,
    unreviewed: { rows: 0, cents: 0 },
    blockers: [],
    ...extra,
  };
}

const PAY = 612_345;
const exact = () => "EXACT" as const;
const typicalMonth: Lanes ={ incomeCents: PAY, spendingCents: -310_000, retirementEmployeeCents: 45_000, growthNetOfFeesCents: 20_000 };

describe("netWorthChangesOf", () => {
  it("adds the steps up to the change, with timing for what cash flow counts in another month", () => {
    // Rent of $2,100.00 paid on Jan 30 for February: net worth counts it in January, cash flow in February.
    const nw = months([{ ...typicalMonth, spendingCents: -520_000 }, { ...typicalMonth, spendingCents: -100_000 }]);
    const cf = [
      cash("2025-01-01", "2025-01-31", [cat("Paycheck", PAY)], [cat("Groceries", 310_000)]),
      cash("2025-02-01", "2025-02-28", [cat("Paycheck", PAY)], [cat("Groceries", 100_000), cat("Rent", 210_000)]),
    ];
    const [jan, feb] = netWorthChangesOf(nw, cf, "month", exact);
    for (const p of [jan!, feb!]) {
      expect(p.steps.at(-1)!.toCents).toBe(p.changeCents);
      expect(p.changeCents).toBe(p.closingCents - p.openingCents);
      expect(p.savedCents + p.marketsCents).toBe(p.changeCents);
    }
    expect(jan!.spendingCents).toBe(310_000);
    expect(jan!.steps.find((s) => s.key === "timing")!.cents).toBe(-210_000);
    expect(feb!.steps.find((s) => s.key === "timing")!.cents).toBe(210_000);
    // Each bar starts where the one before ended.
    feb!.steps.forEach((s, i) => expect(s.fromCents).toBe(i ? feb!.steps[i - 1]!.toCents : 0));
  });

  it("compares each month with the proven whole months before it", () => {
    const nw = months([typicalMonth, typicalMonth, typicalMonth, { ...typicalMonth, spendingCents: -490_000 }]);
    const cf = nw.map((m, i) => cash(m.start, m.end, [cat("Paycheck", PAY)], i === 3 ? [cat("Groceries", 310_000), cat("Travel", 180_000)] : [cat("Groceries", 310_000)]));
    const ps = netWorthChangesOf(nw, cf, "month", exact);
    expect(ps[0]!.typical).toBeNull();
    const apr = ps[3]!;
    expect(apr.typical).toMatchObject({ periods: 3, spendingCents: 310_000, incomeCents: PAY });
    expect(apr.steps.find((s) => s.key === "spending")!.typicalCents).toBe(-310_000);
    expect(apr.spendingMovers).toEqual([expect.objectContaining({ category: "Travel", cents: 180_000, typicalCents: 0, deltaCents: 180_000 })]);
    expect(apr.highlights.map(highlightText).join(" ")).toContain("mostly Travel (+⁠$1,800)");
    expect(apr.proofs.spending).toEqual({ report: "cash-flow", metric: "spending", granularity: "month", start: "2025-04-01", end: "2025-04-30" });
  });

  it("leaves out periods cash flow can't prove, and months missing from net worth", () => {
    const nw = months([typicalMonth, typicalMonth, typicalMonth]);
    const cf = nw.map((m, i) => cash(m.start, m.end, [cat("Paycheck", PAY)], [cat("Groceries", 310_000)], "month", i === 1 ? { blockers: [{ id: "f1", status: "MISSING", title: "A statement is missing", fix: "Download it." }] } : {}));
    expect(netWorthChangesOf(nw, cf, "month", exact).map((p) => p.label)).toEqual([nw[0]!.label, nw[2]!.label]);
    expect(netWorthChangesOf([nw[0]!, nw[2]!], cf.slice(0, 2), "month", exact).map((p) => p.start)).toEqual(["2025-01-01"]);
  });

  it("adds a quarter's months, and doesn't compare a period cut short", () => {
    const nw = months(Array.from({ length: 5 }, () => typicalMonth), { through: "2025-05-20" });
    const cf = [
      cash("2025-01-01", "2025-03-31", [cat("Paycheck", 3 * PAY)], [cat("Groceries", 930_000)], "quarter"),
      cash("2025-04-01", "2025-05-20", [cat("Paycheck", 2 * PAY)], [cat("Groceries", 620_000)], "quarter", { through: "2025-05-20" }),
    ];
    const [q1, q2] = netWorthChangesOf(nw, cf, "quarter", exact);
    expect(q1!.openingCents).toBe(nw[0]!.household.openingCents);
    expect(q1!.closingCents).toBe(nw[2]!.household.closingCents);
    expect(q1!.marketsCents).toBe(60_000);
    expect(q1!.portfolioReturn).toBeCloseTo(1.01 ** 3 - 1, 10);
    expect(q1!.steps.at(-1)!.toCents).toBe(q1!.changeCents);
    expect(q2!.through).toBe("2025-05-20");
    expect(q2!.typical).toBeNull();
    expect(q2!.proofs.change).toMatchObject({ granularity: "quarter", start: "2025-04-01", end: "2025-05-20" });
  });
});
