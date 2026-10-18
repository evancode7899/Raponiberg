import { describe, expect, it } from "vitest";
import type { AwardsFile } from "../../bonuses/awardStore";
import { NO_HOUSEHOLD } from "../../household/patterns";
import { employerKey, type StubLine } from "../../ingest/payroll/types";
import { stubRef } from "../findingKeys";
import type { Book, BookRow, BookStatement, BookStub } from "../load";
import { personPayYear } from "../pay";
import { buildBonuses } from "../reports/bonuses";
import type { CheckPass, Finding, Inference } from "../types";
import { buildProof, parseDescriptor, type Proof, type ProofLink } from "./index";
import { buildPayProof, type PayDescriptor, type PayLine } from "./payProof";

// An invented household: Pat Example, paid by Example Partners LP into checking ••1234 at
// Springfield Bank, then by Sample Labs Inc from September 2025. Every name and amount is made up.

const OLD = "Example Partners LP";
const NEW = "Sample Labs Inc";

const STATEMENTS: BookStatement[] = Array.from({ length: 12 }, (_, i) => {
  const m = String(i + 1).padStart(2, "0");
  const end = new Date(Date.UTC(2025, i + 1, 0)).toISOString().slice(0, 10);
  return {
    id: `st-chk-2025-${m}`,
    accountId: "chk",
    documentId: `doc-chk-2025-${m}`,
    documentTitle: `checking-2025-${m}.pdf`,
    importedAt: "2026-01-05T00:00:00.000Z",
    status: "COMMITTED" as const,
    isSummary: false,
    periodStart: `2025-${m}-01`,
    periodEnd: end,
    deltaCents: 0,
  };
});

type Check = { regular: number; bonus?: number; reimb?: number; fed: number; k401: number; hsa?: number; health?: number };

let n = 0;
/**
 * A year of stubs from one employer, year to date carried from check to check (plus
 * `carriedIn` of each line earned before the first stub), each deposited to checking.
 * `skip`: pay dates with a paycheck deposited but no stub on file.
 */
function chain(employer: string, checks: [string, Check][], opts: { carriedIn?: Check; skip?: string[]; personId?: string | null } = {}) {
  const ytd: Required<Check> = { regular: 0, bonus: 0, reimb: 0, fed: 0, k401: 0, hsa: 0, health: 0, ...opts.carriedIn };
  const stubs: BookStub[] = [];
  const rows: BookRow[] = [];
  for (const [payDate, c] of checks) {
    const cur: Required<Check> = { bonus: 0, reimb: 0, hsa: 0, health: 0, ...c };
    for (const k of Object.keys(ytd) as (keyof Check)[]) ytd[k] += cur[k];
    const net = cur.regular + cur.bonus + cur.reimb - cur.fed - cur.k401 - cur.hsa - cur.health;
    const deposit = row(payDate, net, employer);
    rows.push(deposit);
    if (opts.skip?.includes(payDate)) continue;
    const line = (name: string, kind: StubLine["kind"], k: keyof Check): StubLine => ({ name, kind, current: cur[k] || null, ytd: ytd[k] });
    const lines = [
      line("Regular Salary", "REGULAR", "regular"),
      line("Annual Bonus", "BONUS", "bonus"),
      line("Expense Reimbursement", "NONTAXABLE", "reimb"),
      line("Federal Income Tax", "FEDERAL_TAX", "fed"),
      line("401(k)", "RETIREMENT_PRETAX", "k401"),
      line("HSA", "HSA", "hsa"),
      line("Medical", "SECTION125", "health"),
    ];
    const netYtd = ytd.regular + ytd.bonus + ytd.reimb - ytd.fed - ytd.k401 - ytd.hsa - ytd.health;
    stubs.push({
      id: `s${++n}`,
      documentId: `d${n}`,
      documentTitle: `stub ${payDate}.pdf`,
      importedAt: "2026-01-05T00:00:00Z",
      source: "TRINET",
      employee: "PAT EXAMPLE",
      employer,
      employerKey: employerKey(employer),
      personId: opts.personId === undefined ? "pat" : opts.personId,
      payDate,
      periodStart: null,
      periodEnd: null,
      federalFilingStatus: null,
      lines,
      printed: { grossCurrent: null, grossYtd: null, withheldCurrent: null, withheldYtd: null, netCurrent: net, netYtd },
      deposits: [{ last4: "1234", amount: net }],
      warnings: [],
      depositTransactionId: deposit.id,
    });
  }
  return { stubs, rows };
}

function row(date: string, cents: number, employer: string): BookRow {
  const st = STATEMENTS.find((s) => s.periodStart <= date && date <= s.periodEnd)!;
  const payee = `${employer.toUpperCase()} PAYROLL`;
  return {
    id: `r${++n}`,
    date,
    precision: "EXACT",
    statement: { start: st.periodStart, end: st.periodEnd },
    bookedOn: date,
    amountCents: cents,
    lane: "INCOME",
    accountId: "chk",
    payee,
    merchantKey: payee,
    category: "Paycheck",
    categoryGroup: null,
    counterpartyKind: null,
    counterpartyInstitution: null,
    counterpartyAccountHint: null,
    classifiedBy: null,
    transferMatchId: null,
    statementImportId: st.id,
    documentId: st.documentId,
  };
}

function makeBook(parts: { stubs: BookStub[]; rows: BookRow[] }[], extra: Partial<Pick<Book, "passes" | "integrity">> = {}): Book {
  const stubs = parts.flatMap((p) => p.stubs);
  const rows = parts.flatMap((p) => p.rows);
  return {
    today: "2026-01-20",
    horizon: { cashFlow: "2025-12-31", netWorth: "2025-12-31" },
    ledger: { accounts: [], mergeDate: "2024-12-01", completeThrough: null, firstDay: "2025-01-01" },
    accounts: [{ id: "chk", name: "Pat's checking ••1234", subtype: "CHECKING", type: "CHECKING", institution: "Springfield Bank", group: "Cash", identifiers: [] }],
    statements: STATEMENTS,
    rows,
    rowById: new Map(rows.map((r) => [r.id, r])),
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
    ...extra,
  } as unknown as Book;
}

const base: Check = { regular: 400_000, fed: 60_000, k401: 40_000, hsa: 5_000, health: 9_000 };

/** Pat's 2025: Example Partners Jan – Aug (bonus in March, a stub missing in June), Sample Labs from September. */
function household() {
  n = 0;
  const old = chain(
    OLD,
    [
      ["2025-01-15", base],
      ["2025-02-14", base],
      ["2025-03-14", { ...base, bonus: 1_250_000, fed: 340_000, reimb: 12_345 }],
      ["2025-04-15", base],
      ["2025-05-15", base],
      ["2025-06-13", base],
      ["2025-07-15", base],
      ["2025-08-15", { ...base, bonus: 50_000, fed: 70_000 }],
    ],
    { skip: ["2025-06-13"] },
  );
  // The new job's earliest stubs aren't on file: the first one carries September's pay.
  const fresh = chain(
    NEW,
    [
      ["2025-10-31", { regular: 520_000, fed: 90_000, k401: 52_000 }],
      ["2025-11-28", { regular: 520_000, fed: 90_000, k401: 52_000 }],
      ["2025-12-31", { regular: 520_000, bonus: 300_000, fed: 160_000, k401: 52_000 }],
    ],
    { carriedIn: { regular: 520_000, fed: 90_000, k401: 52_000 } },
  );
  return [old, fresh];
}

/** The inferences the pay.continuity check makes for the household above. */
function inferences(book: Book): Inference[] {
  const july = book.stubs.find((s) => s.payDate === "2025-07-15")!;
  const oct = book.stubs.find((s) => s.payDate === "2025-10-31")!;
  return [
    { id: `pay.continuity:${stubRef(july)}`, check: "pay.continuity", title: `Pat Example · ${OLD} 2025: 1 paycheck(s) between 2025-05-15 and 2025-07-15 have no stub`, detail: "Inferred from the year to date and the June deposit." },
    {
      id: `pay.continuity:${stubRef(oct)}`,
      check: "pay.continuity",
      partial: true,
      title: `Pat Example · ${NEW} 2025: pay before 2025-10-31 is known only from year-to-date totals (partial)`,
      detail: "The first stub on file already shows earlier pay.",
      scope: { personId: "pat", employerKey: employerKey(NEW), from: "2025-01-01", to: "2025-10-30" },
    },
  ];
}

function bookWith(extra: Partial<Pick<Book, "passes" | "integrity">> = {}) {
  const b = makeBook(household(), extra);
  b.integrity.inferences.push(...inferences(b));
  return b;
}

const ytd = (x: Partial<PayDescriptor>): PayDescriptor => ({ report: "pay", basis: "ytd", personId: "pat", lines: ["base"], year: 2025, ...x });
const paid = (x: Partial<PayDescriptor>): PayDescriptor => ({ report: "pay", basis: "paid", personId: "pat", lines: ["bonus"], start: "2025-01-01", end: "2025-12-31", ...x });
const cents = (p: Proof) => ("cents" in p.figure ? p.figure.cents : NaN);

describe("buildPayProof", () => {
  it("re-adds every year figure the pay module reads off the stubs, exactly", () => {
    const book = bookWith();
    const py = personPayYear(book, "pat", 2025);
    const sum = (f: (a: (typeof py.employers)[number]["ytd"]) => number) => py.employers.reduce((t, e) => t + f(e.ytd), 0);
    const want: Record<PayLine, number> = {
      base: py.totals.salary,
      bonus: py.totals.bonus,
      gross: py.totals.salary + py.totals.bonus + py.totals.reimbursements,
      net: py.totals.net,
      deferrals: py.totals.deferrals,
      k401: sum((a) => a.retirementPretax + a.retirementRoth),
      hsa: sum((a) => a.hsa),
      "employer-k401": sum((a) => a.employerRetirement),
      "employer-hsa": sum((a) => a.employerHsa),
    };
    for (const l of Object.keys(want) as PayLine[]) {
      const p = buildPayProof(book, ytd({ lines: [l] }));
      expect(cents(p), l).toBe(want[l]);
      expect(p.selfCheck, l).toMatchObject({ ok: true, deltaCents: 0 });
    }
    expect(cents(buildPayProof(book, ytd({ lines: ["base", "bonus"] })))).toBe(want.base + want.bonus);
  });

  it("cuts a year at `through` the way the annual profile does", () => {
    const book = bookWith();
    const py = personPayYear(book, "pat", 2025, "2025-05-31");
    const p = buildPayProof(book, ytd({ through: "2025-05-31", lines: ["base", "bonus"] }));
    expect(cents(p)).toBe(py.totals.salary + py.totals.bonus);
    expect(p.selfCheck?.ok).toBe(true);
    expect(p.through).toBe("2025-05-15");
    expect(p.describes).toContain("2025 through 2025-05-31");
  });

  it("lists each stub's check, and the year-to-date jumps as estimates: a missing stub, and pay before the first stub (partial)", () => {
    const book = bookWith();
    const p = buildPayProof(book, ytd({}));
    const chains = p.blocks.filter((b) => b.kind === "chain");
    expect(chains.map((b) => b.title)).toEqual([`${OLD}, 2025`, `${NEW}, 2025`]);
    const [old, fresh] = chains.map((b) => (b.kind === "chain" ? b.lines : []));
    const missing = old!.filter((l) => l.source === "estimate");
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ label: "Before 2025-07-15: paychecks with no stub", value: { cents: 400_000 } });
    expect(missing[0]!.note).toContain("1 paycheck(s) between 2025-05-15 and 2025-07-15");
    const carried = fresh!.find((l) => l.source === "estimate")!;
    expect(carried).toMatchObject({ label: "Before 2025-10-31: pay with no stub on file", value: { cents: 520_000 } });
    expect(carried.note).toContain("(partial)");
    expect(p.describes).toBe("Pat Example · Base pay, 2025 (partial)");
    expect(p.estimates.map((e) => e.id).sort()).toEqual(inferences(book).map((i) => i.id).sort());
    expect(p.selfCheck?.explain).toMatch(/^The 10 stubs below add up to \$[\d,.]+, and \$9,200\.00 more is in their year-to-date figures only/);
    // Each stub line names the stub's lines and its deposit.
    const march = old!.find((l) => l.label === "2025-03-14 stub")!;
    expect(march.note).toContain("Regular Salary $4,000.00");
    expect(march.note).toContain("deposited 2025-03-14");
    expect(march.note).toContain("Pat's checking ••1234");
  });

  it("matches the Bonuses page: base and bonus by year, and bonus cash paid by year", () => {
    const book = bookWith();
    const file: AwardsFile = { version: 1, letters: [], stubOnly: [{ employer: OLD }, { employer: NEW }] };
    const r = buildBonuses(book, file, "2026-01-20");
    const y = r.payYears.find((x) => x.year === 2025)!;
    expect(cents(buildPayProof(book, ytd({ lines: ["base"] })))).toBe(y.baseCents);
    expect(cents(buildPayProof(book, ytd({ lines: ["bonus"] })))).toBe(y.bonusCents);
    expect(cents(buildPayProof(book, ytd({ lines: ["base", "bonus"] })))).toBe(y.baseCents + y.bonusCents);
    for (const b of r.byYear) {
      const p = buildPayProof(book, paid({ personId: b.personId, employerKeys: b.employerKeys, start: `${b.year}-01-01`, end: `${b.year}-12-31` }));
      expect(cents(p), b.employer).toBe(b.cents);
      expect(p.selfCheck?.ok).toBe(true);
      expect(p.describes).toBe(`Pat Example · Bonus, paid in 2025 · ${b.employer}`);
    }
  });

  it("lists only the checks that pay part of the figure, and their deposits", () => {
    const book = bookWith();
    const p = buildPayProof(book, ytd({ lines: ["bonus"], employerKeys: [employerKey(OLD)] }));
    const chain = p.blocks.find((b) => b.kind === "chain");
    if (chain?.kind !== "chain") throw new Error("no chain");
    expect(chain.lines.map((l) => [l.label, l.value])).toEqual([
      ["2025-03-14 stub", { cents: 1_250_000 }],
      ["2025-08-15 stub", { cents: 50_000 }],
      ["Year to date on the 2025-08-15 stub", { cents: 1_300_000 }],
    ]);
    expect(chain.note).toContain("5 other pay dates (2025-01-15 – 2025-07-15) paid none of it.");
    expect(p.selfCheck?.explain).toBe("The 2 stubs below add up to $13,000.00");
    const rows = p.blocks.find((b) => b.kind === "rows");
    expect(rows?.kind === "rows" && rows.groups.map((g) => g.statement.id)).toEqual(["st-chk-2025-03", "st-chk-2025-08"]);
  });

  it("pays check by check over a date range, with no year-to-date estimates", () => {
    const book = bookWith();
    const p = buildPayProof(book, paid({ lines: ["base"], start: "2025-06-01", end: "2025-11-30" }));
    // Jul, Aug (old job) + Oct, Nov (new job): the June paycheck has no stub and isn't counted.
    expect(cents(p)).toBe(400_000 * 2 + 520_000 * 2);
    expect(p.blocks.flatMap((b) => (b.kind === "chain" ? b.lines : [])).some((l) => l.source === "estimate")).toBe(false);
    expect(p.selfCheck?.ok).toBe(true);
    // The June paycheck's inference still says what the range stands on.
    expect(p.estimates.some((e) => e.title.includes("2025-05-15 and 2025-07-15"))).toBe(true);
  });

  it("groups the matched deposits by bank statement, adding to the net pay they carried", () => {
    const book = bookWith();
    const p = buildPayProof(book, ytd({ lines: ["net"], employerKeys: [employerKey(OLD)] }));
    const rows = p.blocks.find((b) => b.kind === "rows");
    if (rows?.kind !== "rows") throw new Error("no rows");
    const stubNet = book.stubs.filter((s) => s.employer === OLD).reduce((t, s) => t + s.printed.netCurrent, 0);
    expect(rows.figureCents).toBe(stubNet);
    expect(rows.groups.map((g) => g.statement.id)).toEqual(["st-chk-2025-01", "st-chk-2025-02", "st-chk-2025-03", "st-chk-2025-04", "st-chk-2025-05", "st-chk-2025-07", "st-chk-2025-08"]);
  });

  it("scopes checks to the person and employer", () => {
    const pass = (check: CheckPass["check"], employer: string, subject: string): CheckPass => ({ check, n: 1, subject, scope: { personId: "pat", employerKey: employerKey(employer), from: "2025-01-01", to: "2025-12-31", affects: ["PAY", "TAX"] } });
    const finding: Finding = {
      id: "pay.after-last-stub:x",
      check: "pay.after-last-stub",
      status: "MISSING",
      title: "a paycheck after the last stub",
      detail: "",
      fix: "",
      scope: { personId: "pat", employerKey: employerKey(NEW), from: "2025-01-01", to: "2025-12-31", affects: ["PAY", "TAX"] },
    };
    const book = bookWith({
      passes: [pass("pay.continuity", OLD, "old carries"), pass("pay.continuity", NEW, "new carries"), { check: "ledger.freshness", n: 1, subject: "rules", scope: { from: "2025-01-01", to: "2026-01-20", affects: ["CASH_FLOW", "PAY", "TAX"] } }],
      integrity: { checks: [], findings: [finding], inferences: [], accepted: [], stale: [], retired: [] },
    });
    const old = buildPayProof(book, ytd({ employerKeys: [employerKey(OLD)] }));
    expect(old.checks.find((c) => c.id === "pay.continuity")!.subjects).toEqual(["old carries"]);
    expect(old.checks.find((c) => c.id === "pay.after-last-stub")!.state).toBe("none");
    expect(old.checks.find((c) => c.id === "ledger.freshness")!.state).toBe("passed");
    expect(old.withheld).toBe(false);
    const all = buildPayProof(book, ytd({}));
    expect(all.checks.find((c) => c.id === "pay.after-last-stub")!.state).toBe("open");
    expect(all.withheld).toBe(true);
    expect(all.checks.some((c) => (c.id as string) === "statement.chain")).toBe(false);
  });

  it("counts stubs no one is matched to under '?'", () => {
    n = 0;
    const book = makeBook([chain(OLD, [["2025-01-15", base]], { personId: null })]);
    expect(cents(buildPayProof(book, ytd({ personId: "?" })))).toBe(400_000);
    expect(cents(buildPayProof(book, ytd({})))).toBe(0);
  });
});

describe("parsing a pay descriptor", () => {
  it("accepts a figure's recipe and rejects anything else", () => {
    expect(parseDescriptor({ report: "pay", basis: "ytd", personId: "pat", lines: ["base", "bonus"], year: 2025, employerKeys: [] })).toEqual({ report: "pay", basis: "ytd", personId: "pat", lines: ["base", "bonus"], year: 2025 });
    expect(parseDescriptor({ report: "pay", basis: "paid", lines: ["bonus"], start: "2025-01-01", end: "2025-12-31" })).toEqual({ report: "pay", basis: "paid", lines: ["bonus"], start: "2025-01-01", end: "2025-12-31" });
    expect(parseDescriptor({ report: "pay", basis: "ytd", lines: ["base"], year: 2025, through: "2026-01-01" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "pay", basis: "ytd", lines: ["salary"], year: 2025 })).toHaveProperty("error");
    expect(parseDescriptor({ report: "pay", basis: "ytd", lines: ["gross", "base"], year: 2025 })).toHaveProperty("error");
    expect(parseDescriptor({ report: "pay", basis: "ytd", lines: [], year: 2025 })).toHaveProperty("error");
    expect(parseDescriptor({ report: "pay", basis: "paid", lines: ["net"], start: "2025-02-01", end: "2025-01-31" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "pay", basis: "monthly", lines: ["net"], year: 2025 })).toHaveProperty("error");
  });
});

describe("as a registered proof kind", () => {
  const links = (p: Proof): ProofLink[] =>
    p.blocks.flatMap((b) => (b.kind === "breakdown" ? b.items.flatMap((i) => (i.link ? [i.link] : [])) : b.kind === "chain" ? b.lines.flatMap((l) => (l.link ? [l.link] : [])) : []));

  it("emits links that parse, build and re-add: each employer and part to its value, each deposit to its month's paychecks", async () => {
    const ctx = { book: bookWith(), db: {} as never };
    const figures = [ytd({ lines: ["base", "bonus"], personId: undefined }), ytd({ lines: ["net"] }), paid({ lines: ["gross", "deferrals"] })];
    let followed = 0;
    for (const d of figures) {
      const p = await buildProof(ctx, d);
      expect(p.selfCheck?.ok).toBe(true);
      const ls = links(p);
      expect(ls.length).toBeGreaterThan(0);
      for (const l of ls) {
        const parsed = parseDescriptor(JSON.parse(JSON.stringify(l.descriptor)));
        expect(parsed, l.label).not.toHaveProperty("error");
        const q = await buildProof(ctx, parsed as PayDescriptor);
        expect(q.selfCheck?.ok, l.label).toBe(true);
        followed++;
      }
      for (const b of p.blocks)
        if (b.kind === "breakdown") for (const i of b.items) expect((await buildProof(ctx, i.link!.descriptor)).figure, `${b.title} ${i.label}`).toEqual(i.value);
      // A deposit's month of paychecks holds the deposit.
      for (const l of p.blocks.flatMap((b) => (b.kind === "chain" ? b.lines : [])))
        if (l.link?.descriptor.report === "cash-flow") {
          const month = await buildProof(ctx, l.link.descriptor);
          const rows = month.blocks.flatMap((b) => (b.kind === "rows" ? b.groups.flatMap((g) => g.rows) : []));
          expect(rows.some((r) => l.note?.includes(`deposited ${r.date}`)), l.label).toBe(true);
        }
    }
    expect(followed).toBeGreaterThan(10);
  });

  it("splits a household figure by person and employer, and a multi-line one by part", async () => {
    const p = await buildProof({ book: bookWith(), db: {} as never }, ytd({ lines: ["base", "bonus"], personId: undefined }));
    expect(p.blocks.filter((b) => b.kind === "breakdown").map((b) => b.title)).toEqual(["By employer", "By part"]);
    expect(p.describes).toBe("Household · Base pay + Bonus, 2025 (partial)");
  });
});
