import { describe, expect, it } from "vitest";
import { edgeOf, unlockedBetween, type Edge } from "./unlocked";

const book = (edge: string, accounts: [string, string | null, boolean?][]) => ({
  horizon: { netWorth: edge },
  ledger: { accounts: accounts.map(([name, lastDay, closed]) => ({ name, closed: !!closed, timeline: { lastDay } })) },
});

describe("what an import unlocked", () => {
  const before: Edge = edgeOf(book("2031-03-31", [["Example Card ••1234", "2031-04-30"], ["Springfield Savings ••5678", "2031-03-31"], ["Old Card ••9999", "2030-01-31", true]]));

  it("leaves closed accounts out of the edge", () => {
    expect(before.accounts.map((a) => a.name)).toEqual(["Example Card ••1234", "Springfield Savings ••5678"]);
  });

  it("names the months now proven, the accounts that moved on, and what holds the edge now", () => {
    const after = edgeOf(book("2031-04-30", [["Example Card ••1234", "2031-04-30"], ["Springfield Savings ••5678", "2031-05-31"], ["New Brokerage ••4321", "2031-04-30"]]));
    expect(unlockedBetween(before, after)).toEqual({
      edge: { from: "2031-03-31", to: "2031-04-30" },
      months: ["2031-04"],
      accounts: [
        { name: "Springfield Savings ••5678", from: "2031-03-31", to: "2031-05-31" },
        { name: "New Brokerage ••4321", from: null, to: "2031-04-30" },
      ],
      heldBy: ["Example Card ••1234", "New Brokerage ••4321"],
    });
  });

  it("counts a month only once its last day is proven, across a year end", () => {
    const from: Edge = { provenThrough: "2030-11-15", accounts: [] };
    expect(unlockedBetween(from, { provenThrough: "2031-02-10", accounts: [] }).months).toEqual(["2030-11", "2030-12", "2031-01"]);
  });

  it("says nothing moved when the edge stayed", () => {
    expect(unlockedBetween(before, before)).toMatchObject({ edge: null, months: [], accounts: [] });
  });
});
