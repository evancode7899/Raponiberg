import { describe, expect, it } from "vitest";
import { addBusinessDays } from "./isoDate";

describe("addBusinessDays", () => {
  it("skips weekends", () => {
    // Sun Oct 25 2026 + 5 → Fri Oct 30; Fri Oct 30 + 1 → Mon Nov 2.
    expect(addBusinessDays("2026-10-25", 5)).toBe("2026-10-30");
    expect(addBusinessDays("2026-10-30", 1)).toBe("2026-11-02");
    expect(addBusinessDays("2026-09-30", 25)).toBe("2026-11-04");
  });

  it("leaves the day alone for zero", () => {
    expect(addBusinessDays("2026-10-24", 0)).toBe("2026-10-24");
  });
});
