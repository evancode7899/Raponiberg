import { describe, expect, it } from "vitest";
import { CLASSIFIER_VERSION } from "../../classifier/version";
import { NO_HOUSEHOLD } from "../../household/patterns";
import type { StubLine } from "../../ingest/payroll/types";
import { estimateInstallments } from "../../dates/taxDates";
import { buildTaxReport } from "../../tax/buildTaxReport";
import { installmentsDue } from "../../tax/computeReturn";
import type { TaxProfile } from "../../tax/profile";
import { normalizeRetirementSettings } from "../../taxAccounts/settings";
import type { Book, BookAccount, BookRow, BookStub } from "../load";
import { calendarFigures } from "../proof/figures";
import { buildProof } from "../proof/index";
import { buildMoneyCalendar, calendarYears, type CalendarYear } from "./moneyCalendar";
import { buildTaxAccounts } from "./taxAccounts";

// An invented household: Pat Example (Acme Widgets: 401(k), HSA) and Sam Example (Globex:
// 401(k) only), a Springfield Bank account ••1234 and Pat's IRA ••5678 with one 2025
// contribution. Every name, number and amount is made up.

const TODAY = "2026-03-10";
const acct = (id: string, name: string, subtype: string, identifiers: string[], group: BookAccount["group"]): BookAccount =>
  ({ id, name, institution: "Example", type: subtype, subtype, group, identifiers }) as BookAccount;

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

const stubsFor = (personId: string, employer: string, year: number, months: number, check: [string, StubLine["kind"], number][]) =>
  Array.from({ length: months }, (_, i) => stub(personId, employer, `${year}-${String(i + 1).padStart(2, "0")}-28`, check.map(([n, k, c]) => [n, k, c, c * (i + 1)])));

const PAT: [string, StubLine["kind"], number][] = [
  ["Regular", "REGULAR", 900_000],
  ["401(k)", "RETIREMENT_PRETAX", 80_000],
  ["HSA", "HSA", 20_000],
  ["Federal income tax", "FEDERAL_TAX", 110_000],
  ["Social Security", "SOCIAL_SECURITY", 55_800],
  ["Medicare", "MEDICARE", 13_050],
  ["CT state tax", "STATE_TAX", 40_000],
];
const SAM: [string, StubLine["kind"], number][] = [
  ["Regular", "REGULAR", 700_000],
  ["401(k)", "RETIREMENT_PRETAX", 50_000],
  ["Federal income tax", "FEDERAL_TAX", 60_000],
  ["Social Security", "SOCIAL_SECURITY", 43_400],
  ["Medicare", "MEDICARE", 10_150],
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

function makeBook(): Book {
  const rows = [row("ira-1", "ira", "2025-05-12", 210_000, "IRA CONTRIBUTION")];
  const stubs = [...stubsFor("pat", "Acme Widgets", 2025, 12, PAT), ...stubsFor("sam", "Globex", 2025, 12, SAM), ...stubsFor("pat", "Acme Widgets", 2026, 2, PAT), ...stubsFor("sam", "Globex", 2026, 2, SAM)];
  return {
    today: TODAY,
    horizon: { cashFlow: "2026-02-28", netWorth: "2026-02-28" },
    ledger: { accounts: [], mergeDate: "2020-01-01", completeThrough: null, firstDay: "2025-01-01" },
    accounts: [acct("bank", "Springfield Bank ••1234", "CHECKING", ["1234"], "Cash"), acct("ira", "Example Traditional IRA ••5678", "TRADITIONAL_IRA", ["5678"], "Retirement")],
    statements: [],
    rows,
    rowById: new Map(rows.map((r) => [r.id, r])),
    stubs,
    brokerage: [],
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
  } as Book;
}

const db = { appSetting: { findUnique: async () => null } } as never;
const settings = normalizeRetirementSettings(null);
const yearsOf = (book: Book): CalendarYear[] =>
  calendarYears(book.today, [2025, 2026]).map((year) => ({ year, tax: buildTaxReport(book, year), accounts: buildTaxAccounts(book, year, settings) }));

describe("calendarYears", () => {
  it("keeps last year open until its filing date", () => {
    expect(calendarYears("2026-03-10", [2024, 2025, 2026])).toEqual([2025, 2026]);
    expect(calendarYears("2026-04-15", [2025, 2026])).toEqual([2025, 2026]);
    expect(calendarYears("2026-04-16", [2025, 2026])).toEqual([2026]);
    expect(calendarYears("2026-03-10", [2026])).toEqual([2026]);
  });
});

describe("money calendar", () => {
  const book = makeBook();
  const r = buildMoneyCalendar(book.today, yearsOf(book));

  it("dates each account by its own deadline, and drops what's already past", () => {
    const at = (id: string) => r.items.find((i) => i.id === id)?.date;
    // Last year's 401(k) and CHET closed on December 31; its IRA and HSA run to April 15.
    expect(at("2025-k401-pat")).toBeUndefined();
    expect(at("2025-chet")).toBeUndefined();
    expect(at("2025-ira-pat")).toBe("2026-04-15");
    expect(at("2025-hsa-pat")).toBe("2026-04-15");
    expect(at("2026-k401-sam")).toBe("2026-12-31");
    expect(at("2026-chet")).toBe("2026-12-31");
    expect(at("2026-ira-pat")).toBe("2027-04-15");
    expect(r.items.every((i) => i.date >= TODAY)).toBe(true);
    expect(r.items.map((i) => i.date)).toEqual([...r.items.map((i) => i.date)].sort());
    expect(r.years).toEqual([2025, 2026]);
  });

  it("repeats Account limits' room, and the Worksheet's balance due", () => {
    const limits = buildTaxAccounts(book, 2025, settings);
    const pat = limits.people.find((p) => p.id === "pat")!;
    expect(r.items.find((i) => i.id === "2025-ira-pat")?.cents).toBe(pat.ira.room);
    expect(pat.ira.room).toBe(pat.ira.limit - 210_000);
    const fed = r.items.find((i) => i.id === "2025-file-fed.balance");
    expect(fed?.date).toBe("2026-04-15");
    expect(fed?.proof).toEqual({ report: "tax-estimate", year: 2025, basis: "projected", key: "fed.balance" });
  });

  it("keeps last year's Q4 estimate through its due date in January", () => {
    const jan = { ...book, today: "2026-01-05" };
    const late = buildMoneyCalendar(jan.today, yearsOf(jan));
    expect(late.items.find((i) => i.id === "2025-q4-federal")?.date).toBe("2026-01-15");
    expect(late.items.some((i) => i.id === "2025-q3-federal")).toBe(false);
  });

  it("asks at each date for what brings payments up to that many quarters, to the cent", () => {
    const [, y26] = yearsOf(book);
    const tax = y26!.tax;
    if (tax.blocked) throw new Error("2026 is blocked");
    // $1,000.01 short on the year; as of August, the April and June dates went by unpaid.
    const sh = { requiredAnnualPayment: 9_000_01, withholding: 8_000_00, estimatesPaid: 0, underDeMinimis: false };
    const owing = (today: string, paid = 0) => {
      const left = estimateInstallments(2026).filter((x) => x.date >= today);
      const dues = installmentsDue({ ...sh, estimatesPaid: paid }, left.map((x) => x.quarter));
      const due = { ...tax.plan.federal, safeHarborShortfall: 1_000_01 - paid, installments: left.map((x, i) => ({ ...x, cents: dues[i]! })) };
      return buildMoneyCalendar(today, [{ ...y26!, tax: { ...tax, plan: { ...tax.plan, federal: due, ny: { ...due } } } }]).items;
    };
    const fed = (items: ReturnType<typeof owing>) => items.filter((i) => /^2026-q\d-federal$/.test(i.id)).map((i) => [i.date, i.cents]);
    expect(fed(owing("2026-03-10"))).toEqual([["2026-04-15", 250_00], ["2026-06-15", 250_01], ["2026-09-15", 250_00], ["2027-01-15", 250_00]]);
    expect(fed(owing("2026-08-01"))).toEqual([["2026-09-15", 750_01], ["2027-01-15", 250_00]]);
    // April's and June's paid in full: only a quarter each is left.
    expect(fed(owing("2026-08-01", 500_01))).toEqual([["2026-09-15", 250_00], ["2027-01-15", 250_00]]);
    // Paid ahead: the September date asks for nothing, so it isn't on the calendar.
    expect(fed(owing("2026-08-01", 800_00))).toEqual([["2027-01-15", 200_01]]);
    // New York's dates, where the year has New York tax.
    const ny = owing("2026-08-01").filter((i) => /^2026-q\d-ny$/.test(i.id));
    expect(ny.map((i) => [i.title, i.cents])).toEqual([["New York Q3 estimated tax", 750_01], ["New York Q4 estimated tax", 250_00]]);
  });

  it("puts the year in progress's Q4 estimate on January 15", () => {
    for (const s of ["federal", "ct"]) expect(r.items.find((i) => i.id === `2026-q4-${s}`)?.date).toBe("2027-01-15");
    expect(r.items.some((i) => i.id === "2025-q4-federal")).toBe(false);
  });

  it("ties every amount with a proof to that proof", async () => {
    const figs = calendarFigures(r);
    expect(figs.length).toBeGreaterThan(8);
    for (const f of figs) {
      const p = await buildProof({ book, db }, f.descriptor);
      expect("cents" in p.figure ? p.figure.cents : NaN, JSON.stringify(f.descriptor)).toBe(f.shown && "cents" in f.shown ? f.shown.cents : NaN);
    }
  });

  it("leaves a waiting tax year's tax items off, and says so", () => {
    const [y25, y26] = yearsOf(book);
    const blocked = buildMoneyCalendar(TODAY, [{ ...y25!, tax: { blocked: true, year: 2025, today: TODAY, profile: PROFILE, inputs: {}, blockers: [] } as never }, y26!]);
    expect(blocked.items.some((i) => i.year === 2025 && i.kind !== "save")).toBe(false);
    expect(blocked.items.some((i) => i.id === "2025-ira-pat")).toBe(true);
    expect(blocked.notes).toHaveLength(1);
  });
});
