import { describe, expect, it } from "vitest";
import { ZERO_AMOUNTS, type PayrollAmounts } from "./facts/payroll";
import { emptyYear, type W4OnFile } from "./profile";
import { allocatePerCheck, planW4, type W4Report } from "./w4";

const amounts = (a: Partial<PayrollAmounts>): PayrollAmounts => ({ ...ZERO_AMOUNTS, ...a });

/** A person whose stubs run to `latest`, then repeat `regular` on each of `dates`, plus a bonus withheld at `bonusWithheld`. */
function person(id: string, o: { latest: string; dates: string[]; freq: "SEMIMONTHLY" | "BIWEEKLY"; regular: PayrollAmounts; ytdFed: number; ytdCt: number; bonusWithheld?: number; status?: string }) {
  const n = o.dates.length;
  return {
    id,
    name: id === "pat" ? "Pat" : "Alex",
    payroll: [
      {
        active: true,
        employer: id === "pat" ? "Example Partners LP" : "Springfield Labs",
        frequency: o.freq,
        latestPayDate: o.latest,
        remainingPayDates: o.dates,
        regularPaycheck: o.regular,
        federalFilingStatus: o.status ?? "Married filing jointly",
        ytd: amounts({ federalWithheld: o.ytdFed, stateWithheld: o.ytdCt }),
        projected: amounts({ federalWithheld: o.ytdFed + o.regular.federalWithheld * n + (o.bonusWithheld ?? 0), stateWithheld: o.ytdCt + o.regular.stateWithheld * n }),
      },
    ],
  } as unknown as W4Report["people"][number];
}

const pat = (over: Partial<Parameters<typeof person>[1]> = {}) =>
  person("pat", {
    latest: "2026-08-31",
    // Sep 15 and Sep 30 are paid but not on a stub yet; four left after "today".
    dates: ["2026-09-15", "2026-09-30", "2026-10-15", "2026-10-31", "2026-11-15", "2026-11-30"],
    freq: "SEMIMONTHLY",
    regular: amounts({ gross: 800_000, federalWithheld: 120_000, stateWithheld: 40_000, ssWithheld: 49_600, medicareWithheld: 11_600, retirementPretax: 80_000 }),
    ytdFed: 1_900_000,
    ytdCt: 640_000,
    bonusWithheld: 220_000,
    ...over,
  });
const alex = () =>
  person("alex", {
    latest: "2026-09-10",
    dates: ["2026-09-24", "2026-10-08", "2026-10-22", "2026-11-05"],
    freq: "BIWEEKLY",
    regular: amounts({ gross: 200_000, federalWithheld: 15_000, stateWithheld: 9_000, ssWithheld: 12_400, medicareWithheld: 2_900 }),
    ytdFed: 260_000,
    ytdCt: 150_000,
  });

function report(people: W4Report["people"], fedBalance: number, ctBalance: number, w4: Record<string, W4OnFile> = {}): W4Report {
  const withheld = (k: "federalWithheld" | "stateWithheld") => people.flatMap((p) => p.payroll).reduce((t, x) => t + x.projected[k], 0);
  const fw = withheld("federalWithheld");
  const cw = withheld("stateWithheld");
  const inputs = emptyYear();
  for (const p of people) inputs.people[p.id] = { extras: {} as never, pay: { paycheck: "LATEST", payThrough: null }, w4: w4[p.id] ?? null };
  return {
    today: "2026-10-01",
    people,
    inputs,
    scenarios: {
      mfj: {
        // 30,000 of estimates and 5,000 of other credits on the federal side.
        federal: { totalTax: fw + 3_000_000 + 500_000 + fedBalance, withholding: fw, estimatedPayments: 3_000_000, balanceDue: fedBalance } as never,
        ct: { totalTax: cw + ctBalance, withholding: cw, estimatedPayments: 0, balanceDue: ctBalance } as never,
      },
    },
  };
}

describe("allocatePerCheck", () => {
  it("splits by weight, and a capped share's excess goes to the others", () => {
    const m = allocatePerCheck(100_000, [
      { key: "a", n: 4, weight: 3, cap: 100_000 },
      { key: "b", n: 4, weight: 1, cap: 5_000 },
    ]);
    expect(m.get("b")).toBe(5_000);
    expect(m.get("a")).toBe(20_000);
  });
});

describe("planW4", () => {
  it("adds Step 4(c) so the federal balance owed comes to $0", () => {
    const plan = planW4(report([pat(), alex()], 600_000, 0));
    const [p, a] = plan.people;
    expect(p!.reached).toEqual(["2026-10-15", "2026-10-31", "2026-11-15", "2026-11-30"]);
    expect(p!.sinceStub).toEqual(["2026-09-15", "2026-09-30"]);
    // Pat has 32,000 of pay left, Alex 6,000 (three biweekly checks after today).
    expect(a!.reached).toHaveLength(3);
    expect(p!.recommended.extraPerPaycheck).toBe(Math.round((600_000 * 32 / 38) / 4));
    expect(Math.abs(plan.federal.balanceAfter)).toBeLessThan(10);
    expect(plan.unreachable.federal).toBe(0);
    // CT is already even: no change.
    expect(p!.recommended.ct).toEqual(p!.onFile.ct);
  });

  it("ties the balance from the tax through each withholding piece", () => {
    const b = planW4(report([pat(), alex()], 600_000, 0)).federal;
    expect(b.withheldBonus).toBe(220_000);
    expect(b.withheldSinceStub).toBe(120_000 * 2 + 15_000);
    expect(b.otherCredits).toBe(500_000);
    expect(b.tax - b.withheldStubs - b.withheldSinceStub - b.withheldTooSoon - b.withheldReached - b.withheldBonus - b.withheldOther - b.estimates - b.otherCredits).toBe(b.balanceNow);
  });

  it("gives a refund back through 4(c) on file first, then Step 3 annualized", () => {
    const onFile: W4OnFile = { filingStatus: "MFJ", multipleJobs: true, credits: 0, otherIncome: 0, deductions: 0, extraPerPaycheck: 10_000, ct: { code: "A", additional: 0, reduced: 0 } };
    const plan = planW4(report([pat()], -200_000, -40_000, { pat: onFile }));
    const p = plan.people[0]!;
    // 200,000 over 4 paychecks = 50,000 less each: 10,000 from 4(c), 40,000 × 24 periods in Step 3.
    expect(p.recommended.extraPerPaycheck).toBe(0);
    expect(p.recommended.credits).toBe(40_000 * 24);
    expect(p.recommended.multipleJobs).toBe(true);
    expect(p.recommended.ct).toEqual({ code: "A", additional: 0, reduced: 10_000 });
    expect(plan.federal.balanceAfter).toBe(0);
    expect(plan.ct.balanceAfter).toBe(0);
  });

  it("skips paychecks a new W-4 is too late for, and leaves what no paycheck can take as unreachable", () => {
    const plan = planW4(report([pat()], 5_000_000, 0), { tooSoonCount: 3 });
    const p = plan.people[0]!;
    expect(p.tooSoon).toEqual(["2026-10-15", "2026-10-31", "2026-11-15"]);
    // One paycheck left, and only its take-home (800,000 − 80,000 − taxes) can go to withholding.
    const takeHome = 800_000 - 80_000 - 120_000 - 40_000 - 49_600 - 11_600;
    expect(p.federalChange).toBe(takeHome);
    expect(plan.unreachable.federal).toBe(5_000_000 - takeHome);
  });

  it("counts paychecks through the latest stub received as paid, past the stubs on file", () => {
    const base = planW4(report([pat(), alex()], 600_000, 0));
    // Pat's Oct 15 stub is in hand though the stubs on file stop at Aug 31.
    const plan = planW4(report([pat(), alex()], 600_000, 0), { paidThrough: { pat: "2026-10-15" } });
    const p = plan.people[0]!;
    expect(p).toMatchObject({ paidThrough: "2026-10-15", paidThroughEntered: true });
    expect(p.sinceStub).toEqual(["2026-09-15", "2026-09-30", "2026-10-15"]);
    expect(p.reached).toEqual(["2026-10-31", "2026-11-15", "2026-11-30"]);
    // Alex keeps today's cut; the year's balance is the same flat-lined projection either way.
    expect(plan.people[1]!.paidThroughEntered).toBe(false);
    expect(plan.people[1]!.reached).toEqual(base.people[1]!.reached);
    expect(plan.federal.balanceNow).toBe(base.federal.balanceNow);
    expect(plan.federal.withheldSinceStub).toBe(120_000 * 3 + 15_000);
    expect(Math.abs(plan.federal.balanceAfter)).toBeLessThan(10);
    // Fewer paychecks left to make it up: each takes more.
    expect(p.federalChange).toBeGreaterThan(base.people[0]!.federalChange);
  });

  it("without an entered date counts pay dates through today, and never before the stubs on file", () => {
    const today = planW4(report([pat()], 0, 0)).people[0]!;
    expect(today).toMatchObject({ paidThrough: "2026-09-30", paidThroughEntered: false });
    const early = planW4(report([pat()], 0, 0), { paidThrough: { pat: "2026-07-31" } }).people[0]!;
    expect(early.paidThrough).toBe("2026-08-31");
    expect(early.sinceStub).toEqual([]);
    expect(early.reached[0]).toBe("2026-09-15");
  });

  it("reads the filing status from the stub when no W-4 is entered", () => {
    const plan = planW4(report([pat({ status: "Single" })], 0, 0));
    expect(plan.people[0]!.onFileEntered).toBe(false);
    expect(plan.people[0]!.onFile.filingStatus).toBe("SINGLE");
  });
});
