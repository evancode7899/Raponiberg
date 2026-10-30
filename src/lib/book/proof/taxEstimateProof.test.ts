import { describe, expect, it } from "vitest";
import { CLASSIFIER_VERSION } from "../../classifier/version";
import { NO_HOUSEHOLD } from "../../household/patterns";
import type { StubLine } from "../../ingest/payroll/types";
import { buildTaxReport } from "../../tax/buildTaxReport";
import { ESTIMATE_LINES, estimateColumns, estimatesFound, lineValue, type EstimateKey } from "../../tax/estimateLines";
import type { TaxProfile } from "../../tax/profile";
import type { ReturnLine } from "../../taxdocs/lines";
import { federalSummary, stateSummary } from "../../taxdocs/returns";
import type { FiledReturn, TaxDoc, TaxDocsFile } from "../../taxdocs/types";
import type { Book, BookAccount, BookBrokerage, BookRow, BookStub } from "../load";
import { buildProof, parseDescriptor, type Proof, type ProofLink } from "./index";
import type { FiledJurisdiction } from "./filedReturnProof";
import { evalChain, splitForecastBonus, type TaxEstimateDescriptor } from "./taxEstimateProof";

// An invented household: Pat Example (Acme Widgets) and Sam Example (Globex, which also
// withholds New York tax), one child, a joint Springfield Bank account ••1234 earning
// interest and paying estimated taxes, and a joint brokerage account ••5678. Every name,
// number and amount is made up.

const BANK: BookAccount = { id: "bank", name: "Springfield Bank ••1234", institution: "Springfield Bank", type: "CHECKING", subtype: "CHECKING", group: "Cash", identifiers: ["1234"] };

function row(id: string, date: string, amountCents: number, payee: string, lane: BookRow["lane"], category: string): BookRow {
  const month = date.slice(0, 7);
  const statement = { start: `${month}-01`, end: `${month}-28` };
  return {
    id, date, bookedOn: date, precision: "EXACT", statement, amountCents, lane, accountId: "bank", payee, merchantKey: null, category, categoryGroup: null,
    counterpartyKind: null, counterpartyInstitution: null, counterpartyAccountHint: null, classifiedBy: null, transferMatchId: null, statementImportId: `st-${month}`, documentId: `doc-${month}`,
  } as BookRow;
}

/** A pay stub: this check's and year-to-date amounts by line kind. */
function stub(personId: string, employer: string, payDate: string, lines: [string, StubLine["kind"], number, number][]): BookStub {
  return {
    id: `${personId}-${payDate}`,
    documentId: `stub-${personId}-${payDate}`,
    documentTitle: `${employer} ${payDate}.pdf`,
    importedAt: `${payDate}T00:00:00.000Z`,
    source: "ADP",
    employee: personId === "pat" ? "Pat Example" : "Sam Example",
    employer,
    employerKey: employer.toUpperCase(),
    personId,
    payDate,
    periodStart: `${payDate.slice(0, 8)}01`,
    periodEnd: payDate,
    federalFilingStatus: null,
    lines: lines.map(([name, kind, current, ytd]) => ({ name, kind, current, ytd })),
    printed: { grossCurrent: null, grossYtd: null, withheldCurrent: null, withheldYtd: null, netCurrent: null, netYtd: null },
    deposits: [],
    warnings: [],
    depositTransactionId: null,
  } as unknown as BookStub;
}

/** Monthly stubs (paid on the 28th) from January through `months`: each check the same, year to date adding up. */
function stubsFor(personId: string, employer: string, year: number, months: number, check: [string, StubLine["kind"], number][]): BookStub[] {
  return Array.from({ length: months }, (_, i) => stub(personId, employer, `${year}-${String(i + 1).padStart(2, "0")}-28`, check.map(([n, k, c]) => [n, k, c, c * (i + 1)])));
}

const PAT: [string, StubLine["kind"], number][] = [
  ["Regular", "REGULAR", 1_250_000],
  ["Group term life", "IMPUTED", 2_000],
  ["Medical", "SECTION125", 30_000],
  ["HSA", "HSA", 20_000],
  ["401(k)", "RETIREMENT_PRETAX", 150_000],
  ["Federal income tax", "FEDERAL_TAX", 210_000],
  ["Social Security", "SOCIAL_SECURITY", 75_000],
  ["Medicare", "MEDICARE", 17_600],
  ["CT state tax", "STATE_TAX", 60_000],
  ["CT PFML", "STATE_PAYROLL", 6_000],
];
const SAM: [string, StubLine["kind"], number][] = [
  ["Regular", "REGULAR", 650_000],
  ["401(k)", "RETIREMENT_PRETAX", 40_000],
  ["Federal income tax", "FEDERAL_TAX", 80_000],
  ["Social Security", "SOCIAL_SECURITY", 40_300],
  ["Medicare", "MEDICARE", 9_400],
  ["NY state tax", "OTHER_STATE_TAX", 25_000],
];

function brokerage(periodEnd: string, dividends: number, interest: number): BookBrokerage {
  const facts = {
    accountNumber: "X12-345678",
    ownerLine: "PAT EXAMPLE & SAM EXAMPLE JOINT",
    kind: "TAXABLE",
    periodStart: `${periodEnd.slice(0, 8)}01`,
    periodEnd,
    isYearEnd: false,
    endingValue: 50_000_000,
    income: { dividends, interest, capGainDistShort: 0, capGainDistLong: 4_000, taxExempt: 0, taxDeferred: 0 },
    realized: { shortTerm: -12_000, longTerm: 85_000 },
    incomeRows: [
      { date: "2025-03-15", security: "EXAMPLE FUND", cusip: "", kind: "DIVIDEND", amount: Math.round(dividends * 0.8), nonQualified: false, moneyMarket: false },
      { date: "2025-03-15", security: "EXAMPLE MONEY FUND", cusip: "", kind: "DIVIDEND", amount: Math.round(dividends * 0.2), nonQualified: true, moneyMarket: true },
    ],
    distributions: [],
    contributionsYtd: null,
    isChet: false,
  };
  return { ...facts, id: `brk-${periodEnd}`, documentId: `brk-doc-${periodEnd}`, institution: "Example Brokerage" } as unknown as BookBrokerage;
}

const PROFILE: TaxProfile = {
  version: 1,
  persons: [
    { id: "pat", name: "Pat Example", match: ["PAT"] },
    { id: "sam", name: "Sam Example", match: ["SAM"] },
  ],
  dependents: [{ name: "Kit", birthYear: 2019 }],
  accountOwners: {},
  accountKinds: {},
  qualifiedDividendShare: 0.9,
  moneyMarketUsGovShare: 0.5,
  mfsDependentClaimant: "AUTO",
  years: {
    "2025": {
      people: { pat: { extras: { extraInterest: 12_300, capitalLossCarryover: 50_000 } } },
      household: { mortgageInterest: 1_800_000, propertyTax: 900_000, charitableCash: 300_000 },
    } as never,
  },
};

function makeBook(today: string, extra: Partial<Book> = {}): Book {
  const year = Number(today.slice(0, 4));
  const finishedYear = year - 1;
  const rows = [
    row("int-1", `${finishedYear}-03-28`, 4_321, "INTEREST PAID", "INCOME", "Interest"),
    row("int-2", `${finishedYear}-09-28`, 5_678, "INTEREST PAID", "INCOME", "Interest"),
    row("irs-1", `${finishedYear}-06-15`, -500_000, "IRS USATAXPYMT", "EXPENSE", "Taxes"),
    row("ct-1", `${finishedYear}-09-15`, -150_000, "CT DRS PAYMENT", "EXPENSE", "Taxes"),
    row("int-3", `${year}-02-28`, 3_300, "INTEREST PAID", "INCOME", "Interest"),
    row("irs-2", `${year}-04-15`, -400_001, "IRS USATAXPYMT", "EXPENSE", "Taxes"),
  ];
  const stubs = [...stubsFor("pat", "Acme Widgets", finishedYear, 12, PAT), ...stubsFor("sam", "Globex", finishedYear, 12, SAM), ...stubsFor("pat", "Acme Widgets", year, 4, PAT), ...stubsFor("sam", "Globex", year, 4, SAM)];
  return {
    today,
    horizon: { cashFlow: `${year}-04-30`, netWorth: `${year}-04-30` },
    ledger: { accounts: [], mergeDate: "2020-01-01", completeThrough: null, firstDay: `${finishedYear}-01-01` },
    accounts: [BANK],
    statements: [],
    rows,
    rowById: new Map(rows.map((r) => [r.id, r])),
    stubs,
    brokerage: [brokerage(`${finishedYear}-04-30`, 30_000, 1_000), brokerage(`${finishedYear}-12-31`, 120_000, 3_456), brokerage(`${year}-04-30`, 40_000, 1_200)],
    holdings: [],
    matches: [],
    documents: [],
    decisions: { version: 1, confirmed: [], rejected: [] },
    classifiedWith: CLASSIFIER_VERSION,
    household: NO_HOUSEHOLD,
    classifiedWithHousehold: null,
    taxProfile: PROFILE,
    taxDocs: null,
    persons: PROFILE.persons,
    idle: { proven: [], unproven: [] },
    integrity: { checks: [], findings: [], inferences: [], accepted: [], stale: [], retired: [] },
    passes: [],
    ...extra,
  } as Book;
}

// No settings saved: every loader falls back to its defaults.
const db = { appSetting: { findUnique: async () => null } } as never;
const ctx = (book: Book) => ({ book, db });

const links = (p: Proof): ProofLink[] =>
  p.blocks.flatMap((b) => (b.kind === "breakdown" ? b.items.flatMap((i) => (i.link ? [i.link] : [])) : b.kind === "chain" ? b.lines.flatMap((l) => (l.link ? [l.link] : [])) : []));
const linked = (p: Proof): { link: ProofLink; value: Proof["figure"] }[] =>
  p.blocks.flatMap((b) => (b.kind === "chain" ? b.lines.flatMap((l) => (l.link ? [{ link: l.link, value: l.value }] : [])) : []));

const KEYS = Object.keys(ESTIMATE_LINES) as EstimateKey[];
const d = (year: number, basis: TaxEstimateDescriptor["basis"], key: TaxEstimateDescriptor["key"], filer?: string): TaxEstimateDescriptor => ({ report: "tax-estimate", year, basis, ...(filer ? { filer } : {}), key });

/** Builds every line of every column for a basis, checks each against the page's figure and its own arithmetic, and returns the links it emitted. */
async function sweep(book: Book, year: number, basis: "projected" | "ytd") {
  const report = buildTaxReport(book, year);
  if (report.blocked) throw new Error("withheld");
  const { cols } = estimateColumns(report, basis);
  const out: { from: string; link: ProofLink; value: Proof["figure"] }[] = [];
  for (const col of cols) {
    for (const key of KEYS) {
      const filer = col.id === "joint" ? undefined : col.id;
      const p = await buildProof(ctx(book), d(year, basis, key, filer));
      const page = lineValue(key, col, cols);
      const where = `${year} ${basis} ${col.id} ${key}`;
      if (page == null) expect(p.figure, where).toEqual({ text: "—" });
      else expect(p.figure, where).toEqual(ESTIMATE_LINES[key].ratio ? { ratio: page } : { cents: page });
      if (p.selfCheck) expect(p.selfCheck.ok, `${where}: ${p.selfCheck.explain} vs ${JSON.stringify(p.figure)}`).toBe(true);
      // Every chain block works through, the supporting ones included.
      for (const b of p.blocks) if (b.kind === "chain" && !ESTIMATE_LINES[key].ratio) expect(evalChain(b.lines).ok, `${where} · ${b.title}`).toBe(true);
      out.push(...linked(p).map((l) => ({ from: where, ...l })));
    }
  }
  return out;
}

/** Every emitted link parses and builds; a link to another tax line or a pay figure opens a proof of exactly the value its line shows. */
async function follow(book: Book, emitted: { from: string; link: ProofLink; value: Proof["figure"] }[]) {
  const seen = new Map<string, Proof>();
  for (const { from, link, value } of emitted) {
    const json = JSON.stringify(link.descriptor);
    const parsed = parseDescriptor(JSON.parse(json));
    expect(parsed, `${from} → ${link.label}`).not.toHaveProperty("error");
    let q = seen.get(json);
    if (!q) seen.set(json, (q = await buildProof(ctx(book), parsed as TaxEstimateDescriptor)));
    if (link.descriptor.report === "tax-estimate" || link.descriptor.report === "pay") {
      if ("cents" in value && "cents" in q.figure) expect(q.figure.cents, `${from} → ${link.label}`).toBeCloseTo(value.cents, 6);
    }
    if (q.selfCheck) expect(q.selfCheck.ok, `${from} → ${link.label}`).toBe(true);
  }
  return seen.size;
}

describe("a finished year's estimate (2025, seen from 2026)", () => {
  const book = makeBook("2026-05-15");

  it("proves every worksheet line of every return, full year and year to date, and every link it emits", async () => {
    const emitted = [...(await sweep(book, 2025, "projected")), ...(await sweep(book, 2025, "ytd"))];
    expect(emitted.length).toBeGreaterThan(200);
    const reports = new Set(emitted.map((e) => e.link.descriptor.report));
    expect([...reports].sort()).toEqual(["cash-flow", "pay", "tax-estimate"]);
    expect(await follow(book, emitted)).toBeGreaterThan(50);
  }, 120_000);

  it("works wages out from the stubs, each part opening that person's pay proof", async () => {
    const p = await buildProof(ctx(book), d(2025, "projected", "fed.wages", "pat"));
    const main = p.blocks[0]!;
    if (main.kind !== "chain") throw new Error("no chain");
    expect(main.lines.map((l) => [l.op ?? "", l.label, l.source])).toEqual([
      ["", "Acme Widgets: base pay, year to date on the 2025-12-28 stub", "proven"],
      ["+", "Acme Widgets: taxable benefits (imputed income), year to date on the 2025-12-28 stub", "proven"],
      ["−", "Acme Widgets: pre-tax health, dental, vision (§125), year to date on the 2025-12-28 stub", "proven"],
      ["−", "Acme Widgets: HSA from pay, year to date on the 2025-12-28 stub", "proven"],
      ["−", "Acme Widgets: pre-tax 401(k), year to date on the 2025-12-28 stub", "proven"],
      ["=", "Wages (W-2 box 1)", "derived"],
    ]);
    expect(main.lines[0]!.link?.descriptor).toEqual({ report: "pay", basis: "ytd", personId: "pat", employerKeys: ["ACME WIDGETS"], lines: ["base"], year: 2025, through: "2025-12-31" });
    expect(p.figure).toEqual({ cents: 12 * (1_250_000 + 2_000 - 30_000 - 20_000 - 150_000) });
  });

  it("splits joint bank interest evenly and links each account's rows to cash flow", async () => {
    const p = await buildProof(ctx(book), d(2025, "projected", "fed.taxableInterest"));
    const bank = p.blocks.find((b) => b.title === "Bank interest · Pat Example");
    expect(bank?.kind === "chain" && bank.lines[0]).toMatchObject({ value: { cents: (4_321 + 5_678) / 2 }, link: { descriptor: { report: "cash-flow", category: "Interest", accountIds: ["bank"], start: "2025-01-01", end: "2025-12-31" } } });
    expect(p.blocks.some((b) => b.kind === "rows" && b.groups.flatMap((g) => g.rows.map((r) => r.id)).sort().join() === "int-1,int-2")).toBe(true);
    // The typed interest is the owner's assumption; the brokerage's interest is read off its statement.
    const main = p.blocks[0]!;
    if (main.kind !== "chain") throw new Error("no chain");
    expect(main.lines.find((l) => /other interest/.test(l.label))).toMatchObject({ source: "assumption", value: { cents: 12_300 } });
    expect(main.lines.find((l) => /••5678: interest on the statement ending 2025-12-31/.test(l.label))?.source).toBe("proven");
  });

  it("marks brackets, the standard deduction and caps as the year's tax law", async () => {
    const tax = await buildProof(ctx(book), d(2025, "projected", "fed.tax"));
    const lines = tax.blocks[0]!.kind === "chain" ? tax.blocks[0]!.lines : [];
    expect(lines.filter((l) => l.source === "law").length).toBeGreaterThan(2);
    expect(lines.find((l) => l.source === "law")?.note).toMatch(/2025 tax law \(married filing jointly\)/);
    const sep = await buildProof(ctx(book), d(2025, "projected", "fed.deduction", "sam"));
    // Filing separately, both spouses itemize: the household's typed deductions are split evenly, the owner's assumptions.
    const sl = sep.blocks[0]!.kind === "chain" ? sep.blocks[0]!.lines : [];
    expect(sl.find((l) => l.label === "Property tax")).toMatchObject({ source: "assumption", value: { cents: 450_000 } });
    expect(sl.find((l) => l.label === "Mortgage interest")).toMatchObject({ source: "assumption", value: { cents: 900_000 } });
    const joint = await buildProof(ctx(book), d(2025, "ytd", "fed.deduction"));
    expect(joint.figure).toEqual({ cents: lineValue("fed.deduction", estimateColumns(buildTaxReport(book, 2025) as never, "ytd").cols.at(-1)!) });
  });

  it("lists the estimated payments' bank rows", async () => {
    const p = await buildProof(ctx(book), d(2025, "projected", "fed.estimatedPayments"));
    expect(p.figure).toEqual({ cents: 500_000 });
    expect(p.blocks.find((b) => b.kind === "rows")?.kind === "rows" && (p.blocks.find((b) => b.kind === "rows") as { groups: { rows: { id: string }[] }[] }).groups[0]!.rows[0]!.id).toBe("irs-1");
    const found = await buildProof(ctx(book), d(2025, "projected", "found.CT"));
    const report = buildTaxReport(book, 2025);
    if (report.blocked) throw new Error("withheld");
    expect(found.figure).toEqual({ cents: estimatesFound(report.payments, 2025, "CT") });
    expect(found.selfCheck?.ok).toBe(true);
  });

  it("lists the checks taxBlockers looks at, the new tax-documents freshness among them", async () => {
    const p = await buildProof(ctx(book), d(2025, "projected", "fed.agi"));
    expect(p.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["tax.params", "paystub.arithmetic", "pay.continuity", "ledger.freshness"]));
    expect(p.withheld).toBe(false);
  });

  it("rejects descriptors that name no line, or a filed comparison of a separate return", () => {
    expect(parseDescriptor({ report: "tax-estimate", year: 2025, basis: "projected", key: "fed.horoscope" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "tax-estimate", year: 1999, basis: "projected", key: "fed.agi" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "tax-estimate", year: 2025, basis: "filed", filer: "pat", key: "fed.agi" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "tax-estimate", year: 2025, basis: "filed", key: "pay.salary" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "tax-estimate", year: 2025, basis: "ytd", filer: "pat", key: "fed.agi" })).toEqual(d(2025, "ytd", "fed.agi", "pat"));
  });
});

describe("the year in progress (2026): a run-rate forecast", () => {
  const book = makeBook("2026-05-15");

  it("proves every line, marking what's projected past the latest stub as an estimate", async () => {
    const emitted = [...(await sweep(book, 2026, "projected")), ...(await sweep(book, 2026, "ytd"))];
    expect(await follow(book, emitted)).toBeGreaterThan(20);
    const p = await buildProof(ctx(book), d(2026, "projected", "pay.salary", "pat"));
    const main = p.blocks[0]!;
    if (main.kind !== "chain") throw new Error("no chain");
    expect(main.lines[1]).toMatchObject({ label: "Acme Widgets: paychecks after 2026-04-28", source: "estimate", value: { cents: 8 * 1_250_000 } });
    // The projection is the forecast's: its line opens the forecast's paycheck for Pat, on the same basis.
    expect(main.lines[1]!.link?.descriptor).toEqual({ report: "forecast", figure: "seed", which: "pay", personId: "pat", paycheck: "TYPICAL" });
    expect(p.estimates.map((e) => e.id)).toContain("tax-estimate:projected:2026");
  }, 120_000);
});

// ---------------------------------------------------------------- the Filed return tab

const fline = (form: string, page: number, num: string, label: string, ...values: number[]): ReturnLine => ({ form, page, line: num, label, values });
const ret = (jurisdiction: FiledJurisdiction, form: string, lines: ReturnLine[]): FiledReturn => ({
  jurisdiction,
  form,
  filingStatus: jurisdiction === "FEDERAL" ? "MFJ" : null,
  printedOn: "2026-04-01",
  movedOn: null,
  lines,
  otherIncome: [],
  federal: jurisdiction === "FEDERAL" ? federalSummary(lines) : null,
  state: jurisdiction === "FEDERAL" ? null : stateSummary(lines, jurisdiction),
});
const doc = (id: string, kind: "RETURN_FEDERAL" | "RETURN_CT", r: FiledReturn): TaxDoc => ({ id, file: `2025/${id}.pdf`, duplicates: [], year: 2025, kind, superseded: null, names: ["PAT EXAMPLE"], parsed: { kind, ret: r }, warnings: [] });
const FILED: TaxDocsFile = {
  version: 1,
  scannedAt: "2026-04-02T00:00:00.000Z",
  folder: "Example tax folder",
  errors: [],
  docs: [
    doc("example-2025-federal", "RETURN_FEDERAL", ret("FEDERAL", "1040", [fline("1040", 1, "1z", "Wages", 200_000), fline("1040", 1, "11", "Adjusted gross income", 201_000), fline("1040", 2, "24", "This is your total tax", 30_000), fline("1040", 2, "33", "Total payments", 41_000), fline("1040", 2, "34", "Overpaid", 11_000), fline("1040", 2, "35a", "Refunded", 11_000)])),
    doc("example-2025-ct", "RETURN_CT", ret("CT", "CT-1040", [fline("CT-1040", 1, "1", "1. Federal adjusted gross income", 201_000), fline("CT-1040", 1, "18", "18. Total tax", 9_000)])),
  ],
};

describe("the Filed return tab's “This app” column", () => {
  const book = makeBook("2026-05-15", { taxDocs: FILED });

  it("opens the estimate's line as the tab compares it, re-adding from the projected figure, for every line", async () => {
    const report = buildTaxReport(book, 2025);
    if (report.blocked || !report.documents?.check) throw new Error("no comparison");
    const check = report.documents.check;
    const all = [...check.federal.map((l) => ["FEDERAL", l] as const), ...check.ct.map((l) => ["CT", l] as const), ...check.ny.map((l) => ["NY", l] as const)];
    expect(all.length).toBeGreaterThan(10);
    for (const [j, l] of all) {
      const key = `${j === "FEDERAL" ? "fed" : j.toLowerCase()}.${l.key}`;
      const parsed = parseDescriptor({ report: "tax-estimate", year: 2025, basis: "filed", key });
      expect(parsed, key).not.toHaveProperty("error");
      const p = await buildProof(ctx(book), parsed as TaxEstimateDescriptor);
      if (l.model == null) continue;
      expect(p.figure, key).toEqual(l.percent ? { ratio: l.model / 10_000 } : { cents: l.model });
      if (p.selfCheck) expect(p.selfCheck.ok, key).toBe(true);
      for (const link of links(p)) expect(parseDescriptor(JSON.parse(JSON.stringify(link.descriptor))), key).not.toHaveProperty("error");
    }
  }, 60_000);

  it("links the filed line's proof to it", async () => {
    const p = await buildProof(ctx(book), { report: "filed-return", year: 2025, jurisdiction: "FEDERAL", key: "agi" });
    const vs = p.blocks.find((b) => b.title === "Filed against this app");
    const app = vs?.kind === "chain" ? vs.lines.find((l) => l.label === "This app") : undefined;
    expect(app?.link?.descriptor).toEqual({ report: "tax-estimate", year: 2025, basis: "filed", key: "fed.agi" });
    const q = await buildProof(ctx(book), app!.link!.descriptor);
    expect(q.figure).toEqual(app!.value);
  });
});

describe("the forecast's bonus on its own line", () => {
  it("takes out the forecast's bonus, never more than the projection added, and adds back to the whole", () => {
    // $12,000 projected, of which a $3,000 bonus, all of it the forecast's.
    expect(splitForecastBonus(1_200_000, 300_000, 300_000)).toEqual({ rest: 900_000, bonus: 300_000 });
    // A $1,000 bonus typed under Inputs on top of the forecast's $3,000 stays with the paychecks.
    expect(splitForecastBonus(1_300_000, 400_000, 300_000)).toEqual({ rest: 1_000_000, bonus: 300_000 });
    // The forecast pays a bonus but this projection added less of it (or none, or a withheld box): capped.
    expect(splitForecastBonus(1_000_000, 100_000, 300_000)).toEqual({ rest: 900_000, bonus: 100_000 });
    expect(splitForecastBonus(50_000, 0, 300_000)).toEqual({ rest: 50_000, bonus: 0 });
    // No forecast bonus: one line.
    expect(splitForecastBonus(1_000_000, 200_000, 0)).toEqual({ rest: 1_000_000, bonus: 0 });
  });
});
