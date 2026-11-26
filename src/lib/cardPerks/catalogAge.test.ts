import { describe, expect, it } from "vitest";
import { catalogAge } from "./catalogAge";

describe("the card catalog's age", () => {
  it("counts whole months from its date, and calls six or more stale", () => {
    expect(catalogAge("2026-10-20", "2026-10")).toEqual({ asOf: "2026-10", months: 0, stale: false });
    expect(catalogAge("2027-03-01", "2026-10")).toEqual({ asOf: "2026-10", months: 5, stale: false });
    expect(catalogAge("2027-04-15", "2026-10")).toEqual({ asOf: "2026-10", months: 6, stale: true });
    expect(catalogAge("2026-07-15", "2026-10").months).toBe(0);
  });
});
