import { describe, expect, it } from "vitest";
import { CLASSIFIER_VERSION } from "../../classifier/version";
import { NO_HOUSEHOLD } from "../../household/patterns";
import type { StubLine } from "../../ingest/payroll/types";
import { taxYearParams } from "../../tax/params";
import type { TaxProfile } from "../../tax/profile";
import { normalizeRetirementSettings } from "../../taxAccounts/settings";
import type { Book, BookAccount, BookBrokerage, BookRow, BookStub } from "../load";
import type { Finding } from "../types";
import { buildTaxAccounts, type TaxAccountsReport } from "../reports/taxAccounts";
import { buildAccountLimitsProof, parseAccountLimitsDescriptor, type AccountLimitsDescriptor } from "./accountLimitsProof";
import { chainReAdds } from "./common";
import { accountLimitsFigures } from "./figures";
import { buildProof, parseDescriptor, type Proof, type ProofLink } from "./index";

// An invented household: Pat Example (Acme Widgets: 401(k) pre-tax and Roth, HSA, an
// employer match and employer HSA money) and Sam Example (Globex, deferring well past the
// 2025 limit), a Springfield Bank account ••1234, Pat's traditional IRA ••5678 and a CHET
// 529 ••9012. Every name, number and amount is made up.

const TODAY = "2026-05-15";
const acct = (id: string, name: string, subtype: string, identifiers: string[], group: BookAccount["group"]): BookAccount =>
  ({ id, name, institution: "Example", type: subtype, subtype, group, identifiers }) as BookAccount;
const BANK = acct("bank", "Springfield Bank ••1234", "CHECKING", ["1234"], "Cash");
const IRA = acct("ira", "Example Traditional IRA ••5678", "TRADITIONAL_IRA", ["5678"], "Retirement");
const CHET = acct("chet", "CHET 529 ••9012", "529", ["9012"], "Other");

function row(id: string, accountId: string, date: string, amountCents: number, payee: string): BookRow {
  const month = date.slice(0, 7);
  return {
    id, date, bookedOn: date, precision: "EXACT", statement: { start: `${month}-01`, end: `${month}-28` }, amountCents, lane: "TRANSFER", accountId, payee, merchantKey: null,
    category: "Own-account transfers", categoryGroup: null, counterpartyKind: null, counterpartyInstitution: null, counterpartyAccountHint: null, classifiedBy: null, transferMatchId: null,
    statementImportId: `st-${accountId}-${month}`, documentId: `doc-${accountId}-${month}`,
  } as BookRow;
}

function stub(personId: string, employer: string, payDate: string, lines: [string, StubLine["kind"], number, number][]): BookStub {
  return {
    id: `${personId}-${payDate}`, documentId: `stub-${personId}-${payDate}`, documentTitle: `${employer} ${payDate}.pdf`, importedAt: `${payDate}T00:00:00.000Z`, source: "ADP",
    employee: personId === "pat" ? "Pat Example" : "Sam Example", employer, employerKey: employer.toUpperCase(), personId, payDate, periodStart: `${payDate.slice(0, 8)}01`, periodEnd: payDate,
    federalFilingStatus: null, lines: lines.map(([name, kind, current, ytd]) => ({ name, kind, current, ytd })),
    printed: { grossCurrent: null, grossYtd: null, withheldCurrent: null, withheldYtd: null, netCurrent: null, netYtd: null }, deposits: [], warnings: [], depositTransactionId: null,
  } as unknown as BookStub;
}

/** Monthly stubs on the 28th, January through `months`, each check the same. */
const stubsFor = (personId: string, employer: string, year: number, months: number, check: [string, StubLine["kind"], number][]) =>
  Array.from({ length: months }, (_, i) => stub(personId, employer, `${year}-${String(i + 1).padStart(2, "0")}-28`, check.map(([n, k, c]) => [n, k, c, c * (i + 1)])));

const PAT: [string, StubLine["kind"], number][] = [
  ["Regular", "REGULAR", 1_000_000],
  ["401(k)", "RETIREMENT_PRETAX", 100_000],
  ["Roth 401(k)", "RETIREMENT_ROTH", 25_000],
  ["HSA", "HSA", 30_000],
  ["Employer match", "EMPLOYER_RETIREMENT", 40_000],
  ["Employer HSA", "EMPLOYER_HSA", 5_000],
  ["Federal income tax", "FEDERAL_TAX", 150_000],
  ["Social Security", "SOCIAL_SECURITY", 62_000],
  ["Medicare", "MEDICARE", 14_500],
  ["CT state tax", "STATE_TAX", 50_000],
];
const SAM: [string, StubLine["kind"], number][] = [
  ["Regular", "REGULAR", 900_000],
  ["401(k)", "RETIREMENT_PRETAX", 300_000],
  ["Federal income tax", "FEDERAL_TAX", 90_000],
  ["Social Security", "SOCIAL_SECURITY", 55_800],
  ["Medicare", "MEDICARE", 13_050],
];

const PROFILE: TaxProfile = {
  version: 1,
  persons: [
    { id: "pat", name: "Pat Example", match: ["PAT"] },
    { id: "sam", name: "Sam Example", match: ["SAM"] },
  ],
  dependents: [],
  accountOwners: { "5678": "pat" },
  accountKinds: {},
  qualifiedDividendShare: 1,
  moneyMarketUsGovShare: 0,
  mfsDependentClaimant: "AUTO",
  years: {},
};

const chetSnap = (periodEnd: string, contributionsYtd: number | null): BookBrokerage =>
  ({
    id: `chet-${periodEnd}`, documentId: `chet-doc-${periodEnd}`, institution: "Example", accountNumber: "9012", ownerLine: "PAT EXAMPLE", kind: "529", periodStart: `${periodEnd.slice(0, 8)}01`, periodEnd,
    isYearEnd: false, endingValue: 1_000_000, income: null, realized: null, incomeRows: [], distributions: [], contributionsYtd, isChet: true,
  }) as unknown as BookBrokerage;

/** An open tax finding over 2024–2025: no provable tax estimate for 2025 or the year before, so no marginal rate. */
const NO_TAX: Finding = {
  id: "tax.params:example",
  check: "tax.params",
  status: "FAIL",
  title: "Example: tax law missing",
  detail: "Invented for the test.",
  fix: "None.",
  scope: { from: "2024-01-01", to: "2025-12-31", affects: ["TAX"] },
} as Finding;

function makeBook(findings: Finding[] = []): Book {
  const rows = [
    row("ira-1", "ira", "2025-04-10", 300_000, "IRA CONTRIBUTION"),
    row("ira-2", "ira", "2025-11-03", 200_000, "IRA CONTRIBUTION"),
    row("ira-3", "ira", "2026-02-02", 150_000, "IRA CONTRIBUTION"),
    row("chet-1", "chet", "2025-06-30", 250_000, "CONTRIBUTION"),
    row("chet-2", "chet", "2026-03-31", 125_000, "CONTRIBUTION"),
  ];
  const stubs = [...stubsFor("pat", "Acme Widgets", 2025, 12, PAT), ...stubsFor("sam", "Globex", 2025, 12, SAM), ...stubsFor("pat", "Acme Widgets", 2026, 4, PAT), ...stubsFor("sam", "Globex", 2026, 4, SAM)];
  return {
    today: TODAY,
    horizon: { cashFlow: "2026-04-30", netWorth: "2026-04-30" },
    ledger: { accounts: [], mergeDate: "2020-01-01", completeThrough: null, firstDay: "2025-01-01" },
    accounts: [BANK, IRA, CHET],
    statements: [],
    rows,
    rowById: new Map(rows.map((r) => [r.id, r])),
    stubs,
    brokerage: [chetSnap("2025-12-31", 250_000), chetSnap("2026-03-31", null)],
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
    integrity: { checks: [], findings, inferences: [], accepted: [], stale: [], retired: [] },
    passes: [],
  } as Book;
}

// No settings saved: every loader falls back to its defaults (no birth years, no forecast drivers).
const db = { appSetting: { findUnique: async () => null } } as never;
const ctx = () => ({ book: makeBook(), db });
const settings = normalizeRetirementSettings(null);
const reportFor = (year: number, birthYears: Record<string, number> = {}) => buildTaxAccounts({ ...makeBook(), birthYears }, year, settings);

const cents = (p: Proof) => ("cents" in p.figure ? p.figure.cents : NaN);
const links = (p: Proof): ProofLink[] =>
  p.blocks.flatMap((b) => (b.kind === "breakdown" ? b.items.flatMap((i) => (i.link ? [i.link] : [])) : b.kind === "chain" ? b.lines.flatMap((l) => (l.link ? [l.link] : [])) : []));

/** Every figure the page makes clickable, with the value the page shows. */
/** Every figure the Account limits page shows for the year (figures.ts, the list the live sweep walks too). */
const pageFigures = (r: TaxAccountsReport): { d: AccountLimitsDescriptor; cents: number }[] =>
  accountLimitsFigures(r).map((f) => ({ d: f.descriptor as AccountLimitsDescriptor, cents: f.shown && "cents" in f.shown ? f.shown.cents : NaN }));

describe("account-limits proofs", () => {
  for (const year of [2025, 2026]) {
    it(`re-derive every figure the page shows for ${year}, and the parts re-add to it`, async () => {
      const r = reportFor(year);
      const figs = pageFigures(r);
      expect(figs.length).toBeGreaterThan(30);
      for (const { d, cents: shown } of figs) {
        const p = await buildProof(ctx(), d);
        const label = JSON.stringify(d);
        expect(cents(p), label).toBe(shown);
        expect(p.selfCheck?.ok, `${label}: ${p.selfCheck?.explain}`).toBe(true);
      }
    });
  }

  it("lists the contributions that count: stubs per employer, IRA rows by statement, CHET's printed line", async () => {
    const r = reportFor(2025);
    const pat = r.people.find((p) => p.id === "pat")!;
    expect(pat.k401.total.ytd).toBe(12 * 125_000);
    expect(pat.hsa.total.ytd).toBe(12 * 35_000);
    const ira = await buildProof(ctx(), { report: "account-limits", year: 2025, account: "ira", personId: "pat", figure: "used" });
    expect(cents(ira)).toBe(500_000);
    const rows = ira.blocks.find((b) => b.kind === "rows");
    expect(rows?.kind === "rows" && rows.groups.map((g) => g.rows.map((x) => x.id))).toEqual([["ira-1"], ["ira-2"]]);
    const chet = await buildProof(ctx(), { report: "account-limits", year: 2025, account: "chet", figure: "used" });
    expect(cents(chet)).toBe(250_000);
    expect(chet.blocks[0]!.kind === "chain" && chet.blocks[0]!.lines[0]!.label).toMatch(/on the 2025-12-31 statement/);
  });

  it("each employer's stub line opens a pay proof of exactly that amount", async () => {
    for (const year of [2025, 2026])
      for (const d of [
        { account: "k401", part: "employee" },
        { account: "k401", part: "employer" },
        { account: "hsa", part: "employee" },
        { account: "hsa", part: "employer" },
      ] as const) {
        const p = await buildProof(ctx(), { report: "account-limits", year, personId: "pat", figure: "used", ...d });
        const lines = p.blocks.flatMap((b) => (b.kind === "chain" ? b.lines : []));
        const linked = lines.filter((l) => l.link?.descriptor.report === "pay");
        expect(linked.length, JSON.stringify(d)).toBeGreaterThan(0);
        for (const l of linked) expect({ cents: cents(await buildProof(ctx(), l.link!.descriptor)) }).toEqual(l.value);
      }
  });

  it("projects the rest of the year as an estimate on the repeated check", async () => {
    const p = await buildProof(ctx(), { report: "account-limits", year: 2026, account: "k401", personId: "pat", figure: "projected" });
    const est = p.blocks.flatMap((b) => (b.kind === "chain" ? b.lines : [])).find((l) => l.source === "estimate");
    expect(est?.label).toMatch(/^\d+ more paychecks to Dec 31 × \$1,250\.00$/);
    expect(p.estimates.length).toBe(1);
  });

  it("shows an excess as deferred − limit, with no room left", async () => {
    const r = reportFor(2025);
    const sam = r.people.find((p) => p.id === "sam")!;
    const limit = taxYearParams(2025).federal.limits.k401;
    expect(sam.k401.excess).toBe(12 * 300_000 - limit);
    const ex = await buildProof(ctx(), { report: "account-limits", year: 2025, account: "k401", personId: "sam", figure: "excess" });
    expect(cents(ex)).toBe(sam.k401.excess);
    expect(ex.selfCheck?.ok).toBe(true);
    expect(ex.blocks.map((b) => b.title)).toEqual(["The excess", "Its return"]);
    const room = await buildProof(ctx(), { report: "account-limits", year: 2025, account: "k401", personId: "sam", figure: "room" });
    expect(cents(room)).toBe(0);
    const chain = room.blocks[0]!.kind === "chain" ? room.blocks[0]!.lines : [];
    expect(chain.map((l) => [l.label, l.value])).toEqual([
      ["Limit", { cents: limit }],
      [expect.stringContaining("401(k) deferrals"), { cents: 12 * 300_000 }],
      ["Over the limit by", { cents: limit - 12 * 300_000 }],
      ["Room left (none once over)", { cents: 0 }],
    ]);
    expect(chainReAdds(chain)).toEqual([]);
  });

  it("adds age catch-ups by law, from the birth year the owner typed", () => {
    const fp = taxYearParams(2026).federal;
    const r = reportFor(2026, { pat: 1971 });
    const p = buildAccountLimitsProof(makeBook(), { report: r, birthYears: { pat: 1971 }, settings }, { report: "account-limits", year: 2026, account: "k401", personId: "pat", figure: "limit" });
    expect(cents(p)).toBe(fp.limits.k401 + fp.retirement.k401CatchUp);
    const lines = p.blocks[0]!.kind === "chain" ? p.blocks[0]!.lines : [];
    expect(lines.map((l) => l.source)).toEqual(["law", "assumption", "derived", "law", "law"]);
    expect(p.selfCheck?.ok).toBe(true);
  });

  it("emits links that parse and build (the registered-kind invariant)", async () => {
    const c = ctx();
    let n = 0;
    for (const year of [2025, 2026])
      for (const { d } of pageFigures(reportFor(year))) {
        for (const l of links(await buildProof(c, d))) {
          const parsed = parseDescriptor(JSON.parse(JSON.stringify(l.descriptor)));
          expect(parsed, l.label).not.toHaveProperty("error");
          const q = await buildProof(c, parsed as AccountLimitsDescriptor);
          expect(q.figure, l.label).toBeDefined();
          n++;
        }
      }
    expect(n).toBeGreaterThan(20);
  });

  it("counts every open pre-tax step's room with no marginal rate known, and calls the tax saved unknown", async () => {
    const book = makeBook([NO_TAX]);
    const r = buildTaxAccounts(book, 2025, settings);
    expect(r.marginalRate).toEqual({ rate: null, source: "NONE" });
    const open = r.steps.filter((s) => s.pretax && !s.done);
    // Pat has HSA and 401(k) room; Sam deferred past the limit. Before the fix, no rate meant no step counted.
    expect(open.map((s) => s.id).sort()).toEqual(["hsa-pat", "k401-pat"]);
    expect(r.pretax.roomCents).toBe(open.reduce((t, s) => t + s.roomCents, 0));
    expect(r.pretax.roomCents).toBeGreaterThan(0);
    expect(r.pretax.taxSavedCents).toBeNull();
    const c = { book, db };
    const room = await buildProof(c, { report: "account-limits", year: 2025, account: "steps", figure: "room" });
    expect(cents(room)).toBe(r.pretax.roomCents);
    expect(room.selfCheck?.ok).toBe(true);
    const saved = await buildProof(c, { report: "account-limits", year: 2025, account: "steps", figure: "tax-saved" });
    expect(saved.figure).toEqual({ text: "Unknown" });
    expect(saved.selfCheck).toBeNull();
    const rate = saved.blocks.find((b) => b.title === "The rate");
    expect(rate?.kind === "chain" && rate.lines[0]!.value).toEqual({ text: "unknown" });
  });

  it("rejects descriptors the page never makes", () => {
    expect(parseAccountLimitsDescriptor({ year: 2026, account: "k401", figure: "used" })).toHaveProperty("error");
    expect(parseAccountLimitsDescriptor({ year: 2026, account: "ira", personId: "pat", figure: "projected" })).toHaveProperty("error");
    expect(parseAccountLimitsDescriptor({ year: 2026, account: "chet", personId: "pat", figure: "used" })).toHaveProperty("error");
    expect(parseAccountLimitsDescriptor({ year: 2026, account: "hsa", personId: "pat", figure: "limit", part: "employer" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "account-limits", year: 2026, account: "k401", personId: "pat", figure: "used", employer: "Acme Widgets", part: "employer" })).not.toHaveProperty("error");
  });
});
