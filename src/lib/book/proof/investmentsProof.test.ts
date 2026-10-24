import { describe, expect, it } from "vitest";
import { NO_HOUSEHOLD } from "../../household/patterns";
import type { Holding } from "../../ingest/holdings/types";
import { normalizeInvestmentSettings } from "../../investments/settings";
import type { LedgerAccount } from "../../ledger/loadLedger";
import { buildTimeline } from "../../ledger/timeline";
import type { Book, BookHoldings, BookStatement } from "../load";
import { buildInvestments } from "../reports/investments";
import { buildNetWorth } from "../reports/netWorth";
import type { CheckPass, Finding } from "../types";
import { buildProof, parseDescriptor, type Proof, type ProofLink } from "./index";
import { buildInvestmentsProof, type InvestmentsDescriptor } from "./investmentsProof";

// An invented household: Pat Example's accounts at Springfield Bank, Jan – Feb 2025.
// Every name and amount is made up.
//  - brk: positions at the latest statement tie to its balance (TIES)
//  - ira: positions only on the January statement; February's balance is newer (STALE),
//    and the statement prints a total a cent off its positions
//  - k401: positions on file that don't add up to the balance (MISMATCH)
//  - hsa: no positions on file (NONE)
//  - chk: bank cash, counted only when the settings say so

type Def = { id: string; name: string; subtype: string; group: LedgerAccount["group"]; investment: boolean; closings: [string, string, number][] };
const DEFS: Def[] = [
  { id: "brk", name: "Pat's brokerage ••1234", subtype: "BROKERAGE", group: "Taxable investments", investment: true, closings: [["2025-01-01", "2025-01-31", 1_000_000], ["2025-02-01", "2025-02-28", 1_050_075]] },
  { id: "ira", name: "Pat's IRA ••5678", subtype: "ROTH_IRA", group: "Retirement", investment: true, closings: [["2025-01-01", "2025-01-31", 500_000], ["2025-02-01", "2025-02-28", 520_250]] },
  { id: "k401", name: "Example Co 401(k)", subtype: "401K", group: "Retirement", investment: true, closings: [["2025-01-01", "2025-02-28", 300_000]] },
  { id: "hsa", name: "Pat's HSA ••9012", subtype: "HSA", group: "Health savings", investment: true, closings: [["2025-02-01", "2025-02-28", 80_000]] },
  { id: "chk", name: "Pat's checking ••3456", subtype: "CHECKING", group: "Cash", investment: false, closings: [["2025-02-01", "2025-02-28", 42_000]] },
];

const STATEMENTS: BookStatement[] = DEFS.flatMap((a) =>
  a.closings.map(([periodStart, periodEnd]) => ({
    id: `st-${a.id}-${periodStart}`,
    accountId: a.id,
    documentId: `doc-${a.id}-${periodEnd}`,
    documentTitle: `${a.id}-${periodEnd}.pdf`,
    importedAt: "2025-04-01T00:00:00.000Z",
    status: "COMMITTED" as const,
    isSummary: false,
    periodStart,
    periodEnd,
    deltaCents: 0,
  })),
);

const pos = (symbol: string | null, name: string, valueCents: number, x: Partial<Holding> = {}): Holding => ({ symbol, name, kind: "FUND", quantity: null, price: null, valueCents, costBasisCents: null, expenseRatio: null, ...x });

const HOLDINGS: BookHoldings[] = [
  {
    id: "h-brk-feb",
    documentId: "doc-brk-2025-02-28",
    institution: "Springfield Bank",
    accountNumber: "1234",
    accountId: "brk",
    asOf: "2025-02-28",
    // 123.456 × $50.00 = $6,172.80, printed as $6,172.84 (the statement rounds the quantity).
    positions: [
      pos("EXMPL", "Example Total Market Index", 0, { kind: "ETF", quantity: 123.456, price: 50, costBasisCents: 500_000 }),
      pos("SPRNG", "Springfield Bond Fund", 400_000, { costBasisCents: 410_000 }),
      pos(null, "Core cash", 32_791, { kind: "CASH" }),
    ],
    printedTotalCents: null,
    totalCents: 0,
  },
  {
    id: "h-ira-jan",
    documentId: "doc-ira-2025-01-31",
    institution: "Springfield Bank",
    accountNumber: "5678",
    accountId: "ira",
    asOf: "2025-01-31",
    positions: [pos("EXTGT", "Example Target 2060", 450_000), pos(null, "Core cash", 50_000, { kind: "CASH" })],
    printedTotalCents: 500_001,
    totalCents: 0,
  },
  {
    id: "h-k401",
    documentId: "doc-k401-2025-02-28",
    institution: "Springfield Bank",
    accountNumber: "7777",
    accountId: "k401",
    asOf: "2025-02-28",
    positions: [pos(null, "Example Stable Value", 299_000)],
    printedTotalCents: 299_000,
    totalCents: 0,
  },
].map((h) => ({ ...h, totalCents: h.positions.reduce((t, p) => t + p.valueCents, 0) }));
// The brokerage's first position: whatever re-adds to its balance exactly.
HOLDINGS[0]!.positions[0]!.valueCents = 1_050_075 - 400_000 - 32_791;
HOLDINGS[0]!.totalCents = 1_050_075;
HOLDINGS[0]!.printedTotalCents = 1_050_075;

function makeBook(extra: Partial<Pick<Book, "passes" | "integrity">> = {}): Book {
  const ledgerAccounts: LedgerAccount[] = DEFS.map((a) => {
    let opening = 0;
    const segs = a.closings.map(([periodStart, periodEnd, closingCents]) => {
      const s = { accountId: a.id, periodStart, periodEnd, openingCents: opening, closingCents, growthCents: closingCents - opening, feesCents: 0, flows: [] };
      opening = closingCents;
      return s;
    });
    return {
      id: a.id,
      name: a.name,
      institution: "Springfield Bank",
      type: a.investment ? "INVESTMENT" : "CHECKING",
      subtype: a.subtype as LedgerAccount["subtype"],
      group: a.group,
      isInvestment: a.investment,
      timeline: buildTimeline(a.id, segs),
      statementCount: segs.length,
      closed: false,
    };
  });
  return {
    today: "2025-04-15",
    // The data edge: the last day every account's statements cover.
    horizon: { cashFlow: "2025-02-28", netWorth: "2025-02-28" },
    ledger: { accounts: ledgerAccounts, mergeDate: "2024-12-01", completeThrough: "2025-02-28", firstDay: "2025-01-01" },
    accounts: DEFS.map((a) => ({ id: a.id, name: a.name, subtype: a.subtype, type: a.investment ? "INVESTMENT" : "CHECKING", institution: "Springfield Bank", group: a.group, identifiers: [] })),
    statements: STATEMENTS,
    rows: [],
    rowById: new Map(),
    stubs: [],
    brokerage: [],
    holdings: HOLDINGS,
    matches: [],
    documents: STATEMENTS.map((s) => ({ id: s.documentId, title: s.documentTitle, institution: "Springfield Bank", parserId: "example", parserVersion: 1, factsVersion: 1, periodStart: s.periodStart, periodEnd: s.periodEnd })),
    decisions: { version: 1, confirmed: [], rejected: [] },
    classifiedWith: null,
    household: NO_HOUSEHOLD,
    classifiedWithHousehold: null,
    taxProfile: { version: 1, persons: [], dependents: [], accountOwners: {}, accountKinds: {}, qualifiedDividendShare: 1, moneyMarketUsGovShare: 0, mfsDependentClaimant: "AUTO", years: {} },
    taxDocs: null,
    persons: [],
    idle: { proven: [], unproven: [] },
    integrity: { checks: [], findings: [], inferences: [], accepted: [], stale: [], retired: [] },
    passes: [],
    ...extra,
  } as unknown as Book;
}

const SETTINGS = normalizeInvestmentSettings(null);
const d = (x: Partial<InvestmentsDescriptor> = {}): InvestmentsDescriptor => ({ report: "investments", ...x });
const proof = (x: Partial<InvestmentsDescriptor> = {}, settings = SETTINGS, book = makeBook()) => buildInvestmentsProof(book, settings, d(x));
const block = (p: Proof, title: string) => p.blocks.find((b) => b.title.startsWith(title));
const links = (p: Proof): ProofLink[] =>
  p.blocks.flatMap((b) => (b.kind === "breakdown" ? b.items.flatMap((i) => (i.link ? [i.link] : [])) : b.kind === "chain" ? b.lines.flatMap((l) => (l.link ? [l.link] : [])) : []));

describe("buildInvestmentsProof", () => {
  it("values every account on Net worth's day, at Net worth's balance", () => {
    const book = makeBook();
    const r = buildInvestments(book, SETTINGS);
    const nw = new Map(buildNetWorth(book, { granularity: "month" }).accounts.map((a) => [a.id, a.currentCents]));
    expect(r.asOf).toBe(book.horizon.netWorth);
    expect(r.accounts.length).toBeGreaterThan(0);
    for (const a of r.accounts) {
      expect(a.asOf, a.name).toBe(book.horizon.netWorth);
      expect(a.valueCents, a.name).toBe(nw.get(a.accountId));
    }
  });

  it("proves every figure the page shows: the total, each account and each position", () => {
    for (const settings of [SETTINGS, { ...SETTINGS, includeBankCash: true }]) {
      const book = makeBook();
      const r = buildInvestments(book, settings);
      const total = proof({}, settings, book);
      expect(total.figure).toEqual({ cents: r.totalCents });
      expect(total.selfCheck?.ok).toBe(true);
      for (const a of r.accounts) {
        const p = proof({ accountId: a.accountId }, settings, book);
        expect(p.figure, a.name).toEqual({ cents: a.valueCents });
        expect(p.selfCheck, a.name).toMatchObject({ ok: true, deltaCents: 0 });
      }
      for (const x of r.positions.filter((x) => x.kind !== "ACCOUNT")) expect(proof({ accountId: x.accountId, position: x.key }, settings, book).figure).toEqual({ cents: x.valueCents });
      expect(r.accounts.some((a) => a.accountId === "chk")).toBe(settings.includeBankCash);
    }
  });

  it("re-adds a tying snapshot's positions to the balance, the printed total and the net-worth balance", () => {
    const p = proof({ accountId: "brk" });
    expect(p.describes).toContain("positions tie to the balance");
    const positions = block(p, "Positions at 2025-02-28");
    if (positions?.kind !== "breakdown") throw new Error("no positions");
    expect(positions.items.map((i) => i.value)).toEqual(HOLDINGS[0]!.positions.map((x) => ({ cents: x.valueCents })));
    expect(p.selfCheck?.explain).toBe("The 3 positions add up to $10,500.75");
    const printed = block(p, "Printed total vs positions");
    if (printed?.kind !== "chain") throw new Error("no printed chain");
    expect(printed.lines.map((l) => [l.label, l.value, l.source])).toEqual([
      ["3 positions re-added", { cents: 1_050_075 }, "derived"],
      ["Total the statement prints", { cents: 1_050_075 }, "proven"],
      ["Difference", { cents: 0 }, "derived"],
    ]);
    expect(printed.lines.at(-1)!.note).toBeUndefined();
    const nw = block(p, "Against the net-worth balance");
    expect(nw?.kind === "chain" && nw.lines.at(-1)).toMatchObject({ label: "Difference", value: { cents: 0 } });
    const from = block(p, "Read from");
    expect(from?.kind === "breakdown" && from.items.map((i) => [i.label, i.value])).toEqual([
      ["Pat's brokerage ••1234", { text: "Taxable" }],
      ["brk-2025-02-28.pdf", { text: "balance at 2025-02-28" }],
      ["brk-2025-02-28.pdf", { text: "positions at 2025-02-28" }],
    ]);
  });

  it("calls out a printed total that differs from the positions, and the change since older holdings", () => {
    const p = proof({ accountId: "ira" });
    expect(p.figure).toEqual({ cents: 520_250 });
    const printed = block(p, "Printed total vs positions");
    if (printed?.kind !== "chain") throw new Error("no printed chain");
    expect(printed.lines.at(-1)).toMatchObject({ label: "Difference", value: { cents: -1 }, note: "The positions come to $0.01 less than the printed total." });
    const nw = block(p, "Against the net-worth balance");
    if (nw?.kind !== "chain") throw new Error("no balance chain");
    expect(nw.lines.at(-1)).toMatchObject({ label: "Change since holdings of 2025-01-31", value: { cents: 20_250 } });
    expect(p.selfCheck).toMatchObject({ ok: true, explain: "The 2 positions add up to $5,000.00; with change since holdings of 2025-01-31, $5,202.50" });
  });

  it("shows positions that don't tie as unused, and the account as one line", () => {
    const p = proof({ accountId: "k401" });
    expect(p.describes).toContain("don't tie");
    const shown = block(p, "What the page shows");
    expect(shown?.kind === "breakdown" && shown.items.map((i) => [i.label, i.value])).toEqual([["Whole account (no holdings on file)", { cents: 300_000 }]]);
    expect(block(p, "Positions on file at 2025-02-28 (not used)")).toBeTruthy();
    const nw = block(p, "Against the net-worth balance");
    expect(nw?.kind === "chain" && nw.lines.at(-1)).toMatchObject({ value: { cents: -1_000 }, note: "The positions come to $10.00 less than the balance: not used." });
  });

  it("proves an account with no holdings as its statement balance", () => {
    const p = proof({ accountId: "hsa" });
    expect(p.selfCheck).toMatchObject({ ok: true, explain: "One line for the whole account: $800.00" });
    expect(block(p, "Read from")?.kind === "breakdown" && (block(p, "Read from") as { items: unknown[] }).items).toHaveLength(2);
  });

  it("works a position out from quantity and price, against the value printed", () => {
    const key = "EXMPL";
    const p = proof({ accountId: "brk", position: key });
    const value = HOLDINGS[0]!.positions[0]!.valueCents;
    expect(p.figure).toEqual({ cents: value });
    const c = p.blocks.find((b) => b.kind === "chain");
    if (c?.kind !== "chain") throw new Error("no chain");
    expect(c.lines.map((l) => l.label)).toEqual(["Quantity", "Price", "Quantity × price", "Value the statement prints", "Cost basis", "Unrealized gain"]);
    expect(c.lines[2]!.value).toEqual({ cents: 617_280 });
    expect(value).toBe(617_284);
    expect(c.lines[2]!.note).toContain("from the printed value");
    expect(c.lines.at(-1)!.value).toEqual({ cents: value - 500_000 });
  });

  it("checks the account at its latest statement, and the total over every account", () => {
    const scope = (accountId: string, from: string, to: string) => ({ accountId, from, to, affects: ["NET_WORTH" as const] });
    const passes: CheckPass[] = [
      { check: "statement.held", n: 1, subject: "brk Feb", scope: scope("brk", "2025-02-01", "2025-02-28") },
      { check: "statement.held", n: 1, subject: "brk Jan", scope: scope("brk", "2025-01-01", "2025-01-31") },
      { check: "statement.held", n: 1, subject: "hsa Feb", scope: scope("hsa", "2025-02-01", "2025-02-28") },
    ];
    const finding: Finding = { id: "statement.chain:hsa", check: "statement.chain", status: "FAIL", title: "doesn't chain", detail: "", fix: "", scope: scope("hsa", "2025-02-01", "2025-02-28") };
    const book = makeBook({ passes, integrity: { checks: [], findings: [finding], inferences: [], accepted: [], stale: [], retired: [] } });
    const brk = proof({ accountId: "brk" }, SETTINGS, book);
    expect(brk.checks.find((c) => c.id === "statement.held")).toMatchObject({ state: "passed", subjects: ["brk Feb"] });
    expect(brk.checks.find((c) => c.id === "statement.chain")!.state).toBe("none");
    expect(brk.withheld).toBe(false);
    const total = proof({}, SETTINGS, book);
    expect(total.checks.find((c) => c.id === "statement.held")).toMatchObject({ state: "passed", passed: 2, subjects: ["brk Feb", "hsa Feb"] });
    expect(total.checks.find((c) => c.id === "statement.chain")).toMatchObject({ state: "open", open: [{ id: "statement.chain:hsa" }] });
    expect(total.withheld).toBe(true);
    // The page withholds the same accounts.
    expect(buildInvestments(book, SETTINGS).blockers.map((b) => b.id)).toEqual(["statement.chain:hsa"]);
  });
});

describe("as a registered proof kind", () => {
  const db = { appSetting: { findUnique: async () => null } } as never;
  const ctx = () => ({ book: makeBook(), db });

  it("parses descriptors and rejects malformed ones", () => {
    expect(parseDescriptor({ report: "investments" })).toEqual({ report: "investments" });
    expect(parseDescriptor({ report: "investments", accountId: "brk", position: "EXMPL", extra: 1 })).toEqual({ report: "investments", accountId: "brk", position: "EXMPL" });
    expect(parseDescriptor({ report: "investments", position: "EXMPL" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "investments", accountId: 7 })).toHaveProperty("error");
  });

  it("emits links that parse, build, re-add and match the figure they were shown with", async () => {
    const c = ctx();
    const seen = new Set<string>();
    const queue: InvestmentsDescriptor[] = [d()];
    while (queue.length) {
      const desc = queue.shift()!;
      const key = JSON.stringify(desc);
      if (seen.has(key)) continue;
      seen.add(key);
      const p = await buildProof(c, desc);
      expect(p.selfCheck?.ok ?? true, key).toBe(true);
      for (const b of p.blocks)
        if (b.kind === "breakdown")
          for (const i of b.items) {
            if (!i.link) continue;
            const parsed = parseDescriptor(JSON.parse(JSON.stringify(i.link.descriptor)));
            expect(parsed, i.link.label).not.toHaveProperty("error");
            expect((await buildProof(c, parsed as InvestmentsDescriptor)).figure, i.link.label).toEqual(i.value);
            queue.push(parsed as InvestmentsDescriptor);
          }
      for (const l of links(p)) expect(parseDescriptor(JSON.parse(JSON.stringify(l.descriptor)))).not.toHaveProperty("error");
    }
    // The total, the four investment accounts, and the brokerage's and IRA's positions.
    expect(seen.size).toBe(1 + 4 + 3 + 2);
  });

  it("proves an account the page doesn't show as nothing", async () => {
    const p = await buildProof(ctx(), d({ accountId: "chk" }));
    expect(p.figure).toEqual({ cents: 0 });
    expect(p.blocks).toEqual([]);
  });
});
