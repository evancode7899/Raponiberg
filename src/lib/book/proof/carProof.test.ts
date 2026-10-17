import { describe, expect, it } from "vitest";
import { buildGarage, COST_LINES, type CarReport } from "../../car/report";
import { CAR_KINDS, normalizeGarage, SHARED, type CarEntry, type GarageSettings } from "../../car/settings";
import { NO_HOUSEHOLD } from "../../household/patterns";
import type { Book, BookRow, BookStatement } from "../load";
import { buildCarProof, type CarDescriptor, type CarFigureDescriptor } from "./carProof";
import { buildProof, parseDescriptor, type Proof, type ProofLink } from "./index";

// An invented garage: Pat Example's Acme Roadster (bought Jan 2025) and a Volt Bolt
// (bought Jun 2025), paid on a Springfield Bank card ••5678. Every name, row and amount
// is made up.

const STATEMENTS: BookStatement[] = ["01", "02", "03", "04", "05", "06", "07", "08"].map((m) => ({
  id: `st-card-2025-${m}`,
  accountId: "card",
  documentId: `doc-card-2025-${m}`,
  documentTitle: `card-2025-${m}.pdf`,
  importedAt: "2025-09-01T00:00:00.000Z",
  status: "COMMITTED" as const,
  isSummary: false,
  periodStart: `2025-${m}-01`,
  periodEnd: `2025-${m}-${m === "02" ? "28" : ["04", "06"].includes(m) ? "30" : "31"}`,
  deltaCents: 0,
}));

function row(id: string, date: string, payee: string, cents: number, extra: Partial<BookRow> = {}): BookRow {
  const st = STATEMENTS.find((s) => s.periodStart <= date && date <= s.periodEnd)!;
  return {
    id,
    date,
    precision: "EXACT",
    statement: { start: st.periodStart, end: st.periodEnd },
    bookedOn: date,
    amountCents: -cents,
    lane: "EXPENSE",
    accountId: "card",
    payee,
    merchantKey: null,
    category: "Transportation",
    categoryGroup: null,
    counterpartyKind: null,
    counterpartyInstitution: null,
    counterpartyAccountHint: null,
    classifiedBy: null,
    transferMatchId: null,
    statementImportId: st.id,
    documentId: st.documentId,
    ...extra,
  };
}

const ROWS: BookRow[] = [
  row("gas-jan", "2025-01-15", "SHELL OIL 12345", 4_012, { category: "Gas" }),
  // A six-month premium: spread over Feb – Jul.
  row("ins-feb", "2025-02-03", "GEICO *AUTO", 60_000, { category: "Auto insurance" }),
  row("gas-mar", "2025-03-20", "SHELL OIL 12345", 3_850, { category: "Gas" }),
  // A garage the rules don't know: counted because the log names it.
  row("shop-may", "2025-05-10", "SPRINGFIELD TIRE & BRAKE", 21_500, { category: "Auto service" }),
  // Shared between the two cars, by the owner's word.
  row("ins-jul", "2025-07-02", "GEICO *AUTO", 66_000, { category: "Auto insurance" }),
  row("toll-aug", "2025-08-05", "E-ZPASS REPLENISH", 2_500, { category: "Tolls" }),
  // Filed by hand under another category: off the Car tab, whatever the merchant says.
  row("snacks-aug", "2025-08-20", "SHELL OIL 12345", 1_299, { category: "Groceries", classifiedBy: "USER" }),
  // Not car spending at all.
  row("food-aug", "2025-08-21", "EXAMPLE MARKET", 8_800, { category: "Groceries" }),
];

const entry = (e: Partial<CarEntry> & Pick<CarEntry, "id" | "date" | "kind" | "cents">) => ({ carId: "a", item: e.kind, ...e });

function settings(extra: Partial<Record<string, unknown>> = {}): GarageSettings {
  return normalizeGarage({
    version: 2,
    cars: [
      {
        id: "a",
        vehicle: { make: "Acme", model: "Roadster", purchaseDate: "2025-01-10", purchaseOdometer: 20_000, tankGallons: 12 },
        purchase: { priceCents: 1_800_000, feesCents: 50_000, warrantyCents: 0, registrationCents: 20_000, salesTaxCents: 30_000, interestCents: 120_000, loanPaidOffDate: "2027-01-10" },
        plan: { sellAtMiles: 120_000, residualCents: 400_000 },
        rentParking: [{ id: "p", fromMonth: "2025-03", toMonth: "2025-04", monthlyCents: 15_000 }],
      },
      { id: "b", vehicle: { make: "Volt", model: "Bolt", purchaseDate: "2025-06-01", purchaseOdometer: 5_000 }, purchase: { priceCents: 2_000_000 }, plan: { sellAtMiles: 105_000, residualCents: 0 } },
    ],
    entries: [
      // A hint matched to the January fill-up.
      entry({ id: "e-gas", date: "2025-01-15", kind: "FUEL", item: "Gas", cents: 4_012, gallons: 10.1, odometer: 20_300 }),
      entry({ id: "e-shop", date: "2025-05-10", kind: "REPAIR", item: "Front brakes", cents: 21_000, odometer: 23_400, links: [{ rowId: "shop-may", key: "" }] }),
      // Paid in cash: counts, on the owner's word.
      entry({ id: "e-wash", date: "2025-06-15", kind: "CARE", item: "Hand wash", cents: 2_000, offStatement: true }),
      // In the log, on no statement: counts nothing.
      entry({ id: "e-oil", date: "2025-04-02", kind: "MAINTENANCE", item: "Oil change", cents: 8_999, odometer: 22_100 }),
      // After the last statement in: awaiting it, counts nothing.
      entry({ id: "e-gas-sep", date: "2025-09-05", kind: "FUEL", item: "Gas", cents: 4_500, gallons: 11, odometer: 25_900 }),
      entry({ id: "e-odo", date: "2025-08-30", kind: "OTHER", item: "Odometer", cents: 0, odometer: 25_600 }),
    ],
    rowDecisions: { "ins-jul": { kind: "INSURANCE", carId: SHARED, key: "" } },
    defaultCarId: "a",
    ...extra,
  });
}

function makeBook(rows: BookRow[] = ROWS): Book {
  return {
    today: "2025-09-15",
    horizon: { cashFlow: "2025-08-31", netWorth: "2025-08-31" },
    ledger: { accounts: [], mergeDate: "2024-12-01", completeThrough: null, firstDay: "2025-01-01" },
    accounts: [{ id: "card", name: "Pat's card ••5678", subtype: "CREDIT_CARD", type: "CREDIT_CARD", institution: "Springfield Bank", group: "Credit cards", identifiers: [] }],
    statements: STATEMENTS,
    rows,
    rowById: new Map(rows.map((r) => [r.id, r])),
    stubs: [],
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
    persons: [],
    idle: { proven: [], unproven: [] },
    integrity: { checks: [], findings: [], inferences: [], accepted: [], stale: [], retired: [] },
    passes: [],
  } as unknown as Book;
}

const report = (book: Book, s: GarageSettings, carId = "a"): CarReport => buildGarage(s, book.rows, book.today, { statementsThrough: book.horizon.cashFlow }).cars.find((c) => c.carId === carId)!;
const fig = (x: Partial<CarFigureDescriptor>): CarFigureDescriptor => ({ report: "car", carId: "a", basis: "accrued", span: "toDate", ...x });
const cents = (p: Proof) => ("cents" in p.figure ? p.figure.cents : NaN);
const rowsOf = (p: Proof) => p.blocks.flatMap((b) => (b.kind === "rows" ? b.groups.flatMap((g) => g.rows) : []));

/** Every span the page shows a figure for: to date, the last 12 months, each calendar year and each month. */
const spansOf = (r: CarReport) => ["toDate", "last12", ...new Set(r.months.map((m) => m.month.slice(0, 4))), ...r.months.map((m) => m.month)];

describe("buildCarProof", () => {
  const book = makeBook();
  const s = settings();

  it("re-adds every accrued figure the page shows exactly, per line and in total, for each car", { timeout: 60_000 }, () => {
    for (const carId of ["a", "b"]) {
      const r = report(book, s, carId);
      for (const span of spansOf(r)) {
        for (const line of [undefined, ...COST_LINES]) {
          const p = buildCarProof(book, s, fig({ carId, span, ...(line ? { line } : {}) }));
          const shown = span === "toDate" ? (line ? r.accrued[line] : r.totals.tco) : span === "last12" ? (line ? r.last12.lines[line] : r.last12.total) : r.months.filter((m) => m.month.startsWith(span)).reduce((t, m) => t + (line ? m.lines[line] : m.total), 0);
          expect(cents(p), `${carId} ${span} ${line ?? "total"}`).toBe(shown);
          if (p.selfCheck) expect(p.selfCheck, `${carId} ${span} ${line ?? "total"}`).toMatchObject({ ok: true, deltaCents: 0 });
        }
      }
    }
  });

  it("re-adds what was paid to date, kind by kind", () => {
    const r = report(book, s);
    for (const line of [...CAR_KINDS, "INTEREST" as const]) {
      const p = buildCarProof(book, s, fig({ basis: "cash", line }));
      expect(cents(p), line).toBe(line === "INTEREST" ? r.cash.INTEREST : r.cash[line]);
      expect(p.selfCheck?.ok, line).toBe(true);
    }
  });

  it("lists statement rows only, grouped by statement, and never a row filed elsewhere by hand", () => {
    const p = buildCarProof(book, s, fig({}));
    const ids = rowsOf(p).map((r) => r.id);
    expect(new Set(ids)).toEqual(new Set(["gas-jan", "ins-feb", "gas-mar", "shop-may", "ins-jul", "toll-aug"]));
    const rowsBlock = p.blocks.find((b) => b.kind === "rows");
    expect(rowsBlock?.kind === "rows" && rowsBlock.groups.map((g) => g.statement.id).every((id) => id.startsWith("st-card-2025-"))).toBe(true);
    // The repair counts at the statement's amount, not the $210.00 logged.
    expect(rowsOf(buildCarProof(book, s, fig({ line: "REPAIR" })))).toMatchObject([{ id: "shop-may", countedCents: 21_500 }]);
  });

  it("names each matched log entry as a hint, never as money", () => {
    const p = buildCarProof(book, s, fig({ line: "REPAIR" }));
    const hints = p.blocks.find((b) => b.title === "From your log: hints, not money");
    expect(hints?.kind).toBe("breakdown");
    if (hints?.kind !== "breakdown") return;
    expect(hints.items).toHaveLength(1);
    expect(hints.items[0]!.value).toEqual({ text: "hint" });
    expect(hints.items[0]!.sub).toContain("2025-05-10 · Front brakes · 23,400 mi");
    expect(hints.items[0]!.sub).toContain("you logged $210.00");
  });

  it("lists log entries with no statement row as not counted, and they add nothing", { timeout: 60_000 }, () => {
    const p = buildCarProof(book, s, fig({}));
    const quiet = p.blocks.find((b) => b.title === "In your log, not on any statement: not counted");
    if (quiet?.kind !== "breakdown") throw new Error("no not-counted block");
    expect(quiet.items.map((i) => i.label).sort()).toEqual(["Gas", "Oil change"]);
    expect(quiet.items.every((i) => "text" in i.value && i.value.text === "$0 counted")).toBe(true);
    // Taking their amounts out of the log changes no figure. (Their odometer readings stay:
    // miles are facts about the car, and depreciation follows them.)
    const without = settings({
      entries: settings().entries.map((e) => (e.id === "e-oil" || e.id === "e-gas-sep" ? { ...e, kind: "OTHER", item: "Odometer", cents: 0, gallons: null } : e)),
    });
    const r = report(book, s);
    for (const span of spansOf(r))
      for (const line of [undefined, ...COST_LINES]) expect(cents(buildCarProof(book, without, fig({ span, ...(line ? { line } : {}) }))), `${span} ${line}`).toBe(cents(buildCarProof(book, s, fig({ span, ...(line ? { line } : {}) }))));
  });

  it("counts a spread premium and a shared policy only in part, and says why", () => {
    const mar = buildCarProof(book, s, fig({ span: "2025-03", line: "INSURANCE" }));
    const [row] = rowsOf(mar);
    expect(row).toMatchObject({ id: "ins-feb", amountCents: -60_000 });
    expect(row!.share).toBeGreaterThan(0.15);
    expect(row!.share).toBeLessThan(0.18);
    const part = mar.blocks.find((b) => b.title === "Rows that count only in part");
    expect(part?.kind === "breakdown" && part.items[0]!.sub).toMatch(/pays for 6 months/);
    // July's shared premium: half to each car.
    const julA = rowsOf(buildCarProof(book, s, fig({ basis: "cash", line: "INSURANCE" }))).find((r) => r.id === "ins-jul");
    expect(julA?.countedCents).toBe(33_000);
    const julB = rowsOf(buildCarProof(book, s, fig({ carId: "b", basis: "cash", line: "INSURANCE" }))).find((r) => r.id === "ins-jul");
    expect(julB?.countedCents).toBe(33_000);
  });

  it("names what isn't on a statement for what it is", () => {
    const p = buildCarProof(book, s, fig({}));
    const made = p.blocks.find((b) => b.title === "What it's made of");
    if (made?.kind !== "breakdown") throw new Error("no parts");
    expect(made.items.map((i) => i.label)).toEqual(["Statement rows", "Paid outside the statements", "Parking in the rent", "Financing interest", "Depreciation"]);
    expect(p.blocks.some((b) => b.title === "Paid outside the statements (your word)")).toBe(true);
    expect(p.blocks.some((b) => b.title === "Parking in the rent (typed)")).toBe(true);
  });

  it("works depreciation out as a chain of typed inputs and the odometer", () => {
    const r = report(book, s);
    const p = buildCarProof(book, s, fig({ line: "DEPRECIATION" }));
    const chain = p.blocks.find((b) => b.kind === "chain");
    if (chain?.kind !== "chain") throw new Error("no chain");
    expect(chain.lines.map((l) => l.source)).toEqual(["assumption", "assumption", "assumption", "derived", "assumption", "estimate"]);
    expect(chain.lines.at(-1)!.value).toEqual({ cents: r.accrued.DEPRECIATION });
    expect(p.selfCheck).toBeNull();
    expect(rowsOf(p)).toEqual([]);
  });

  it("gives a rate as the total over miles or months, the miles marked as the log's", () => {
    const r = report(book, s);
    const mile = buildCarProof(book, s, fig({ per: "mile" }));
    expect(mile.figure).toEqual({ cents: r.totals.perMile });
    const chain = mile.blocks[0];
    expect(chain?.kind === "chain" && chain.lines.map((l) => l.source)).toEqual(["derived", "assumption", "derived"]);
    expect(buildCarProof(book, s, fig({ per: "month" })).figure).toEqual({ cents: r.totals.perMonth });
    expect(buildCarProof(book, s, fig({ span: "last12", per: "mile" })).figure).toEqual({ cents: r.last12.perMile });
  });

  it("proves one log line at its full amount", () => {
    const g = buildGarage(s, book.rows, book.today, { statementsThrough: book.horizon.cashFlow });
    for (const i of g.log.filter((x) => x.counted)) {
      const p = buildCarProof(book, s, { report: "car", itemId: i.id });
      expect(p.figure, i.id).toEqual({ cents: i.cents });
      if (i.source === "STATEMENT") expect(p.selfCheck?.ok, i.id).toBe(true);
      else expect(rowsOf(p)).toEqual([]);
    }
    const shared = buildCarProof(book, s, { report: "car", itemId: "r:ins-jul" });
    expect(rowsOf(shared)).toMatchObject([{ id: "ins-jul", countedCents: 66_000 }]);
  });

  it("links a month's car rows to cash flow only where it's the same figure", () => {
    const aug = buildCarProof(book, s, fig({ span: "2025-08" }));
    const cf = aug.blocks.find((b) => b.title === "The same figure in cash flow");
    if (cf?.kind !== "breakdown") throw new Error("no cash-flow link");
    // Tolls are the same rows both ways; the shared premium is spread and halved, so it isn't.
    expect(cf.items.map((i) => i.label)).toEqual(["Tolls"]);
    expect(cf.items[0]!.link?.descriptor).toMatchObject({ report: "cash-flow", metric: "spending", category: "Tolls", start: "2025-08-01", end: "2025-08-31" });
    // A second Tolls row cash flow counts but the car doesn't (a different car's E-ZPass, filed by hand) breaks the match.
    const other = makeBook([...ROWS, row("toll-x", "2025-08-25", "E-ZPASS REPLENISH", 1_000, { category: "Tolls", classifiedBy: "USER" })]);
    const s2 = settings({ rowDecisions: { ...settings().rowDecisions, "toll-x": { kind: "IGNORE", carId: null, key: "" } } });
    expect(buildCarProof(other, s2, fig({ span: "2025-08" })).blocks.some((b) => b.title === "The same figure in cash flow")).toBe(false);
  });
});

describe("parseDescriptor (car)", () => {
  it("accepts a figure's recipe and rejects anything else", () => {
    expect(parseDescriptor({ report: "car", carId: "a", span: "2025" })).toEqual({ report: "car", carId: "a", basis: "accrued", span: "2025" });
    expect(parseDescriptor({ report: "car", itemId: "r:x" })).toEqual({ report: "car", itemId: "r:x" });
    expect(parseDescriptor({ report: "car", carId: "a", span: "2025-13" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "car", carId: "a", span: "last12", basis: "cash" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "car", carId: "a", span: "toDate", line: "PAYMENT" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "car", carId: "a", span: "toDate", basis: "cash", line: "PAYMENT" })).not.toHaveProperty("error");
    expect(parseDescriptor({ report: "car", carId: "a", span: "toDate", per: "gallon" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "car", span: "toDate" })).toHaveProperty("error");
  });
});

describe("car as a registered proof kind", () => {
  const s = settings();
  const ctx = () => ({ book: makeBook(), db: { appSetting: { findUnique: async () => ({ value: JSON.stringify(s) }) } } as never });
  const links = (p: Proof): ProofLink[] =>
    p.blocks.flatMap((b) => (b.kind === "breakdown" ? b.items.flatMap((i) => (i.link ? [i.link] : [])) : b.kind === "chain" ? b.lines.flatMap((l) => (l.link ? [l.link] : [])) : []));

  it("emits links that parse, build and come to the part they came from", { timeout: 60_000 }, async () => {
    const c = ctx();
    const seen = new Set<string>();
    const queue: CarDescriptor[] = [fig({}), fig({ per: "mile" }), fig({ span: "last12" }), fig({ basis: "cash" })];
    let followed = 0;
    while (queue.length) {
      const d = queue.shift()!;
      const p = await buildProof(c, d);
      for (const b of p.blocks) {
        if (b.kind !== "breakdown") continue;
        for (const i of b.items) {
          if (!i.link) continue;
          const parsed = parseDescriptor(JSON.parse(JSON.stringify(i.link.descriptor)));
          expect(parsed, i.link.label).not.toHaveProperty("error");
          const q = await buildProof(c, parsed as never);
          if (q.selfCheck) expect(q.selfCheck.ok, i.link.label).toBe(true);
          // A part's link opens a proof of exactly that part.
          expect(q.figure, `${b.title} · ${i.label}`).toEqual(i.value);
          followed++;
          const key = JSON.stringify(parsed);
          if (q.report === "car" && !seen.has(key)) {
            seen.add(key);
            queue.push(parsed as CarDescriptor);
          }
        }
      }
      for (const l of links(p)) expect(parseDescriptor(JSON.parse(JSON.stringify(l.descriptor))), l.label).not.toHaveProperty("error");
    }
    expect(followed).toBeGreaterThan(20);
  });

  it("reads the garage from the database, as the page does", async () => {
    const p = await buildProof(ctx(), fig({}));
    expect(cents(p)).toBe(report(makeBook(), s).totals.tco);
    expect(p.describes).toBe("Acme Roadster · Cost of ownership, to date (through 2025-09-15)");
  });
});
