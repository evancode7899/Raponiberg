import { describe, expect, it } from "vitest";
import { normalizeGoals, type Goal } from "../../goals/settings";
import { forecastFiller, goalClaimer, type GoalForecast } from "./goals";

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

describe("forecastFiller with milestones", () => {
  it("doesn't queue a milestone behind set-aside goals, or hold them up", () => {
    const reach = forecastFiller(f);
    expect(reach(20, true, false)).toBe("2026-08");
    // A milestone needing 15 of new liquid money: reached when 15 has come in, whatever is queued.
    expect(reach(15, true, false, true)).toBe("2026-08");
    expect(reach(5, true, true, true)).toBe("2026-07");
    // …and the next set-aside goal still queues only behind the first.
    expect(reach(10, true, false)).toBe("2026-09");
  });
});

// ---------------------------------------------------------------------------- claiming

const goal = (id: string, targetCents: number | null, patch: Partial<Goal> = {}): Goal => ({
  id,
  name: id,
  kind: "AMOUNT",
  targetCents,
  months: null,
  targetDate: null,
  groups: [],
  accountIds: [],
  funding: "SET_ASIDE",
  shares: {},
  ...patch,
});
const CASH = { id: "cash", name: "Checking", group: "Cash" as const };
const BROKER = { id: "broker", name: "Brokerage", group: "Taxable investments" as const };
const balances = () => new Map([["cash", 30_000], ["broker", 100_000]]);

describe("goals claiming account money", () => {
  it("lets a higher set-aside goal claim everything first, and says so", () => {
    const c = goalClaimer(balances());
    const big = c.claim(goal("big", 1_000_000), [CASH, BROKER], 1_000_000);
    const home = c.claim(goal("home", 50_000), [CASH, BROKER], 50_000);
    expect(big.accounts.map((a) => a.earmarkedCents)).toEqual([30_000, 100_000]);
    expect(home.accounts.map((a) => [a.claimedBeforeCents, a.earmarkedCents])).toEqual([
      [30_000, 0],
      [100_000, 0],
    ]);
    expect(home.claimedFirstBy).toEqual(["big"]);
  });

  it("lets a milestone count every balance without claiming any of it", () => {
    const c = goalClaimer(balances());
    const big = c.claim(goal("big", 1_000_000, { funding: "TRACK" }), [CASH, BROKER], 1_000_000);
    const home = c.claim(goal("home", 50_000), [CASH, BROKER], 50_000);
    expect(big.accounts.reduce((s, a) => s + a.earmarkedCents, 0)).toBe(130_000);
    expect(home.accounts.map((a) => a.earmarkedCents)).toEqual([30_000, 20_000]);
    expect(home.claimedFirstBy).toEqual([]);
    const [cash, broker] = c.rows([CASH, BROKER]);
    expect(cash).toMatchObject({ freeCents: 0, trackedBy: ["big"], claims: [{ goalId: "home", cents: 30_000 }] });
    expect(broker).toMatchObject({ freeCents: 80_000 });
  });

  it("shares one account between goals by percentage", () => {
    const c = goalClaimer(balances());
    const wedding = c.claim(goal("wedding", 500_000, { shares: { broker: 0.4 } }), [BROKER], 500_000);
    const home = c.claim(goal("home", 500_000), [BROKER], 500_000);
    expect(wedding.accounts[0]).toMatchObject({ share: 0.4, earmarkedCents: 40_000 });
    expect(home.accounts[0]).toMatchObject({ claimedBeforeCents: 40_000, earmarkedCents: 60_000 });
  });

  it("reads old settings as set-aside goals with no shares, and drops bad shares", () => {
    const [g] = normalizeGoals({ goals: [{ id: "a", name: "A", kind: "AMOUNT", targetCents: 100, shares: { x: 0.5, y: 2, z: "half" } }] }).goals;
    expect(g).toMatchObject({ funding: "SET_ASIDE", shares: { x: 0.5 } });
    expect(normalizeGoals({ goals: [{ id: "b", funding: "TRACK" }] }).goals[0]!.funding).toBe("TRACK");
  });
});
