import { describe, expect, it } from "vitest";
import { addMonths, indexChange, latestAtOrBefore, type IndexSeries } from "./priceIndexMath";

// An invented series: 100 in Jan 2025, up 1 a month, published through Mar 2026.
const months: Record<string, number> = {};
for (let i = 0; i < 15; i++) months[addMonths("2025-01", i)] = 100 + i;
const s: IndexSeries = { name: "Invented", source: "", url: "", fetchedOn: "2026-04-15", kind: "price", months };

describe("price series", () => {
  it("steps months across a year end, and finds the latest published month", () => {
    expect(addMonths("2025-11", 3)).toBe("2026-02");
    expect(addMonths("2026-01", -13)).toBe("2024-12");
    expect(latestAtOrBefore(s, "2026-06")).toBe("2026-03");
    expect(latestAtOrBefore(s, "2024-06")).toBeNull();
  });

  it("changes from month to month, nothing guessed for a month missing", () => {
    expect(indexChange(s, "2025-01", "2025-11")!.change).toBeCloseTo(0.1, 12);
    expect(indexChange(s, "2024-12", "2025-11")).toBeNull();
  });

});
