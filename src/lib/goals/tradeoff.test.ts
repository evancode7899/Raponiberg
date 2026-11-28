import { describe, expect, it } from "vitest";
import type { GoalForecast } from "./fill";
import { landsWith, savingToLand } from "./tradeoff";

// An invented forecast: $1,000 a month into liquid accounts, nothing into the rest.
const f: GoalForecast = { startKey: "2027-01", start: { liquid: 0, illiquid: 0 }, months: Array.from({ length: 36 }, (_, i) => ({ key: `${2027 + Math.floor((i + 1) / 12)}-${String(((i + 1) % 12) + 1).padStart(2, "0")}`, liquid: (i + 1) * 1_000_00, illiquid: 0 })) };

describe("the goals trade-off", () => {
  it("lands a goal sooner with more saved and later with less", () => {
    const filled = { need: 12_000_00, own: 12_000_00, sides: ["liquid" as const] };
    const at = (d: number) => f.months.findIndex((m) => m.key === landsWith(f, filled, d));
    expect(at(0)).toBe(11);
    expect(at(1_000_00)).toBe(5);
    expect(at(-500_00)).toBe(23);
    // Retirement money isn't what a month's saving goes into.
    expect(landsWith(f, { ...filled, sides: ["illiquid"] }, 1_000_00)).toBeNull();
  });

  it("finds the least more a month that lands a goal by its date", () => {
    const g = { id: "g", filled: { need: 12_000_00, own: 12_000_00, sides: ["liquid" as const] }, targetDate: `${f.months[5]!.key}-28` };
    expect(savingToLand(f, g)).toBe(1_000_00);
    expect(savingToLand(f, { ...g, targetDate: `${f.months[20]!.key}-28` })).toBe(0);
  });
});
