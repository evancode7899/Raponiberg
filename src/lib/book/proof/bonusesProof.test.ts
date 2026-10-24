import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AwardsFile } from "../../bonuses/awardStore";
import type { BonusReview } from "../../bonuses/reviewStore";
import { buildForecast } from "../../forecast/forecast";
import { bonusFacts } from "../../forecast/bonusSchedule";
import { NO_HOUSEHOLD } from "../../household/patterns";
import { employerKey, type StubLine } from "../../ingest/payroll/types";
import type { OutlookSeeds } from "../../profile/basePay";
import { DEFAULT_OUTLOOK } from "../../profile/settings";
import { taxYearParams } from "../../tax/params";
import type { Book, BookStub } from "../load";
import { personPayYear } from "../pay";
import { buildBonuses, type BonusesReport } from "../reports/bonuses";
import { buildEstimateProof, type BonusesDescriptor } from "./bonusesProof";
import { bonusesFigures } from "./figures";
import { buildProof, parseDescriptor, type Proof, type ProofLink } from "./index";

// An invented household: Pat Example, paid monthly by Example Partners LP, with one award
// letter (the 2024 award: cash up front, three deferred tranches and a deferred comp plan
// part). Every name and amount is made up.

const EMPLOYER = "Example Partners LP";
const TODAY = "2026-01-20";

let n = 0;
function stub(payDate: string, bonus = 0): BookStub {
  const ytdOf = (k: "regular" | "bonus") => STUBS.filter((s) => s.payDate.slice(0, 4) === payDate.slice(0, 4) && s.payDate <= payDate).reduce((t, s) => t + (k === "regular" ? 400_000 : s.bonus), 0);
  const line = (name: string, kind: StubLine["kind"], current: number, ytd: number): StubLine => ({ name, kind, current: current || null, ytd });
  const regular = 400_000;
  const net = regular + bonus;
  return {
    id: `s${++n}`,
    documentId: `d${n}`,
    documentTitle: `stub ${payDate}.pdf`,
    importedAt: "2026-01-05T00:00:00Z",
    source: "TRINET",
    employee: "PAT EXAMPLE",
    employer: EMPLOYER,
    employerKey: employerKey(EMPLOYER),
    personId: "pat",
    payDate,
    periodStart: null,
    periodEnd: null,
    federalFilingStatus: null,
    lines: [line("Regular Salary", "REGULAR", regular, ytdOf("regular")), line("Annual Bonus", "BONUS", bonus, ytdOf("bonus"))],
    printed: { grossCurrent: null, grossYtd: null, withheldCurrent: null, withheldYtd: null, netCurrent: net, netYtd: null },
    deposits: [],
    warnings: [],
    depositTransactionId: null,
  } as unknown as BookStub;
}

/** Monthly pay on the 15th, 2024–2025. Bonuses: Mar 2024 (before the letter), Mar 2025 (the cash, exact), Aug 2025 ($67 over the tranche), Dec 2025 (on no letter). */
const BONUS: Record<string, number> = { "2024-03-15": 2_500_000, "2025-03-15": 3_000_000, "2025-08-15": 306_700, "2025-12-15": 100_000 };
const STUBS: { payDate: string; bonus: number }[] = [2024, 2025].flatMap((y) =>
  Array.from({ length: 12 }, (_, i) => {
    const payDate = `${y}-${String(i + 1).padStart(2, "0")}-15`;
    return { payDate, bonus: BONUS[payDate] ?? 0 };
  }),
);

function makeBook(): Book {
  n = 0;
  const stubs = STUBS.map((s) => stub(s.payDate, s.bonus));
  return {
    today: TODAY,
    horizon: { cashFlow: "2025-12-31", netWorth: "2025-12-31" },
    ledger: { accounts: [], mergeDate: "2024-01-01", completeThrough: null, firstDay: "2024-01-01" },
    accounts: [],
    statements: [],
    rows: [],
    rowById: new Map(),
    stubs,
    brokerage: [],
    holdings: [],
    matches: [],
    documents: [],
    decisions: { version: 1, confirmed: [], rejected: [] },
    classifiedWith: null,
    household: NO_HOUSEHOLD,
    classifiedWithHousehold: null,
    taxProfile: { version: 1, persons: [], dependents: [], accountOwners: {}, accountKinds: {}, qualifiedDividendShare: 1, moneyMarketUsGovShare: 0, mfsDependentClaimant: "AUTO", years: {} },
    taxDocs: null,
    persons: [{ id: "pat", name: "Pat Example", match: ["PAT"] }],
    idle: { proven: [], unproven: [] },
    integrity: { checks: [], findings: [], inferences: [], accepted: [], stale: [], retired: [] },
    passes: [],
  } as unknown as Book;
}

const AWARDS: AwardsFile = {
  version: 1,
  letters: [
    {
      id: "ex",
      title: "Example Partners 2024 award letter",
      employer: EMPLOYER,
      terms: "Unvested deferrals are forfeited on leaving.",
      awards: [
        {
          year: 2024,
          baseSalary: 48_000,
          totalBonus: 40_000,
          planDeferral: 2_000,
          payments: [
            { kind: "UPFRONT", from: "2025-02", to: "2025-03", amount: 30_000 },
            { kind: "DEFERRED", from: "2025-08", to: "2025-08", amount: 3_000 },
            { kind: "DEFERRED", from: "2026-02", to: "2026-03", amount: 3_000 },
            { kind: "DEFERRED", from: "2026-07", to: "2026-08", amount: 2_000 },
          ],
        },
      ],
    },
  ],
  stubOnly: [],
};

const REVIEW: BonusReview = { id: "ex|2025-08|2025-08|paid", gapCents: 6_700, warning: "Aug 2025 paid more than scheduled", note: "Employer rounding, in my favor", reviewedAt: "2026-01-10T12:00:00.000Z" };

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "bonuses-proof-"));
  const awards = path.join(dir, "bonus-awards.json");
  const reviews = path.join(dir, "bonus-awards.reviews.json");
  writeFileSync(awards, JSON.stringify(AWARDS));
  writeFileSync(reviews, JSON.stringify({ version: 1, reviews: [REVIEW], reopened: [] }));
  process.env.BONUS_AWARDS_FILE = awards;
  process.env.BONUS_REVIEWS_FILE = reviews;
});
afterAll(() => {
  delete process.env.BONUS_AWARDS_FILE;
  delete process.env.BONUS_REVIEWS_FILE;
  rmSync(dir, { recursive: true, force: true });
});

const report = (book: Book) => buildBonuses(book, AWARDS, TODAY, [REVIEW]);
const ctx = (book: Book) => ({ book, db: {} as never });
const bon = (d: Record<string, unknown>) => ({ report: "bonuses", ...d }) as BonusesDescriptor;
const cents = (p: Proof) => ("cents" in p.figure ? p.figure.cents : NaN);
const links = (p: Proof): ProofLink[] =>
  p.blocks.flatMap((b) => (b.kind === "breakdown" ? b.items.flatMap((i) => (i.link ? [i.link] : [])) : b.kind === "chain" ? b.lines.flatMap((l) => (l.link ? [l.link] : [])) : []));
const chainLines = (p: Proof) => p.blocks.flatMap((b) => (b.kind === "chain" ? b.lines : []));

/** Every figure the Bonuses page wires to this kind, with the value the page shows. */
/** Every figure the Bonuses page shows (figures.ts, the list the live sweep walks too). */
const pageFigures = (r: BonusesReport): [BonusesDescriptor, number][] => bonusesFigures(r).map((f) => [f.descriptor as BonusesDescriptor, f.shown && "cents" in f.shown ? f.shown.cents : NaN]);

describe("the bonuses proof kind", () => {
  it("the fixture exercises every status the proofs explain", () => {
    const r = report(makeBook());
    expect(r.windows.map((w) => [w.label, w.status])).toEqual([
      ["Feb/Mar 2025", "PAID"],
      ["Aug 2025", "PAID_DIFFERENT"],
      ["Feb/Mar 2026", "DUE"],
      ["Jul/Aug 2026", "UPCOMING"],
    ]);
    expect(r.reviewed.map((w) => w.id)).toEqual([REVIEW.id]);
  });

  it("re-derives every figure the page shows, each re-adding on its own", async () => {
    const book = makeBook();
    const figures = pageFigures(report(book));
    expect(figures.length).toBe(30);
    for (const [d, shown] of figures) {
      const parsed = parseDescriptor(JSON.parse(JSON.stringify(d)));
      expect(parsed, JSON.stringify(d)).not.toHaveProperty("error");
      const p = await buildProof(ctx(book), parsed as BonusesDescriptor);
      expect(cents(p), JSON.stringify(d)).toBe(shown);
      expect(p.selfCheck?.ok, `${JSON.stringify(d)}: ${p.selfCheck?.explain}`).toBe(true);
    }
  });

  it("emits links that parse and build, bonus links re-adding and pay links matching the stubs", async () => {
    const book = makeBook();
    let followed = 0;
    for (const [d] of pageFigures(report(book))) {
      for (const l of links(await buildProof(ctx(book), d))) {
        const parsed = parseDescriptor(JSON.parse(JSON.stringify(l.descriptor)));
        expect(parsed, l.label).not.toHaveProperty("error");
        const q = await buildProof(ctx(book), parsed as BonusesDescriptor);
        expect(q.selfCheck?.ok, l.label).toBe(true);
        followed++;
      }
    }
    expect(followed).toBeGreaterThan(20);
  });

  it("a scheduled payment names the letter, links paid tranches to the stub that paid them, and marks what's still to come as estimates", async () => {
    const book = makeBook();
    const p = await buildProof(ctx(book), bon({ figure: "award", letterId: "ex", year: 2024, measure: "scheduled" }));
    const lines = chainLines(p);
    expect(lines[0]).toMatchObject({ label: "Award letter: Example Partners 2024 award letter", source: "proven" });
    const cash = lines.find((l) => l.label.includes("Up-front cash"))!;
    expect(cash.source).toBe("proven");
    expect(cash.link?.descriptor).toEqual({ report: "pay", basis: "paid", personId: "pat", employerKeys: [employerKey(EMPLOYER)], lines: ["bonus"], start: "2025-03-15", end: "2025-03-15" });
    const future = lines.filter((l) => l.source === "estimate" && l.op !== "=");
    expect(future.map((l) => l.label)).toEqual(["2024 award · Deferred tranche, Feb/Mar 2026", "2024 award · Deferred tranche, Jul/Aug 2026"]);
    expect(future[1]!.note).toMatch(/^Scheduled 2026-07-01 – 2026-08-31/);
    expect(p.estimates.length).toBe(2);
  });

  it("names the deferred comp plan part and says it isn't in any tracked account", async () => {
    const p = await buildProof(ctx(makeBook()), bon({ figure: "award", letterId: "ex", year: 2024, measure: "deferred" }));
    const plan = chainLines(p).find((l) => l.label.includes("deferred compensation plan"))!;
    expect(plan.value).toEqual({ cents: 200_000 });
    expect(plan.note).toMatch(/isn't in any tracked account/);
    expect(cents(p)).toBe(800_000 + 200_000);
  });

  it("shows a payment that differs from the letter, with the owner's review note and date", async () => {
    const r = report(makeBook());
    const aug = r.windows.find((w) => w.label === "Aug 2025")!;
    const p = await buildProof(ctx(makeBook()), bon({ figure: "window", window: aug.key, measure: "paid" }));
    expect(cents(p)).toBe(306_700);
    const reviewed = p.blocks.find((b) => b.title === "Warnings you reviewed");
    expect(reviewed?.kind === "breakdown" && reviewed.items[0]).toMatchObject({ value: { cents: 6_700 }, sub: "Reviewed 2026-01-10: “Employer rounding, in my favor”" });
    const diff = p.blocks.find((b) => b.title === "Against the letter");
    expect(diff?.kind === "chain" && diff.lines.at(-1)!.value).toEqual({ cents: 6_700 });
  });

  it("reconciles a year's bonus paychecks: what a letter explains and what it doesn't, each linking to its stub", async () => {
    const book = makeBook();
    const r = report(book);
    const y = r.byYear.find((x) => x.year === 2025)!;
    const p = await buildProof(ctx(book), bon({ figure: "reconcile", year: 2025, personId: "pat", employer: y.employer }));
    expect(cents(p)).toBe(3_000_000 + 306_700);
    const not = p.blocks.find((b) => b.title === "Not on any letter");
    expect(not?.kind === "chain" && not.lines.map((l) => [l.label, l.value, l.link?.descriptor.report])).toEqual([
      ["2025-12-15 stub", { cents: 100_000 }, "pay"],
      ["Not explained by a letter", { cents: 100_000 }, undefined],
    ]);
    const total = p.blocks.at(-2)?.kind === "chain" ? p.blocks.find((b) => b.title.endsWith("bonus paid in 2025")) : null;
    expect(total?.kind === "chain" && total.lines.at(-1)!.value).toEqual({ cents: y.cents });
    expect(p.blocks.some((b) => b.title === "Warnings you reviewed")).toBe(true);
  });

  it("answers a figure that no longer exists without throwing", async () => {
    const p = await buildProof(ctx(makeBook()), bon({ figure: "window", window: "gone|2020-01|2020-01", measure: "paid" }));
    expect(p.figure).toEqual({ text: "—" });
  });

  it("rejects malformed descriptors", () => {
    expect(parseDescriptor({ report: "bonuses", figure: "award", letterId: "ex", year: 2024, measure: "nope" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "bonuses", figure: "estimate", personId: "pat", awardYear: 2025, month: "2026-3", part: "x" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "bonuses" })).toHaveProperty("error");
  });
});

describe("an estimated bonus", () => {
  const book = makeBook();
  const r = report(book);
  const facts = bonusFacts(r, AWARDS.letters);
  const py = (year: number) => personPayYear(book, "pat", year).totals;
  const history = [2024, 2025].map((year) => ({ year, salary: py(year).salary, bonus: py(year).bonus, pct: py(year).bonus / py(year).salary, partial: false }));
  const fp = taxYearParams(2026).federal;
  const seeds: OutlookSeeds = {
    start: { asOf: "2025-12-31", year: 2025, month: 12, liquid: 100_000_00, illiquid: 50_000_00, note: "" },
    baseYear: 2025,
    currentYear: 2026,
    people: [
      {
        personId: "pat",
        name: "Pat Example",
        employer: EMPLOYER,
        perYear: 12,
        frequency: "MONTHLY",
        latest: { payDate: "2025-12-15", regular: 400_000, section125: 0, hsa: 0, afterTax: 0, employer: 0 },
        typical: { payDate: "2025-12-15", regular: 400_000, section125: 0, hsa: 0, afterTax: 0, employer: 0 },
        deferrals: { LATEST: { k401Pretax: 0, k401Roth: 0, hsa: 0 }, TYPICAL: { k401Pretax: 0, k401Roth: 0, hsa: 0 } },
        bonusHistory: history,
        bonusMonth: 3,
        bonusesSinceStart: [],
        note: "",
      },
    ],
    living: { TRAILING_12: { cents: 30_000_00, label: "Last 12 months", detail: "" } },
    realizedReturn: null,
    taxYear: 2026,
    tax: { year: 2026, standardDeduction: fp.standardDeduction.MFJ, brackets: fp.brackets.MFJ },
    dependents: [],
    birthYear: 1990,
  };
  const forecast = buildForecast({ seeds, bonusFacts: facts }, { ...DEFAULT_OUTLOOK, horizonYear: 2030, salaryGrowth: 0.03 });
  const estimates = forecast.schedule.filter((b) => b.source === "ESTIMATE" && (b.awardYear === 2025 || b.awardYear === 2027));
  const descriptor = (b: (typeof estimates)[number]) => bon({ figure: "estimate", personId: "pat", awardYear: b.awardYear, month: b.key, part: b.label.split(" · ").slice(1).join(" · ") }) as Extract<BonusesDescriptor, { figure: "estimate" }>;

  it("re-adds from the past bonuses through the arithmetic, the plan part named as untracked", async () => {
    expect(estimates.length).toBeGreaterThan(4);
    for (const b of estimates) {
      const p = buildEstimateProof(book, { forecast, seeds, facts }, descriptor(b));
      expect(cents(p), b.label).toBe(b.gross);
      expect(p.selfCheck?.ok, `${b.label}: ${p.selfCheck?.explain}`).toBe(true);
      const lines = chainLines(p);
      expect(lines.filter((l) => l.label.endsWith(" bonus") && l.source === "proven").map((l) => l.value)).toEqual(history.map((h) => ({ cents: h.bonus })));
      expect(lines.at(-1)!.source).toBe("estimate");
      if (b.awardYear === 2027) expect(lines.find((l) => l.label.startsWith("Salary growth"))).toMatchObject({ source: "assumption", value: { ratio: 1.03 ** 2 } });
      if (b.label.includes("deferred comp plan")) expect(lines.at(-1)!.note).toMatch(/isn't in any tracked account/);
      for (const l of links(p)) {
        const parsed = parseDescriptor(JSON.parse(JSON.stringify(l.descriptor)));
        expect(parsed, l.label).not.toHaveProperty("error");
        const q = await buildProof(ctx(book), parsed as BonusesDescriptor);
        expect(q.selfCheck?.ok, l.label).toBe(true);
        if (l.label.includes("· bonus ")) expect(cents(q)).toBe(history.find((h) => l.label.endsWith(String(h.year)))!.bonus);
      }
    }
  });

  it("marks a typed bonus share as your assumption", () => {
    const typed = buildForecast({ seeds, bonusFacts: facts }, { ...DEFAULT_OUTLOOK, horizonYear: 2030, people: { pat: { paycheck: "TYPICAL", salary: null, bonusPct: 0.5 } } });
    const b = typed.schedule.find((x) => x.source === "ESTIMATE" && x.awardYear === 2025)!;
    const p = buildEstimateProof(book, { forecast: typed, seeds, facts }, descriptor(b));
    expect(p.selfCheck?.ok).toBe(true);
    expect(chainLines(p).find((l) => l.label === "Bonus ÷ base salary")).toMatchObject({ source: "assumption", value: { ratio: 0.5 } });
  });
});
