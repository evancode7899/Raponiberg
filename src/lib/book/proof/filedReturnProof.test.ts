import { describe, expect, it } from "vitest";
import { NO_HOUSEHOLD } from "../../household/patterns";
import { buildTaxReport } from "../../tax/buildTaxReport";
import type { ReturnLine } from "../../taxdocs/lines";
import { federalSummary, stateSummary } from "../../taxdocs/returns";
import type { FiledReturn, TaxDoc, TaxDocsFile } from "../../taxdocs/types";
import type { Book } from "../load";
import type { CheckPass } from "../types";
import type { FiledJurisdiction, FiledReturnDescriptor } from "./filedReturnProof";
import { buildProof, parseDescriptor, type Proof, type ProofLink } from "./index";

// An invented household: Pat Example's 2025 returns (federal 1040, Connecticut CT-1040 and
// a part-year New York IT-203), as the reader would have taken them off the PDFs. Every
// name and amount is made up.

const line = (form: string, page: number, num: string, label: string, ...values: number[]): ReturnLine => ({ form, page, line: num, label, values });

const FEDERAL_LINES: ReturnLine[] = [
  line("1040", 1, "1z", "Add lines 1a through 1h", 98_765),
  line("1040", 1, "2b", "Taxable interest", 432),
  line("1040", 1, "3a", "Qualified dividends", 210),
  line("1040", 1, "3b", "Ordinary dividends", 345),
  line("1040", 1, "4b", "Taxable amount", 600),
  line("1040", 1, "5b", "Taxable amount", 150),
  line("1040", 1, "9", "This is your total income", 100_292),
  line("1040", 1, "11", "Adjusted gross income", 100_292),
  line("1040", 1, "12", "Standard deduction or itemized deductions", 30_000),
  line("1040", 1, "15", "This is your taxable income", 70_292),
  line("1040", 2, "16", "Tax", 8_123),
  line("1040", 2, "24", "This is your total tax", 8_123),
  line("1040", 2, "25a", "Form(s) W-2", 9_000),
  line("1040", 2, "33", "These are your total payments", 9_000),
  line("1040", 2, "35a", "Amount of line 34 you want refunded to you", 677),
  line("1040", 2, "36", "Amount of line 34 you want applied to your 2026 estimated tax", 200),
];

const CT_LINES: ReturnLine[] = [
  line("CT-1040", 1, "1", "1. Federal adjusted gross income", 100_292),
  line("CT-1040", 1, "5", "5. Connecticut adjusted gross income", 100_292),
  line("CT-1040", 1, "18", "18. Total tax", 4_321),
  line("CT-1040", 1, "20", "20. Total Connecticut income tax withheld", 4_400),
  line("CT-1040", 1, "23", "23. Total payments", 4_400),
  line("CT-1040", 1, "24", "24. Refund", 79),
];

const NY_LINES: ReturnLine[] = [
  line("IT-203", 1, "19", "Federal adjusted gross income", 100_292, 25_000),
  line("IT-203", 2, "31", "Recompute the New York amount", 100_292, 25_000),
  line("IT-203", 2, "36", "Taxable income", 92_292),
  line("IT-203", 2, "45", "Income percentage", 0.2493),
  line("IT-203", 2, "62", "Total New York State tax withheld", 1_100),
  line("IT-203", 2, "68", "Amount you owe", 12),
];

const ret = (jurisdiction: FiledJurisdiction, form: string, lines: ReturnLine[]): FiledReturn => ({
  jurisdiction,
  form,
  filingStatus: jurisdiction === "FEDERAL" ? "SINGLE" : null,
  printedOn: "2026-04-01",
  movedOn: null,
  lines,
  otherIncome: [],
  federal: jurisdiction === "FEDERAL" ? federalSummary(lines) : null,
  state: jurisdiction === "FEDERAL" ? null : stateSummary(lines, jurisdiction),
});

const doc = (id: string, kind: "RETURN_FEDERAL" | "RETURN_CT" | "RETURN_NY", r: FiledReturn): TaxDoc => ({
  id,
  file: `2025/${id}.pdf`,
  duplicates: [],
  year: 2025,
  kind,
  superseded: null,
  names: ["PAT EXAMPLE"],
  parsed: { kind, ret: r },
  warnings: [],
});

const TAX_DOCS: TaxDocsFile = {
  version: 1,
  scannedAt: "2026-04-02T00:00:00.000Z",
  folder: "Example tax folder",
  errors: [],
  docs: [
    doc("pat-2025-federal", "RETURN_FEDERAL", ret("FEDERAL", "1040", FEDERAL_LINES)),
    doc("pat-2025-ct", "RETURN_CT", ret("CT", "CT-1040", CT_LINES)),
    doc("pat-2025-ny", "RETURN_NY", ret("NY", "IT-203", NY_LINES)),
  ],
};

function makeBook(extra: Partial<Book> = {}): Book {
  return {
    today: "2026-05-15",
    horizon: { cashFlow: "2026-04-30", netWorth: "2026-04-30" },
    ledger: { accounts: [], mergeDate: "2024-12-01", completeThrough: null, firstDay: "2025-01-01" },
    accounts: [],
    statements: [],
    rows: [],
    rowById: new Map(),
    stubs: [],
    brokerage: [],
    holdings: [],
    matches: [],
    documents: [],
    decisions: { version: 1, confirmed: [], rejected: [] },
    classifiedWith: null,
    household: NO_HOUSEHOLD,
    classifiedWithHousehold: null,
    taxProfile: {
      version: 1,
      persons: [{ id: "pat", name: "Pat Example", match: ["PAT", "EXAMPLE"] }],
      dependents: [],
      accountOwners: {},
      accountKinds: {},
      qualifiedDividendShare: 1,
      moneyMarketUsGovShare: 0,
      mfsDependentClaimant: "AUTO",
      years: {},
    },
    taxDocs: TAX_DOCS,
    persons: [],
    idle: { proven: [], unproven: [] },
    integrity: { checks: [], findings: [], inferences: [], accepted: [], stale: [], retired: [] },
    passes: [],
    ...extra,
  } as Book;
}

// No settings saved: loadProfileSettings falls back to its defaults.
const db = { appSetting: { findUnique: async () => null } } as never;
const ctx = (extra: Partial<Book> = {}) => ({ book: makeBook(extra), db });
const d = (jurisdiction: FiledJurisdiction, key: string): FiledReturnDescriptor => ({ report: "filed-return", year: 2025, jurisdiction, key });

const links = (p: Proof): ProofLink[] =>
  p.blocks.flatMap((b) => (b.kind === "breakdown" ? b.items.flatMap((i) => (i.link ? [i.link] : [])) : b.kind === "chain" ? b.lines.flatMap((l) => (l.link ? [l.link] : [])) : []));

/** Every line the Filed return tab shows, per jurisdiction, as the tax engine compares them. */
function tabLines() {
  const report = buildTaxReport(makeBook(), 2025);
  if (report.blocked) throw new Error("report withheld");
  const check = report.documents?.check;
  if (!check) throw new Error("no filed check");
  return [...check.federal.map((l) => ["FEDERAL", l] as const), ...check.ct.map((l) => ["CT", l] as const), ...check.ny.map((l) => ["NY", l] as const)];
}

describe("filed-return proof", () => {
  it("names the document, form, page and line of every line the tab shows, and comes to the tab's figure", async () => {
    const lines = tabLines();
    expect(lines.length).toBeGreaterThan(20);
    for (const [jurisdiction, l] of lines) {
      const p = await buildProof(ctx(), d(jurisdiction, l.key));
      const what = `${jurisdiction} ${l.key}`;
      const [read, vs] = p.blocks;
      expect(read?.kind === "chain" && read.title, what).toMatch(/^Read off 2025\/pat-2025-(federal|ct|ny)\.pdf$/);
      if (read?.kind !== "chain") throw new Error(what);
      if (l.filed == null) {
        expect(read.lines[0]?.value, what).toEqual({ text: "blank" });
      } else {
        // Every printed line it was read from, by form, page and line, read off the return ("proven").
        const printed = read.lines.filter((x) => x.op !== "=");
        expect(printed.length, what).toBeGreaterThan(0);
        for (const x of printed) {
          expect(x.label, what).toMatch(/^Form [\w.-]+, page \d+, line \w+$/);
          expect(x.source, what).toBe("proven");
        }
        expect(p.figure, what).toEqual(l.percent ? { ratio: l.filed / 10_000 } : { cents: l.filed });
        if (!l.percent) expect(p.selfCheck?.ok, what).toBe(true);
      }
      // The tab's comparison: as filed, this app, and the difference.
      expect(vs?.kind === "chain" && vs.title, what).toBe("Filed against this app");
      if (vs?.kind !== "chain") throw new Error(what);
      expect(vs.lines.map((x) => x.label).slice(0, 2), what).toEqual(["As filed", "This app"]);
      expect(vs.lines[1]!.source, what).toBe("estimate");
      if (l.filed != null && l.model != null) expect(vs.lines[2], what).toMatchObject({ op: "=", label: "Difference", value: l.percent ? { ratio: (l.filed - l.model) / 10_000 } : { cents: l.filed - l.model } });
    }
  });

  it("points at the exact line: Form 1040, page 1, line 1z for wages", async () => {
    const p = await buildProof(ctx(), d("FEDERAL", "wages"));
    const read = p.blocks[0];
    if (read?.kind !== "chain") throw new Error("no chain");
    expect(read.lines).toEqual([{ label: "Form 1040, page 1, line 1z", value: { cents: 9_876_500 }, source: "proven", note: "Printed as “Add lines 1a through 1h”." }]);
    expect(p.describes).toBe("Wages (W-2 box 1), Federal 1040 as filed for 2025");
    expect(read.note).toMatch(/printed on 2026-04-01, filed SINGLE/);
  });

  it("adds up the figures the tab builds from several lines", async () => {
    // Taxable IRA (4b) and pensions (5b) count together.
    const ira = await buildProof(ctx(), d("FEDERAL", "iraTaxable"));
    if (ira.blocks[0]?.kind !== "chain") throw new Error("no chain");
    expect(ira.blocks[0].lines.map((x) => [x.op, x.label])).toEqual([
      [undefined, "Form 1040, page 1, line 4b"],
      ["+", "Form 1040, page 1, line 5b"],
      ["=", "Taxable IRA distributions"],
    ]);
    expect(ira.figure).toEqual({ cents: 75_000 });

    // A refund (35a) and the part applied to next year (36) are the balance, negative.
    const bal = await buildProof(ctx(), d("FEDERAL", "balance"));
    if (bal.blocks[0]?.kind !== "chain") throw new Error("no chain");
    expect(bal.blocks[0].lines.map((x) => [x.op, x.label, x.value])).toEqual([
      ["−", "Form 1040, page 2, line 35a", { cents: 67_700 }],
      ["−", "Form 1040, page 2, line 36", { cents: 20_000 }],
      ["=", "Owed at filing (refund negative)", { cents: -87_700 }],
    ]);
    expect(bal.selfCheck).toMatchObject({ ok: true, explain: "The 2 printed lines come to ($877.00)" });
  });

  it("says which column of IT-203's two it read", async () => {
    const p = await buildProof(ctx(), d("NY", "sourceIncome"));
    if (p.blocks[0]?.kind !== "chain") throw new Error("no chain");
    expect(p.blocks[0].lines[0]).toMatchObject({ label: "Form IT-203, page 2, line 31", value: { cents: 2_500_000 } });
    expect(p.blocks[0].lines[0]!.note).toMatch(/2 amounts; this is the last \(the New York column\)/);
  });

  it("lists the year's tax law, document-tie and freshness checks, each passed or honestly empty", async () => {
    const pass: CheckPass = { check: "tax.params", n: 1, subject: "2025 tax law", scope: { from: "2025-01-01", to: "2025-12-31", affects: ["TAX"] } };
    const p = await buildProof(ctx({ passes: [pass] }), d("CT", "totalTax"));
    expect(p.checks.map((c) => [c.id, c.state])).toEqual([
      ["tax.params", "passed"],
      ["tax.documents-tie", "none"],
      ["ledger.freshness", "none"],
    ]);
    // Printed on the return: never withheld.
    expect(p.withheld).toBe(false);
  });

  it("says so when the year has no filed return of that kind", async () => {
    const p = await buildProof(ctx({ taxDocs: { ...TAX_DOCS, docs: TAX_DOCS.docs.filter((x) => x.kind !== "RETURN_NY") } }), d("NY", "withheld"));
    expect(p.figure).toEqual({ text: "Not on file" });
    expect(p.selfCheck).toBeNull();
  });

  it("as a registered proof kind: every descriptor and link parses and builds", async () => {
    const c = ctx();
    for (const [jurisdiction, l] of tabLines()) {
      const parsed = parseDescriptor(JSON.parse(JSON.stringify(d(jurisdiction, l.key))));
      expect(parsed, l.key).toEqual(d(jurisdiction, l.key));
      const p = await buildProof(c, parsed as FiledReturnDescriptor);
      // No tax-estimate kind yet, so no links; any added later must parse and build.
      for (const link of links(p)) {
        const q = parseDescriptor(JSON.parse(JSON.stringify(link.descriptor)));
        expect(q, link.label).not.toHaveProperty("error");
        await expect(buildProof(c, q as FiledReturnDescriptor)).resolves.toBeTruthy();
      }
    }
  });

  it("rejects descriptors that don't name a return line", () => {
    expect(parseDescriptor({ report: "filed-return", year: 2025, jurisdiction: "TX", key: "wages" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "filed-return", year: "2025", jurisdiction: "FEDERAL", key: "wages" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "filed-return", year: 2025, jurisdiction: "CT", key: "wages" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "filed-return", year: 2025, jurisdiction: "FEDERAL", key: "chet" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "filed-return", year: 2025, jurisdiction: "FEDERAL", key: "toString" })).toHaveProperty("error");
  });
});
