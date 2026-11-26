import { describe, expect, it } from "vitest";
import { walkAwayCost, walkAwayDates } from "./bonusFigures";

// Invented awards: two deferred tranches still to come, one already paid.
const t = (to: string, amountCents: number, status = "UPCOMING") => ({ to, amountCents, status });
const awards = [{ year: 2025, tranches: [t("2026-03-31", 10_000_00, "PAID"), t("2027-03-31", 12_000_00), t("2028-03-31", 12_000_00)] }, { year: 2026, tranches: [t("2027-03-31", 8_000_00, "DUE")] }];

describe("walking away", () => {
  it("leaves behind every tranche whose window ends after the day, less as each one pays", () => {
    expect(walkAwayCost(awards, "2026-11-26").cents).toBe(32_000_00);
    expect(walkAwayCost(awards, "2027-03-31").cents).toBe(12_000_00);
    expect(walkAwayCost(awards, "2028-04-01").cents).toBe(0);
    expect(walkAwayCost(awards, "2026-11-26").tranches.map((x) => x.award.year)).toEqual([2025, 2025, 2026]);
  });

  it("changes on today and each window's end", () => {
    expect(walkAwayDates(awards, "2026-11-26")).toEqual(["2026-11-26", "2027-03-31", "2028-03-31"]);
    expect(walkAwayDates([], "2026-11-26")).toEqual(["2026-11-26"]);
  });
});
