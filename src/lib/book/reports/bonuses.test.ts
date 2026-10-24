import { describe, expect, it } from "vitest";
import type { AwardsFile } from "../../bonuses/awardStore.ts";
import { employerKey, type StubLine } from "../../ingest/payroll/types.ts";
import type { Book, BookStub } from "../load.ts";
import { Collector } from "../checks/collector.ts";
import { checkBonusLetters } from "../checks/bonuses.ts";
import type { StandingException } from "../types.ts";
import { bonusFindingId, buildBonuses, windowLabel } from "./bonuses.ts";

let n = 0;
const stub = (employer: string, payDate: string, lines: StubLine[]): BookStub =>
  ({
    id: `s${++n}`,
    documentId: `d${n}`,
    documentTitle: `stub ${payDate}`,
    importedAt: "2026-01-01T00:00:00Z",
    source: "TRINET",
    employee: "A PERSON",
    employer,
    employerKey: employerKey(employer),
    personId: "p1",
    payDate,
    periodStart: null,
    periodEnd: null,
    federalFilingStatus: null,
    lines,
    printed: { grossCurrent: null, grossYtd: null, withheldCurrent: null, withheldYtd: null, netCurrent: 0, netYtd: null },
    deposits: [],
    warnings: [],
    depositTransactionId: null,
  }) as BookStub;
// Book stub lines are in cents.
const bonus = (dollars: number): StubLine[] => [{ name: "Bonus", kind: "BONUS", current: Math.round(dollars * 100), ytd: null }];
const regular = (ytdDollars: number): StubLine[] => [{ name: "Regular", kind: "REGULAR", current: 100000, ytd: ytdDollars * 100 }];

const book = (stubs: BookStub[], bonusAwards?: AwardsFile) =>
  ({
    stubs,
    today: "2026-10-06",
    bonusAwards,
    ledger: { firstDay: "2024-01-01" },
    persons: [{ id: "p1", name: "Alex", match: [] }],
    horizon: { netWorth: "2026-09-30", cashFlow: "2026-09-30" },
    integrity: { findings: [], inferences: [], accepted: [], stale: [] },
  }) as unknown as Book;

/** The Book with its integrity checked by bonus.letters alone, against these exceptions. */
const checked = (b: Book, exceptions: StandingException[] = []): Book => {
  const c = new Collector(exceptions);
  checkBonusLetters(b, c);
  return { ...b, integrity: c.report() };
};

const OLD = "Old Firm LP";
const letter: AwardsFile = {
  version: 1,
  letters: [
    {
      id: "old",
      title: "Old Firm summary",
      employer: OLD,
      awards: [
        {
          year: 2023,
          baseSalary: 100000,
          totalBonus: 100000,
          totalComp: 200000,
          payments: [
            { kind: "UPFRONT", from: "2024-02", to: "2024-03", amount: 75000 },
            { kind: "DEFERRED", from: "2025-02", to: "2025-03", amount: 8333 },
            { kind: "DEFERRED", from: "2026-02", to: "2026-03", amount: 8333 },
            { kind: "DEFERRED", from: "2027-02", to: "2027-03", amount: 8334 },
          ],
        },
        { year: 2022, partial: true, payments: [{ kind: "DEFERRED", from: "2024-02", to: "2024-03", amount: 5000 }] },
      ],
    },
  ],
};

describe("buildBonuses", () => {
  it("matches each window's payments as a whole and forfeits what vests after leaving", () => {
    const stubs = [
      stub(OLD, "2023-12-31", regular(100000)),
      stub(OLD, "2024-03-07", bonus(79999.5)), // 75,000 up front + 5,000 older tranche, letter rounds
      stub(OLD, "2024-08-15", bonus(4000)), // nothing on the letter explains it
      stub(OLD, "2025-03-07", bonus(8333)),
      stub(OLD, "2025-04-30", regular(30000)),
      stub("New Co LLC", "2025-06-13", regular(5000)),
      stub("New Co LLC", "2026-02-03", bonus(50000)),
    ];
    const r = buildBonuses(book(stubs), letter, "2026-10-06");

    expect(r.windows.map((w) => [w.label, w.status])).toEqual([
      ["Feb/Mar 2024", "PAID"],
      ["Feb/Mar 2025", "PAID"],
      ["Feb/Mar 2026", "FORFEITED"],
      ["Feb/Mar 2027", "FORFEITED"],
    ]);
    const a2023 = r.awards.find((a) => a.year === 2023)!;
    expect(a2023).toMatchObject({ upfrontCents: 7500000, deferredCents: 2500000, forfeitedCents: 1666700, outstandingCents: 0, stubBaseCents: 10000000 });
    expect(r.totals).toMatchObject({ headlineCents: 10000000, upfrontCents: 7500000, deferredCents: 2500000, deferredPaidCents: 833300, forfeitedCents: 1666700, next: null });
    // The $4,000 and the new employer's bonus aren't explained by any letter.
    expect(r.payments.filter((p) => !p.explains).map((p) => p.amountCents)).toEqual([400000, 5000000]);
    expect(r.unlettered).toEqual([{ employer: "New Co LLC", personName: "Alex", cents: 5000000, count: 1 }]);
    expect(r.warnings).toEqual([]);
  });

  it("keeps tranches upcoming while still employed and flags a payment that differs from the letter", () => {
    const stubs = [stub(OLD, "2024-03-07", bonus(70000)), stub(OLD, "2026-09-30", regular(50000))];
    const r = buildBonuses(book(stubs), letter, "2026-10-06");
    expect(r.windows.map((w) => w.status)).toEqual(["PAID_DIFFERENT", "NOT_ON_STUBS", "NOT_ON_STUBS", "UPCOMING"]);
    expect(r.totals.next).toMatchObject({ label: "Feb/Mar 2027", amountCents: 833400 });
    expect(r.warnings.some((w) => w.text.includes("Feb/Mar 2024"))).toBe(true);
  });

  it("checks the letter adds up", () => {
    const bad: AwardsFile = { version: 1, letters: [{ ...letter.letters[0]!, awards: [{ ...letter.letters[0]!.awards[0]!, totalBonus: 110000 }] }] };
    const r = buildBonuses(book([stub(OLD, "2023-12-31", regular(100000))]), bad, "2023-12-31");
    expect(r.warnings.filter((w) => w.text.includes("doesn't add up"))).toHaveLength(2);
  });

  it("matches sign-on and make-whole payments but keeps them out of the headline bonus", () => {
    const withOneOffs: AwardsFile = {
      version: 1,
      letters: [
        {
          ...letter.letters[0]!,
          awards: [
            {
              ...letter.letters[0]!.awards[0]!,
              payments: [
                { kind: "SIGNING", from: "2023-06", to: "2023-12", amount: 10000 },
                { kind: "MAKEWHOLE", from: "2023-06", to: "2023-12", amount: 40000 },
                ...letter.letters[0]!.awards[0]!.payments,
              ],
            },
          ],
        },
      ],
    };
    const stubs = [stub(OLD, "2023-06-30", bonus(10000)), stub(OLD, "2023-09-06", bonus(40000)), stub(OLD, "2026-09-30", regular(50000))];
    const r = buildBonuses(book(stubs), withOneOffs, "2026-10-06");
    expect(r.windows[0]).toMatchObject({ label: "Jun/Dec 2023", status: "PAID", scheduledCents: 5000000, paidCents: 5000000 });
    expect(r.awards[0]).toMatchObject({ upfrontCents: 7500000, deferredCents: 2500000, oneOffCents: 5000000 });
    expect(r.totals.headlineCents).toBe(10000000);
    expect(r.warnings.filter((w) => w.text.includes("doesn't add up"))).toEqual([]);
  });

  it("counts a plan deferral toward the headline bonus without a vest window", () => {
    const plan: AwardsFile = {
      version: 1,
      letters: [
        {
          id: "new",
          title: "New Co letter",
          employer: "New Co LLC",
          awards: [{ year: 2025, totalBonus: 230000, planDeferral: 20000, payments: [{ kind: "UPFRONT", from: "2026-01", to: "2026-02", amount: 210000 }] }],
        },
      ],
    };
    const r = buildBonuses(book([stub("New Co LLC", "2026-02-03", bonus(210000)), stub("New Co LLC", "2026-09-30", regular(50000))]), plan, "2026-10-06");
    expect(r.awards[0]).toMatchObject({ upfrontCents: 21000000, deferredCents: 0, planDeferredCents: 2000000 });
    expect(r.windows.map((w) => w.status)).toEqual(["PAID"]);
    expect(r.warnings).toEqual([]);
    const short = { ...plan, letters: [{ ...plan.letters[0]!, awards: [{ ...plan.letters[0]!.awards[0]!, planDeferral: null }] }] };
    expect(buildBonuses(book([]), short, "2026-10-06").warnings.map((w) => w.gapCents)).toContain(-2000000);
  });

  it("lists an employer that pays bonuses without letters apart from the unexplained ones", () => {
    const file: AwardsFile = { ...letter, stubOnly: [{ employer: "New Co LLC", note: "Gross on the stub" }] };
    const stubs = [stub("New Co LLC", "2026-02-03", bonus(5000)), stub("Other Inc", "2026-03-03", bonus(1000))];
    const r = buildBonuses(book(stubs), file, "2026-10-06");
    expect(r.stubOnly).toEqual([{ employer: "New Co LLC", personName: "Alex", cents: 500000, count: 1, note: "Gross on the stub" }]);
    expect(r.unlettered).toEqual([{ employer: "Other Inc", personName: "Alex", cents: 100000, count: 1 }]);
  });

  it("takes base from every employer's stubs that year when the letter prints none, and sums total comp", () => {
    const noBase: AwardsFile = { version: 1, letters: [{ ...letter.letters[0]!, awards: [{ ...letter.letters[0]!.awards[0]!, baseSalary: null, totalComp: null }] }] };
    const stubs = [stub("Prior Co", "2023-03-31", regular(20000)), stub(OLD, "2023-12-31", regular(100000))];
    const a = buildBonuses(book(stubs), noBase, "2026-10-06").awards[0]!;
    expect(a.base).toEqual({ cents: 12000000, from: "STUBS", parts: [{ employer: "Prior Co", cents: 2000000 }, { employer: OLD, cents: 10000000 }] });
    expect(a.totalComp).toEqual({ cents: 22000000, from: "SUM" });
    const lettered = buildBonuses(book(stubs), letter, "2026-10-06").awards.find((x) => x.year === 2023)!;
    expect(lettered).toMatchObject({ base: { cents: 10000000, from: "LETTER" }, totalComp: { cents: 20000000, from: "LETTER" } });
  });

  it("gives base and bonus by year for people paid by a stub-only employer", () => {
    const file: AwardsFile = { version: 1, letters: [], stubOnly: [{ employer: "New Co LLC" }] };
    const withBonus = (ytdRegular: number, ytdBonus: number): StubLine[] => [...regular(ytdRegular), { name: "Bonus", kind: "BONUS", current: 0, ytd: ytdBonus * 100 }];
    const stubs = [stub("New Co LLC", "2025-06-30", withBonus(40000, 5000)), stub("New Co LLC", "2026-03-31", withBonus(20000, 0))];
    const r = buildBonuses(book(stubs), file, "2026-10-06");
    expect(r.payYears.map((y) => [y.year, y.baseCents, y.bonusCents, y.last, y.inProgress])).toEqual([
      [2026, 2000000, 0, "2026-03-31", true],
      [2025, 4000000, 500000, "2025-06-30", false],
    ]);
  });

  it("raises each warning as a bonus.letters finding; an exception hides it only while its gap is the one accepted", () => {
    const stubs = [stub(OLD, "2024-03-07", bonus(80033)), stub(OLD, "2025-03-07", bonus(8333)), stub(OLD, "2026-09-30", regular(50000))];
    const open = checked(book(stubs, letter));
    const w = buildBonuses(open, letter, "2026-10-06").warnings.find((x) => x.text.startsWith("Feb/Mar 2024"))!;
    expect(w).toMatchObject({ id: "old|2024-02|2024-03|paid", gapCents: 3300, from: expect.any(String), to: expect.any(String) });
    expect(open.integrity.findings.find((f) => f.id === bonusFindingId(w))).toMatchObject({ check: "bonus.letters", status: "FAIL", scope: { affects: ["BONUS"] } });

    const ex: StandingException = { id: bonusFindingId(w), check: "bonus.letters", note: "Rounding in my favor", acceptedAt: "2026-10-06T00:00:00.000Z", finding: { status: "FAIL", title: w.text, detail: "", scope: { from: w.from, to: w.to, affects: ["BONUS"] } } };
    const reviewed = buildBonuses(checked(book(stubs, letter), [ex]), letter, "2026-10-06");
    expect(reviewed.warnings.map((x) => x.id)).not.toContain(w.id);
    expect(reviewed.reviewed).toEqual([{ ...w, note: "Rounding in my favor", reviewedAt: ex.acceptedAt }]);
    expect(reviewed.staleReviews).toEqual([]);

    // The stubs change: the gap is no longer the one accepted, so the warning opens again and the exception goes stale.
    const changed = [stub(OLD, "2024-03-07", bonus(80100)), ...stubs.slice(1)];
    const reopened = buildBonuses(checked(book(changed, letter), [ex]), letter, "2026-10-06");
    expect(reopened.warnings.find((x) => x.id === w.id)).toMatchObject({ gapCents: 10000 });
    expect(reopened.reviewed).toEqual([]);
    expect(reopened.staleReviews).toEqual([{ id: ex.id, warning: w.text, note: ex.note, reviewedAt: ex.acceptedAt }]);
  });

  it("labels windows the way letters do", () => {
    expect(windowLabel("2025-02", "2025-03")).toBe("Feb/Mar 2025");
    expect(windowLabel("2024-07", "2024-07")).toBe("Jul 2024");
    expect(windowLabel("2024-12", "2025-01")).toBe("Dec 2024/Jan 2025");
  });
});
