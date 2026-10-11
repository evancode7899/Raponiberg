import { describe, expect, it } from "vitest";
import { forecastFiller, type GoalForecast } from "./goals";

// All amounts below are invented.
const f: GoalForecast = {
  startKey: "2026-06",
  start: { liquid: 100, illiquid: 50 },
  months: [
    { key: "2026-07", liquid: 110, illiquid: 60 },
    { key: "2026-08", liquid: 120, illiquid: 70 },
    { key: "2026-09", liquid: 130, illiquid: 80 },
    { key: "2026-10", liquid: 140, illiquid: 90 },
  ],
};

describe("forecastFiller", () => {
  it("fills goals on the same kind of account in priority order", () => {
    const reach = forecastFiller(f);
    expect(reach(10, true, false)).toBe("2026-07");
    expect(reach(15, true, false)).toBe("2026-09");
    expect(reach(100, true, false)).toBeNull();
  });

  it("keeps liquid and retirement money apart", () => {
    const reach = forecastFiller(f);
    expect(reach(20, true, false)).toBe("2026-08");
    expect(reach(20, false, true)).toBe("2026-08");
  });

  it("counts both kinds for a goal funded by both, behind every earlier goal", () => {
    const reach = forecastFiller(f);
    expect(reach(10, true, false)).toBe("2026-07");
    // Needs 10 (earlier goal) + 30 of combined new money: 20 a month.
    expect(reach(30, true, true)).toBe("2026-08");
  });
});
