import { describe, expect, it } from "vitest";
import type { BonusesReport } from "../book/reports/bonuses";
import type { AwardLetter } from "../bonuses/awardStore";
import type { OutlookSeeds, PersonSeed } from "../profile/basePay";
import { DEFAULT_OUTLOOK, type OutlookAssumptions } from "../profile/settings";
import { taxYearParams } from "../tax/params";
import { bonusFacts, bonusSchedule, monthKey, type BonusFacts, type SchedulePerson } from "./bonusSchedule";
import { balancesAt, buildForecast, liquidGrowthThrough } from "./forecast";

// All amounts below are invented.
const person: SchedulePerson = { personId: "a", name: "A", salary: 100_000_00, bonusPct: 0.5, bonusMonth: 3, paidSinceStart: [] };
const pattern: BonusFacts["patterns"][number] = {
  personId: "a",
  employer: "ACME",
  fromYear: 2025,
  lastAwardYear: 2025,
  parts: [
    { offset: 2, share: 0.7, plan: false, label: "70% as cash" },
    { offset: 7, share: 0.2, plan: false, label: "20% as cash" },
    { offset: 2, share: 0.1, plan: true, label: "10% deferred comp plan" },
  ],
};
const base = { startKey: "2026-06", startYear: 2026, people: [person], facts: { scheduled: [], patterns: [] } as BonusFacts, salaryGrowth: 0, estimates: "NEXT_PAYOUT" as const, nearTermThrough: 2027, throughYear: 2029 };

describe("bonusSchedule", () => {
  it("counts stub bonuses after the start and letter payments still to come", () => {
    const out = bonusSchedule({
      ...base,
      people: [{ ...person, bonusPct: 0, paidSinceStart: [{ payDate: "2026-07-29", gross: 5_000_00 }] }],
      facts: { scheduled: [{ personId: "a", employer: "ACME", key: "2027-02", gross: 3_000_00, label: "tranche" }], patterns: [] },
    });
    expect(out.map((b) => [b.key, b.source, b.gross, b.counted])).toEqual([
      ["2026-07", "PAID", 5_000_00, true],
      ["2027-02", "LETTER", 3_000_00, true],
    ]);
  });

  it("estimates awards after the letter's last year on its payout pattern, the plan deferral listed but not counted", () => {
    const out = bonusSchedule({ ...base, facts: { scheduled: [], patterns: [pattern] }, throughYear: 2026 });
    expect(out.map((b) => [b.key, b.gross, b.counted, b.awardYear])).toEqual([
      ["2027-02", 35_000_00, true, 2026],
      ["2027-02", 5_000_00, false, 2026],
      ["2027-07", 10_000_00, true, 2026],
    ]);
  });

  it("keeps estimates out of the near term by default, and out entirely when switched off", () => {
    const after = bonusSchedule({ ...base, facts: { scheduled: [], patterns: [pattern] }, estimates: "AFTER_NEAR_TERM" });
    expect(after.filter((b) => b.counted).every((b) => b.key >= "2028-01")).toBe(true);
    expect(after.find((b) => b.key === "2027-02" && !b.counted)!.why).toMatch(/near term/);
    const none = bonusSchedule({ ...base, facts: { scheduled: [], patterns: [pattern] }, estimates: "NONE" });
    expect(none.every((b) => !b.counted)).toBe(true);
  });

  it("without a letter, pays the estimate in the usual month, skipping a payout the stubs already passed", () => {
    const out = bonusSchedule({ ...base, startKey: "2026-02", people: [{ ...person, paidSinceStart: [{ payDate: "2026-03-15", gross: 40_000_00 }] }], throughYear: 2027 });
    expect(out.map((b) => [b.key, b.source])).toEqual([
      ["2026-03", "PAID"],
      ["2027-03", "ESTIMATE"],
      ["2028-03", "ESTIMATE"],
    ]);
  });

  it("grows estimates with raises", () => {
    const out = bonusSchedule({ ...base, salaryGrowth: 0.1, throughYear: 2027 });
    expect(out.find((b) => b.awardYear === 2027)!.gross).toBe(Math.round(100_000_00 * 1.1 * 0.5));
  });

  it("rolls month keys over year ends", () => {
    expect(monthKey(2027, 14)).toBe("2028-02");
    expect(monthKey(2027, 12)).toBe("2027-12");
  });
});

describe("bonusFacts", () => {
  const letter: AwardLetter = {
    id: "acme",
    title: "ACME",
    employer: "ACME",
    awards: [
      {
        year: 2025,
        totalBonus: 100_000,
        planDeferral: 10_000,
        payments: [
          { kind: "UPFRONT", from: "2026-01", to: "2026-02", amount: 60_000 },
          { kind: "DEFERRED", from: "2027-02", to: "2027-03", amount: 30_000 },
        ],
      },
    ],
  };
  const report = {
    letters: [{ id: "acme", title: "ACME", employer: "ACME", terms: null, notes: [], employment: { personId: "a", personName: "A", employer: "ACME", employerKey: "acme", first: "2025-01-01", last: "2026-09-15", nextEmployer: null } }],
    windows: [
      { key: "acme|2027-02", letterId: "acme", label: "Feb/Mar 2027", from: "2027-02-01", to: "2027-03-31", status: "UPCOMING", scheduledCents: 30_000_00 },
      { letterId: "acme", label: "Jan/Feb 2026", from: "2026-01-01", to: "2026-02-28", status: "PAID", scheduledCents: 60_000_00 },
    ],
  } as unknown as BonusesReport;

  it("reads still-vesting windows and the latest award's payout pattern", () => {
    const f = bonusFacts(report, [letter]);
    expect(f.scheduled).toEqual([{ personId: "a", employer: "ACME", key: "2027-03", gross: 30_000_00, label: "ACME: Feb/Mar 2027 (letter)", window: "acme|2027-02" }]);
    // The forecast keeps the window, so its proof can open the Bonuses proof of that payment.
    const out = bonusSchedule({ ...base, facts: f, throughYear: 2027 });
    expect(out.find((b) => b.source === "LETTER")?.window).toBe("acme|2027-02");
    expect(f.patterns[0]!.parts.map((p) => [p.offset, p.share, p.plan])).toEqual([
      [2, 0.6, false],
      [15, 0.3, false],
      [2, 0.1, true],
    ]);
  });

  it("ignores a letter from an employer the person has left", () => {
    const left = { ...report, letters: [{ ...report.letters[0]!, employment: { ...report.letters[0]!.employment!, nextEmployer: "OTHER" } }] } as BonusesReport;
    expect(bonusFacts(left, [letter])).toEqual({ scheduled: [], patterns: [] });
  });
});

describe("buildForecast", () => {
  const fp = taxYearParams(2026).federal;
  const seedPerson: PersonSeed = {
    personId: "a",
    name: "A",
    employer: "ACME",
    perYear: 24,
    frequency: "SEMIMONTHLY",
    latest: { payDate: "2026-06-15", regular: 5_000_00, section125: 0, hsa: 0, afterTax: 0, employer: 0 },
    typical: { payDate: "2026-06-15", regular: 5_000_00, section125: 0, hsa: 0, afterTax: 0, employer: 0 },
    deferrals: { LATEST: { k401Pretax: 0, k401Roth: 0, hsa: 0 }, TYPICAL: { k401Pretax: 0, k401Roth: 0, hsa: 0 } },
    bonusHistory: [{ year: 2025, salary: 120_000_00, bonus: 24_000_00, pct: 0.2, partial: false }],
    bonusMonth: 3,
    bonusesSinceStart: [{ payDate: "2026-07-15", gross: 10_000_00 }],
    note: "",
  };
  const seeds: OutlookSeeds = {
    start: { asOf: "2026-06-30", year: 2026, month: 6, liquid: 100_000_00, illiquid: 50_000_00, note: "" },
    baseYear: 2025,
    currentYear: 2026,
    people: [seedPerson],
    living: { TRAILING_12: { cents: 60_000_00, label: "Last 12 months", detail: "" } },
    realizedReturn: null,
    taxYear: 2026,
    tax: { year: 2026, standardDeduction: fp.standardDeduction.MFJ, brackets: fp.brackets.MFJ },
    dependents: [],
    birthYear: 1990,
  };
  const a: OutlookAssumptions = { ...DEFAULT_OUTLOOK, horizonYear: 2030, returnRate: 0.05 };
  const f = buildForecast({ seeds, bonusFacts: { scheduled: [], patterns: [] } }, a);

  it("counts the stub bonus paid after the start, and estimates only after the near term by default", () => {
    expect(f.months.find((m) => m.key === "2026-07")!.bonusGross).toBe(10_000_00);
    expect(f.years.filter((y) => y.year <= 2027).reduce((t, y) => t + y.bonusGross, 0)).toBe(10_000_00);
    expect(f.months.find((m) => m.key === "2028-03")!.bonusGross).toBe(Math.round(120_000_00 * 1.03 ** 1 * 0.2));
    expect(f.plan.walkAwayYear).toBeNull();
  });

  it("dates milestones to the month and reads balances at any month", () => {
    const m = f.milestones.find((x) => x.cents === 250_000_00)!;
    expect(m.key).toBe(f.months.find((x) => x.netWorth >= 250_000_00)?.key ?? null);
    expect(balancesAt(f, "2026-03")).toMatchObject({ key: "2026-06", netWorth: 150_000_00, projected: false });
    const dec = f.months.find((x) => x.key === "2027-12")!;
    expect(balancesAt(f, "2027-12")).toMatchObject({ liquid: dec.liquid, illiquid: dec.illiquid, projected: true });
    expect(liquidGrowthThrough(f, "2027-12")).toBe(f.months.filter((x) => x.key <= "2027-12").reduce((t, x) => t + x.liquidGrowth, 0));
  });
});
