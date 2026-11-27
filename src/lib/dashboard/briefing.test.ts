import { describe, expect, it } from "vitest";
import { cashCap, pastScale } from "@/app/dashboard/charts";
import { isUnswept } from "../book/proof/clearance";
import { descriptorKey } from "../book/proof/key";
import type { NetWorthReport } from "../book/reports/netWorth";
import type { NetWorthChangesReport } from "../book/reports/netWorthChanges";
import type { InsurancePage } from "../insurance/page";
import { buildBriefing, eventsOf, type BriefingInputs } from "./briefing";
import { provenSeries } from "./homeSummary";
import { CREDIT_DAYS, upcomingDue } from "./upcoming";

// An invented household: every name, account and amount is made up.

const position = (accountId: string, key: string, valueCents: number, unrealizedCents: number | null) => ({ kind: "FUND", accountId, account: `Example ${accountId}`, key, lot: 0, symbol: key, name: `${key} fund`, valueCents, unrealizedCents, costBasisCents: unrealizedCents == null ? null : valueCents - unrealizedCents, price: null, expenseRatio: null, annualFeeCents: null, asOf: "2031-03-31" });
const investments = {
  asOf: "2031-03-31",
  totalCents: 900_000,
  accounts: [],
  positions: [position("ira", "EXTOT", 200_000, 30_000), position("taxable", "EXTOT", 500_000, 70_000), position("taxable", "EXINT", 200_000, null)],
  allocation: [{ cls: "US_STOCK", cents: 700_000, share: 7 / 9 }, { cls: "INTL_STOCK", cents: 200_000, share: 2 / 9 }],
  byTreatment: [],
  fees: { annualCents: 0, knownCents: 0, unknownCents: 900_000, weightedRatio: null, accountFeesLast12Cents: 0 },
  gains: { taxable: { unrealizedCents: 70_000, gainCents: 70_000, lossCents: 0, costKnownCents: 500_000, costUnknownCents: 200_000 }, all: { unrealizedCents: 100_000, costKnownCents: 700_000 }, harvest: [] },
  concentration: [
    { key: "EXTOT", symbol: "EXTOT", name: "Example total market", cents: 700_000, share: 7 / 9, accounts: ["Example ira", "Example taxable"] },
    { key: "EXINT", symbol: "EXINT", name: "Example international", cents: 200_000, share: 2 / 9, accounts: ["Example taxable"] },
  ],
  drift: [{ cls: "US_STOCK", currentShare: 7 / 9, targetShare: 0.7, deltaCents: -70_000 }],
  growth: [],
  returns: { quarters: [], window: null },
  unclassified: [],
  blockers: [],
};
const netWorth = { granularity: "month", periods: [], accounts: [], proven: { from: null, returns: { portfolio: null, byAccount: [] } }, mergeDate: null };
const briefing = buildBriefing({
  book: { today: "2031-04-15" },
  changes: { granularity: "month", periods: [] },
  netWorth,
  spending: { months: [], recurring: [], oneOffs: [] },
  calendar: { items: [] },
  bonuses: { windows: [] },
  goals: { goals: [] },
  investments,
  returnRate: 0.06,
  forecast: null,
  profile: { seeds: null },
} as unknown as BriefingInputs);

describe("the portfolio's holdings", () => {
  it("lists a fund held in two accounts once, at the concentration figure's value and proof", () => {
    expect(briefing.portfolio.holdings.map((h) => [h.name, h.cents, h.accounts.length])).toEqual([["EXTOT", 700_000, 2], ["EXINT", 200_000, 1]]);
    const proof = briefing.portfolio.holdings[0]!.proof;
    expect(isUnswept(proof) ? null : descriptorKey(proof.descriptor)).toBe(descriptorKey({ report: "derived", page: "investments", figure: "concentration", key: "EXTOT" }));
  });

  it("adds its positions' gains as a composite of their proofs, and states none where a cost isn't printed", () => {
    const [total, intl] = briefing.portfolio.holdings;
    expect(total!.gainCents).toBe(100_000);
    const p = total!.gainProof;
    expect(isUnswept(p) ? null : [p.shownCents, (p.descriptor as { report: string; op?: string; of?: unknown[] }).op, (p.descriptor as { of?: unknown[] }).of?.length]).toEqual([100_000, "sum", 2]);
    expect(intl!.gainCents).toBeNull();
    expect(isUnswept(intl!.gainProof)).toBe(true);
  });

  it("says what each class is from its target, and nothing for a class with no target", () => {
    expect(briefing.portfolio.hasTarget).toBe(true);
    expect(briefing.portfolio.classes.map((c) => c.driftCents)).toEqual([-70_000, null]);
  });
});

describe("net worth's All", () => {
  it("is every month from the first proven one, however many, with a later gap left as a gap", () => {
    const periods = Array.from({ length: 60 }, (_, i) => ({ end: `e${i}`, label: `m${i}`, blockers: i < 3 || i === 40 ? [{ id: "x" }] : [], household: { closingCents: i * 100, closingQuality: "EXACT" } }));
    const s = provenSeries(periods as never);
    expect([s.length, s[0]!.label, s.at(-1)!.label]).toEqual([57, "m3", "m59"]);
    expect(s.filter((x) => x.cents == null).map((x) => x.label)).toEqual(["m40"]);
  });
});

describe("flags on the net worth chart", () => {
  const month = (i: number) => new Date(Date.UTC(2030, i, 1)).toISOString().slice(0, 7);
  const periods = Array.from({ length: 14 }, (_, i) => ({ label: month(i), start: `${month(i)}-01`, end: `${month(i)}-28`, blockers: i === 0 ? [{ id: "x" }] : [], byAccount: [{ accountId: "sav", newlyTrackedCents: i === 5 ? 1_000 : 0 }, { accountId: "chk", newlyTrackedCents: i === 1 ? 5_000 : 0 }] }));
  const changes = periods.slice(1).map((p, i) => ({ label: p.label, marketsCents: i === 3 ? 9_000 : i === 7 ? -8_000 : 100, savedCents: i === 9 ? 7_000 : 50, spendingCents: i === 2 ? 6_000 : 40 }));
  const nw = { periods, accounts: [{ id: "sav", name: "Example savings" }, { id: "chk", name: "Example checking" }], mergeDate: "2030-07-15" } as unknown as NetWorthReport;

  it("names the merge, accounts first on file after the first proven month, and the months that stand out", () => {
    expect(eventsOf(nw, { periods: changes } as unknown as NetWorthChangesReport)).toEqual([
      { label: "2030-07", text: "finances merged" },
      { label: "2030-06", text: "Example savings first on file" },
      { label: "2030-05", text: "best month for markets" },
      { label: "2030-09", text: "worst month for markets" },
      { label: "2030-11", text: "most saved in a month" },
      { label: "2030-04", text: "most spent in a month" },
    ]);
  });

  it("calls no month the best of fewer than twelve", () => {
    expect(eventsOf({ ...nw, mergeDate: null as never }, { periods: changes.slice(0, 6) } as unknown as NetWorthChangesReport).map((e) => e.text)).toEqual(["Example savings first on file"]);
  });
});

describe("Next up beyond the calendar", () => {
  const act = (over: object) => ({ accountId: "c1", perkId: "dining", name: "Dining credit", card: "Example Gold Card", leftCents: 1_500, ends: "2031-04-30", daysLeft: 15, how: "Pay at a partner.", neverUsed: false, ...over });
  const perks = { year: 2031, totals: {}, cards: [], act: [act({}), act({ perkId: "far", daysLeft: CREDIT_DAYS + 1 }), act({ perkId: "spent", leftCents: 0 }), act({ perkId: "never", neverUsed: true })] } as never;
  const term = { policy: { policyNumber: "EX-1", insurer: "Example Life", insured: "Pat Example", levelYears: 20, faceCents: 100, annualPremiumCents: 50_000 }, status: "IN_FORCE", years: [], currentYear: 1, faceNowCents: null, nextDue: { date: "2031-05-20", cents: 50_000, year: 2 }, dates: [{ key: "x", label: "Conversion ends", date: "2031-06-01", note: "", past: false }, { key: "y", label: "Level term ends", date: "2050-06-01", note: "", past: false }], payments: [], modes: [], bills: [], receipts: [], paidCents: 0 };
  const insurance = { today: "2031-04-15", through: "2031-03-31", policies: [term], homes: [], autos: [] } as unknown as InsurancePage;

  it("lists credits closing soon with money left, and policy dates, by date", () => {
    const due = upcomingDue(perks, { ...insurance, policies: [] });
    expect(due.map((d) => [d.date, d.title, d.cents, d.kind])).toEqual([["2031-04-30", "Use Dining credit", 1_500, "credit"]]);
    const p = due[0]!.proof;
    expect(isUnswept(p) ? null : (p.descriptor as { figure?: string }).figure).toBe("act");
  });

  it("states a premium only where the policy does: other dates carry none", () => {
    const due = upcomingDue({ ...(perks as object), act: [] } as never, insurance);
    expect(due.map((d) => (isUnswept(d.proof) ? null : (d.proof.descriptor as { figure?: string }).figure))).toEqual(["next-due", null]);
    expect(due.map((d) => [d.date, d.title, d.cents, d.dateOnly ?? false])).toEqual([
      ["2031-05-20", "Example Life: premium due (year 2)", 50_000, false],
      ["2031-06-01", "Example Life: conversion ends", null, true],
    ]);
  });
});

describe("a bonus month past the scale", () => {
  it("is cut for the chart and listed with what it was", () => {
    const months = [4, 4, 5, 4, 30, 5].map((k, i) => ({ label: `m${i}`, incomeCents: k * 100_000, spendingCents: 300_000 }));
    const cap = cashCap(months.map((m) => ({ label: m.label, income: m.incomeCents / 100, spending: m.spendingCents / 100 })));
    expect(cap).toBe(6_000);
    expect(pastScale(months, cap).map((x) => [x.m.label, x.what, x.cents])).toEqual([["m4", "income", 3_000_000]]);
    expect(pastScale(months, null)).toEqual([]);
  });
});
