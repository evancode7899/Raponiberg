import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { taxYearParams } from "../tax/params";
import { DEFAULT_PROFILE } from "../tax/profile";
import type { Book, BookAccount, BookBrokerage, BookRow, BookStatement } from "./load";
import { chetYear, excessDeferral, excessDeferralMessage, iraYear, k401Limit, statementContributionsYtd, taxableConversion } from "./taxAdvantaged";

// Every name and figure here is made up.
const $ = (d: number) => Math.round(d * 100);

const account = (id: string, name: string, subtype: string, identifiers: string[] = [id], group: BookAccount["group"] = "Taxable investments"): BookAccount =>
  ({ id, name, institution: "Example", subtype, type: "investment", group, identifiers }) as unknown as BookAccount;

let n = 0;
const row = (accountId: string, date: string, amount: number, payee: string, over: Partial<BookRow> = {}): BookRow => ({
  id: `r${++n}`,
  date,
  precision: "EXACT",
  statement: { start: date.slice(0, 8) + "01", end: date },
  bookedOn: date,
  amountCents: $(amount),
  lane: "TRANSFER",
  accountId,
  payee,
  merchantKey: null,
  category: "Own-account transfers",
  categoryGroup: null,
  counterpartyKind: null,
  counterpartyInstitution: null,
  counterpartyAccountHint: null,
  classifiedBy: null,
  transferMatchId: null,
  statementImportId: "st",
  documentId: "doc",
  ...over,
});

const snap = (accountNumber: string, periodEnd: string, contributionsYtd: number | null, isChet = false): BookBrokerage =>
  ({ id: `${accountNumber}-${periodEnd}`, documentId: "d", institution: "Example", accountNumber, ownerLine: "PAT EXAMPLE", kind: isChet ? "529" : "TRADITIONAL_IRA", periodStart: periodEnd.slice(0, 8) + "01", periodEnd, isYearEnd: false, endingValue: 0, income: null, realized: null, incomeRows: [], distributions: [], contributionsYtd: contributionsYtd == null ? null : $(contributionsYtd), isChet }) as unknown as BookBrokerage;

const statement = (accountId: string, periodEnd: string): BookStatement =>
  ({ id: `s-${accountId}-${periodEnd}`, accountId, documentId: "d", documentTitle: "", importedAt: "", status: "COMMITTED", isSummary: false, periodStart: periodEnd.slice(0, 8) + "01", periodEnd, deltaCents: 0 }) as BookStatement;

const book = (b: { accounts?: BookAccount[]; rows?: BookRow[]; brokerage?: BookBrokerage[]; statements?: BookStatement[]; edge?: string }): Book =>
  ({
    today: "2026-10-01",
    // The data edge: the year in progress runs through it.
    horizon: { cashFlow: b.edge ?? "2026-09-30", netWorth: b.edge ?? "2026-09-30" },
    accounts: b.accounts ?? [],
    rows: b.rows ?? [],
    brokerage: b.brokerage ?? [],
    statements: b.statements ?? [],
    matches: [],
    stubs: [],
    ledger: { accounts: [] },
    persons: [{ id: "pat", name: "Pat", match: ["PAT"] }],
    taxProfile: { ...structuredClone(DEFAULT_PROFILE), persons: [{ id: "pat", name: "Pat", match: ["PAT"] }] },
  }) as unknown as Book;

describe("statement year-to-date contributions", () => {
  it("is the largest figure any of the year's statements prints", () => {
    // A later statement that leaves the line out doesn't undo an earlier contribution.
    const snaps = [snap("C1", "2026-07-31", null), snap("C1", "2026-08-31", 10_000), snap("C1", "2026-09-30", null), snap("C1", "2025-12-31", 3_000)];
    expect(statementContributionsYtd(snaps, 2026)).toBe($(10_000));
    expect(statementContributionsYtd(snaps, 2025)).toBe($(3_000));
    expect(statementContributionsYtd(snaps, 2024)).toBeNull();
  });
});

describe("CHET 529 contributions", () => {
  const chet = account("chet", "529 PLAN ••0001", "529", ["C1"]);

  it("takes the statements' figure and checks it against the deposits into the account", () => {
    const b = book({ accounts: [chet], brokerage: [snap("C1", "2026-08-31", 10_000, true), snap("C1", "2026-09-30", null, true)], rows: [row("chet", "2026-08-27", 10_000, "Transferred from brokerage")] });
    expect(chetYear(b, 2026)).toMatchObject({ total: $(10_000), mismatches: [] });
  });

  it("reports a statement and ledger that disagree", () => {
    const b = book({ accounts: [chet], brokerage: [snap("C1", "2026-08-31", 10_000, true)], rows: [row("chet", "2026-08-27", 6_000, "Transferred from brokerage")] });
    const c = chetYear(b, 2026);
    expect(c.total).toBe($(10_000));
    expect(c.mismatches[0]).toMatch(/\$10,000\.00 contributed.*\$6,000\.00/);
  });

  it("falls back to the ledger's deposits when no statement prints the line", () => {
    const b = book({ accounts: [chet], brokerage: [snap("C1", "2026-09-30", null, true)], rows: [row("chet", "2026-03-02", 2_500, "Contribution"), row("chet", "2026-06-30", 40, "Dividend", { lane: "INCOME" })] });
    expect(chetYear(b, 2026)).toMatchObject({ total: $(2_500), mismatches: [] });
  });
});

describe("401(k) excess deferrals", () => {
  const plan = account("k", "401(k) — PAT EXAMPLE ••0002", "401K");
  const bank = account("bank", "Checking", "CHECKING", ["bank"], "Cash");
  const excess = $(1_000.5);

  it("are returned when a plan statement by the deadline shows the withdrawal, with the bank deposit", () => {
    const withdrawal = row("k", "2026-03-31", -1_000.5, "Withdrawals", { statement: { start: "2026-01-01", end: "2026-03-31" } });
    const b = book({ accounts: [plan, bank], rows: [withdrawal, row("bank", "2026-01-20", 1_000.5, "Mobile deposit")] });
    const e = excessDeferral(b, "pat", 2025, excess)!;
    expect(e).toMatchObject({ status: "RETURNED", deadline: "2026-04-15", returned: { cents: excess, deposit: { account: "Checking", date: "2026-01-20" } } });
    const m = excessDeferralMessage("Pat", 2025, $(23_500), $(24_500.5), e);
    expect(m.ok).toBe(true);
    expect(m.text).toMatch(/returned before 2026-04-15.*counts as 2025 income/);
  });

  it("are awaited until statements cover the deadline, then reported as not returned", () => {
    expect(excessDeferral(book({ accounts: [plan] }), "pat", 2025, excess)).toMatchObject({ status: "AWAITING", returned: null });
    const covered = book({ accounts: [plan], statements: [statement("k", "2026-06-30")] });
    const e = excessDeferral(covered, "pat", 2025, excess)!;
    expect(e.status).toBe("NOT_RETURNED");
    expect(excessDeferralMessage("Pat", 2025, $(23_500), $(24_500.5), e).ok).toBe(false);
  });

  it("ignore rollovers and unrelated withdrawals", () => {
    const rows = [row("k", "2026-03-31", -1_000.5, "Rollover to IRA"), row("k", "2026-03-31", -40_000, "Withdrawals")];
    expect(excessDeferral(book({ accounts: [plan], rows }), "pat", 2025, excess)!.returned).toBeNull();
  });

  it("is nothing when deferrals are within the limit", () => {
    expect(excessDeferral(book({ accounts: [plan] }), "pat", 2025, 0)).toBeNull();
  });

  it("limits include the catch-up from age 50, and the larger one at 60–63", () => {
    const fp = taxYearParams(2026).federal;
    expect(k401Limit(fp, null).limit).toBe(fp.limits.k401);
    expect(k401Limit(fp, 52)).toEqual({ limit: fp.limits.k401 + fp.retirement.k401CatchUp, catchUp: fp.retirement.k401CatchUp });
    expect(k401Limit(fp, 61).catchUp).toBe(fp.retirement.k401CatchUp60to63);
  });
});

describe("IRA contributions and conversions", () => {
  const trad = account("t", "Traditional IRA — PAT ••0003", "TRADITIONAL_IRA", ["T1"]);
  const roth = account("r", "Roth IRA — PAT ••0004", "ROTH_IRA", ["R1"]);
  const rollover = account("ro", "Rollover IRA — PAT ••0005", "ROLLOVER_IRA", ["RO1"]);

  it("reads a backdoor Roth from the rows: contribution, then conversion with a little growth", () => {
    const rows = [row("t", "2026-06-01", 7_000, "2026 IRA CONTRIBUTION"), row("t", "2026-06-02", -7_000.73, "NON-QUAL PREM TO ROTH"), row("r", "2026-06-02", 7_000.73, "ROLLOVER CONVERSION")];
    const ira = iraYear(book({ accounts: [trad, roth], rows }), "pat", 2026);
    expect(ira).toMatchObject({ conversions: $(7_000.73), traditionalContributions: $(7_000), contributions: [{ account: trad.name, cents: $(7_000) }], mismatches: [] });
    expect(taxableConversion(ira.conversions, ira.traditionalContributions, 0)).toBe(73);
  });

  it("counts the year in progress through the data edge, like every other figure on the page", () => {
    const rows = [row("r", "2026-03-10", 3_000, "IRA CONTRIBUTION"), row("r", "2026-08-12", 2_000, "IRA CONTRIBUTION")];
    expect(iraYear(book({ accounts: [roth], rows, edge: "2026-06-30" }), "pat", 2026).contributions).toMatchObject([{ cents: $(3_000) }]);
    expect(iraYear(book({ accounts: [roth], rows, edge: "2026-08-31" }), "pat", 2026).contributions).toMatchObject([{ cents: $(5_000) }]);
    // A finished year counts all of it, wherever the edge is.
    const last = [row("r", "2025-11-12", 2_000, "IRA CONTRIBUTION")];
    expect(iraYear(book({ accounts: [roth], rows: last, edge: "2026-06-30" }), "pat", 2025).contributions).toMatchObject([{ cents: $(2_000) }]);
  });

  it("checks every deposit against the custodian's contributions line (rollovers count there too)", () => {
    const rows = [row("ro", "2026-01-05", 50_000, "Check received IRA direct rollover")];
    expect(iraYear(book({ accounts: [rollover], rows, brokerage: [snap("RO1", "2026-03-31", 50_000)] }), "pat", 2026)).toMatchObject({ contributions: [], mismatches: [] });
    expect(iraYear(book({ accounts: [rollover], rows: [], brokerage: [snap("RO1", "2026-03-31", 50_000)] }), "pat", 2026).mismatches[0]).toMatch(/\$50,000\.00 deposited.*\$0\.00/);
  });

  it("applies the pro-rata rule when pre-tax IRA money is left at year end", () => {
    // $7,000 basis, $7,000 converted, $63,000 pre-tax left: 10% of the conversion is tax-free.
    expect(taxableConversion($(7_000), $(7_000), $(63_000))).toBe($(6_300));
    expect(taxableConversion(0, $(7_000), 0)).toBe(0);
  });
});

describe("one source for tax-advantaged figures", () => {
  // The Taxes page and the Tax-advantaged accounts page once each read these on their own
  // and disagreed; both now take them from book/taxAdvantaged.ts.
  const ROOT = path.resolve(__dirname, "../../..");
  const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

  it("no page or report reads a statement's contributions line itself", () => {
    for (const rel of ["src/lib/tax/buildTaxReport.ts", "src/lib/book/reports/taxAccounts.ts", "src/app/taxes/TaxWorksheet.tsx", "src/app/taxes/TaxIncome.tsx", "src/app/tax-accounts/TaxAccountsClient.tsx"]) {
      expect(src(rel), rel).not.toMatch(/\.contributionsYtd\b/);
    }
  });

  it("both reports use the shared IRA, CHET and excess-deferral readings", () => {
    for (const rel of ["src/lib/tax/buildTaxReport.ts", "src/lib/book/reports/taxAccounts.ts"]) {
      for (const fn of ["iraYear(", "chetYear(", "excessDeferralMessage(", "k401Limit("]) expect(src(rel), `${rel} → ${fn}`).toContain(fn);
    }
  });
});
