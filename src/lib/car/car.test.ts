import { describe, expect, it } from "vitest";
import type { MatchRow } from "./detect";
import { carMatcher, reconcile, rowKey, statementCharges } from "./detect";
import { addMonths, buildGarage } from "./report";
import { normalizeGarage, SHARED, type CarEntry, type GarageSettings } from "./settings";

const entry = (e: Partial<CarEntry> & Pick<CarEntry, "date" | "kind" | "cents">): Partial<CarEntry> => ({ id: `${e.carId ?? "a"}-${e.date}-${e.kind}-${e.cents}`, carId: "a", item: e.kind, ...e });
/** An entry whose own amount counts (paid outside the statements): for the figures' arithmetic. */
const paid = (e: Partial<CarEntry> & Pick<CarEntry, "date" | "kind" | "cents">) => entry({ ...e, offStatement: true });

const acme = {
  id: "a",
  vehicle: { make: "Acme", model: "Roadster", purchaseDate: "2025-01-10", purchaseOdometer: 20_000, inServiceDate: "2023-01-10", tankGallons: 10 },
  purchase: { priceCents: 1_800_000, feesCents: 50_000, warrantyCents: 100_000, registrationCents: 20_000, salesTaxCents: 30_000 },
  plan: { sellAtMiles: 120_000, residualCents: 0, warrantyMiles: 60_000, warrantyYears: 5 },
};
const bolt = {
  id: "b",
  vehicle: { make: "Volt", model: "Bolt", purchaseDate: "2025-06-01", purchaseOdometer: 5_000 },
  purchase: { priceCents: 2_000_000 },
  plan: { sellAtMiles: 105_000, residualCents: 0 },
};

/** One car (Acme) with whatever else is given. */
const garage = (extra: Record<string, unknown> = {}, carExtra: Record<string, unknown> = {}): GarageSettings =>
  normalizeGarage({ version: 2, cars: [{ ...acme, ...carExtra }], ...extra });
const report = (g: GarageSettings, rows: MatchRow[], today: string) => buildGarage(g, rows, today).cars[0]!;
const hintsOf = (g: GarageSettings, rows: MatchRow[], through?: string) => reconcile(rows, g, { statementsThrough: through }).hints;

let n = 0;
const row = (date: string, payee: string, dollars: number, extra: Partial<MatchRow> = {}): MatchRow => ({
  id: `r${++n}`,
  date,
  amountCents: -Math.round(dollars * 100),
  lane: "EXPENSE",
  payee,
  merchantKey: null,
  category: "Transportation",
  accountId: "card",
  ...extra,
});

describe("the garage settings", () => {
  it("turns a one-car log into the garage's first car, keeping every entry and decision its own", () => {
    const g = normalizeGarage({
      version: 1,
      vehicle: { make: "Zephyr", purchaseDate: "2025-05-03", purchaseOdometer: 40_000 },
      purchase: { priceCents: 1_500_000 },
      entries: [{ id: "e1", date: "2025-06-01", kind: "FUEL", cents: 4000, rowId: "r9" }],
      values: [{ id: "v", date: "2025-07-18", privateCents: 1_463_200, source: "Workbook" }],
      rowDecisions: { r1: "IGNORE", r2: "TAX_REG" },
      workbook: { path: "C:/x.xlsx", syncedAt: "2026-01-01" },
    });
    expect(g.cars.map((c) => [c.id, c.vehicle.make, c.purchase.priceCents])).toEqual([["car-1", "Zephyr", 1_500_000]]);
    expect(g.entries.map((e) => [e.carId, e.links, e.offStatement])).toEqual([["car-1", [{ rowId: "r9", key: "" }], false]]);
    expect(g.rowDecisions).toEqual({ r1: { kind: "IGNORE", carId: null, key: "" }, r2: { kind: "TAX_REG", carId: null, key: "" } });
    expect(g.cars[0]!.values[0]!.source).toBe("");
    expect("workbook" in g).toBe(false);
  });

  it("keeps entries pointing at a car that exists (or shared)", () => {
    const g = normalizeGarage({ version: 2, cars: [acme, bolt], entries: [entry({ date: "2025-07-01", kind: "PARKING", cents: 100, carId: "gone" }), entry({ date: "2025-07-01", kind: "PARKING", cents: 200, carId: SHARED })] });
    expect(g.entries.map((e) => e.carId)).toEqual([SHARED, SHARED]);
  });
});

describe("which statement rows are car costs", () => {
  const match = carMatcher(garage());

  it("counts gas stations, insurers, parking and tolls; suggests the uncertain ones; skips look-alikes", () => {
    expect(match(row("2025-02-01", "SHELL OIL 57444", 40))).toMatchObject({ kind: "FUEL", counted: true });
    expect(match(row("2025-02-01", "GEICO *AUTO", 120))).toMatchObject({ kind: "INSURANCE", counted: true });
    expect(match(row("2025-02-01", "E-ZPASS REPLENISH", 25))).toMatchObject({ kind: "TOLLS", counted: true });
    expect(match(row("2025-02-01", "AUTOZONE 1234", 25))).toMatchObject({ kind: "REPAIR", counted: false });
    expect(match(row("2025-02-01", "TOWN OF X TAX COLLECTOR", 250))).toMatchObject({ kind: "TAX_REG", counted: false });
    expect(match(row("2025-02-01", "ACME MOTOR FINANCE", 400))).toMatchObject({ kind: "PAYMENT", counted: false });
    expect(match(row("2025-02-01", "ACME OF SPRINGFIELD SERVICE", 150))).toMatchObject({ kind: "MAINTENANCE", how: "make", carId: "a" });
    expect(match(row("2025-02-01", "UBER TRIP", 20))).toBeNull();
    expect(match(row("2025-02-01", "NATURAL GAS CO", 80, { category: "Housing & utilities" }))).toBeNull();
    expect(match(row("2025-02-01", "SHELL OIL", 40, { lane: "TRANSFER" }))).toBeNull();
  });

  it("reads the statement's second line, and doesn't take a health insurer for a car insurer", () => {
    // Amex prints the merchant's category under the name.
    expect(match(row("2025-02-01", "HILLTOP CAR SPA LLC", 17, { detail: "CAR WASH" }))).toMatchObject({ kind: "CARE", counted: true });
    expect(match(row("2025-02-01", "TOLLWAY REBILL 800-555-0100", 25, { detail: "E-ZPASS REBILL" }))).toMatchObject({ kind: "TOLLS", counted: true });
    expect(match(row("2025-02-01", "United Healthcar Ins Paymnt PPD ID: 9724763006", -24.95))).toBeNull();
  });

  it("knows a pump by its store number even when the statement prints only the street", () => {
    const g = garage();
    const rows = [
      row("2025-02-01", "SHELL SERVICE STATION 10004242001 SPRINGFIELD", 30),
      // Filed under Dining by the issuer, and no name a rule knows.
      row("2025-03-01", "12 MAIN STREET 10004242001 SPRINGFIELD", 28, { category: "Dining" }),
      row("2025-03-02", "12 MAIN STREET 99999999 SPRINGFIELD", 28, { category: "Dining" }),
    ];
    const c = statementCharges(rows, g);
    expect(c.map((x) => [x.payee.slice(0, 14), x.status, x.kind, x.how])).toEqual([
      ["SHELL SERVICE ", "COUNTED", "FUEL", "rule"],
      ["12 MAIN STREET", "COUNTED", "FUEL", "store"],
    ]);
  });

  it("only suggests an insurer that was being paid before there was a car (renters insurance)", () => {
    const rows = [row("2024-03-18", "STATE FARM INSURANCE", 12), row("2025-02-19", "STATE FARM INSURANCE", 17.75), row("2025-02-13", "GEICO AUTO", 158)];
    expect(statementCharges(rows, garage()).map((c) => [c.payee, c.status])).toEqual([
      ["GEICO AUTO", "COUNTED"],
      ["STATE FARM INSURANCE", "SUGGESTED"],
    ]);
  });

  it("follows the owner's decisions and keywords, including never-the-car keywords", () => {
    const rows = [row("2025-02-03", "SHELL OIL", 30), row("2025-02-04", "AUTOZONE", 20), row("2025-02-05", "STATE FARM INSURANCE", 18)];
    const g = garage({ rowDecisions: { [rows[0]!.id]: { kind: "IGNORE" }, [rows[1]!.id]: { kind: "EQUIPMENT" } }, matchRules: [{ id: "k", pattern: "STATE FARM", kind: "IGNORE" }] });
    expect(statementCharges(rows, g).map((c) => [c.status, c.kind])).toEqual([
      ["IGNORED", "FUEL"],
      ["COUNTED", "EQUIPMENT"],
      ["IGNORED", "OTHER"],
    ]);
  });

  it("finds a decision again after a re-import gives the row a new id", () => {
    const old = row("2025-02-04", "AUTOZONE", 20);
    const g = garage({ rowDecisions: { [old.id]: { kind: "EQUIPMENT", key: rowKey(old) } } });
    const reimported = { ...old, id: "new-id" };
    expect(statementCharges([reimported], g).map((c) => [c.rowId, c.status, c.kind])).toEqual([["new-id", "COUNTED", "EQUIPMENT"]]);
  });

  it("reads an insurer's term from the gap between its charges", () => {
    const monthly = [row("2025-02-18", "GEICO AUTO", 100), row("2025-03-18", "GEICO AUTO", 100), row("2025-04-18", "GEICO AUTO", 100)];
    expect(report(garage(), monthly, "2025-05-01").insurance.premiums.map((p) => p.months)).toEqual([1, 1, 1]);
    const semi = [row("2025-02-01", "PROGRESSIVE INS", 900), row("2025-08-01", "PROGRESSIVE INS", 950)];
    const r = report(garage(), semi, "2025-09-01");
    expect(r.insurance.premiums.map((p) => p.months)).toEqual([6, 6]);
    expect(r.insurance.renewsOn).toBe("2026-02-01");
  });
});

describe("log entries are notes on statement charges, never money of their own", () => {
  it("matches an entry to its charge: counted once, at the statement's amount, under the statement's name", () => {
    const g = garage({ entries: [entry({ date: "2025-02-01", kind: "FUEL", item: "Gas", cents: 3000, gallons: 10, odometer: 20300 })] });
    const rows = [row("2025-02-03", "SHELL OIL 123", 30), row("2025-02-20", "SHELL OIL 123", 35), row("2024-12-01", "SHELL OIL 123", 30)];
    const out = buildGarage(g, rows, "2025-03-01");
    expect(out.statements.hints.map((h) => [h.status, h.how, h.rows.map((r) => r.payee)])).toEqual([["MATCHED", "exact", ["SHELL OIL 123"]]]);
    expect(out.cars[0]!.cash.FUEL).toBe(3000 + 3500);
    const fill = out.log.find((i) => i.entryIds.length)!;
    expect([fill.item, fill.label, fill.gallons, fill.counted]).toEqual(["SHELL OIL 123", "Gas", 10, true]);
    expect(out.statements.audit).toMatchObject({ doubleCounted: [], matched: 1, notFound: 0, offStatementCents: 0 });
  });

  it("counts nothing for an entry with no charge, unless the owner says it was paid outside the statements", () => {
    const e = entry({ date: "2025-02-01", kind: "EQUIPMENT", item: "Dashcam", cents: 31_250 });
    const rows = [row("2025-03-01", "SHELL OIL", 30)];
    const out = buildGarage(garage({ entries: [e] }), rows, "2025-03-15");
    expect(out.statements.hints[0]).toMatchObject({ status: "NOT_FOUND" });
    expect(out.cars[0]!.cash.EQUIPMENT).toBe(0);
    expect(out.log.find((i) => i.item === "Dashcam")).toMatchObject({ counted: false });
    const off = buildGarage(garage({ entries: [{ ...e, offStatement: true }] }), rows, "2025-03-15");
    expect(off.statements.hints[0]).toMatchObject({ status: "OFF_STATEMENT" });
    expect(off.cars[0]!.cash.EQUIPMENT).toBe(31_250);
    expect(off.statements.audit.offStatementCents).toBe(31_250);
  });

  it("waits for a statement that isn't in yet rather than calling the entry missing", () => {
    const g = garage({ entries: [entry({ date: "2025-09-06", kind: "FUEL", cents: 4120 })] });
    expect(hintsOf(g, [row("2025-08-01", "SHELL", 20)], "2025-08-31")[0]).toMatchObject({ status: "AWAITING" });
  });

  it("matches a charge whatever the issuer filed it under", () => {
    const g = garage({ entries: [entry({ date: "2025-08-30", kind: "FUEL", cents: 2418 })] });
    const rows = [row("2025-08-30", "12 MAIN STREET 10004242001 SPRINGFIELD", 24.18, { category: "Dining" })];
    expect(hintsOf(g, rows)[0]).toMatchObject({ status: "MATCHED", how: "exact", confidence: "strong" });
    expect(statementCharges(rows, g).map((c) => [c.kind, c.status, c.how])).toEqual([["FUEL", "COUNTED", "log"]]);
  });

  it("takes a near amount only at a car merchant of that kind, and says so", () => {
    const g = garage({ entries: [entry({ date: "2025-06-25", kind: "FUEL", cents: 3610 }), entry({ date: "2025-06-25", kind: "CARE", cents: 1700 })] });
    const rows = [row("2025-06-26", "EXXON RIVERSIDE", 36.40), row("2025-06-25", "THAI KITCHEN", 17.02, { category: "Dining" })];
    const [fuel, wash] = hintsOf(g, rows);
    expect(fuel).toMatchObject({ status: "MATCHED", how: "close", confidence: "check", statementCents: 3640 });
    expect(wash).toMatchObject({ status: "NOT_FOUND" });
  });

  it("finds a tax paid with a card fee as two rows that add up to it", () => {
    const g = garage({ entries: [entry({ date: "2025-06-18", kind: "TAX_REG", item: "Tax", cents: 25_118, months: 12 })] });
    const rows = [row("2025-06-18", "TOWN OF SPRINGFIELD 1 Main St", 244.11, { category: "Taxes & fees" }), row("2025-06-18", "CITYPAY FEE SPRINGF WEB PMT", 7.07), row("2025-06-18", "TACO SPOT", 7.07, { category: "Dining" })];
    const [h] = hintsOf(g, rows);
    expect(h).toMatchObject({ status: "MATCHED", how: "split", statementCents: 25_118 });
    expect(h!.rows.map((r) => r.payee).sort()).toEqual(["CITYPAY FEE SPRINGF WEB PMT", "TOWN OF SPRINGFIELD 1 Main St"]);
    // One cost for the two rows, named as the statement prints them.
    const out = buildGarage(g, rows, "2025-07-01");
    expect(out.log.filter((i) => i.counted).map((i) => [i.item, i.cents, i.rowIds.length])).toEqual([["TOWN OF SPRINGFIELD 1 Main St + CITYPAY FEE SPRINGF WEB PMT", 25_118, 2]]);
  });

  it("finds one payment for two months of a loan, and counts it once", () => {
    const g = garage({
      entries: [
        entry({ date: "2025-06-26", kind: "PAYMENT", item: "Car Note", cents: 41_237 }),
        entry({ date: "2025-07-26", kind: "PAYMENT", item: "Car Note", cents: 41_237 }),
        entry({ date: "2025-07-31", kind: "PAYMENT", item: "Car Note", cents: 41_237 }),
      ],
    });
    const rows = [row("2025-06-30", "Online Payment 11110000001 To Lender 9999", 824.74), row("2025-07-31", "Online Payment 11110000002 To Lender 9999", 412.37)];
    const hs = hintsOf(g, rows);
    expect(hs.map((h) => [h.date, h.how, h.statementCents])).toEqual([
      ["2025-06-26", "combined", 82_474],
      ["2025-07-26", "combined", 82_474],
      ["2025-07-31", "exact", 41_237],
    ]);
    const out = buildGarage(g, rows, "2025-08-15");
    expect(out.cars[0]!.cash.PAYMENT).toBe(82_474 + 41_237);
    expect(out.statements.audit).toMatchObject({ doubleCounted: [], matchedLoggedCents: 3 * 41_237, matchedStatementCents: 82_474 + 41_237 });
  });

  it("reads a 6-month premium paid monthly as the monthly charges, adding nothing itself", () => {
    const g = garage({ entries: [entry({ date: "2025-02-12", kind: "INSURANCE", item: "Insurance", cents: 88_416, months: 6 })] });
    const rows = ["02-12", "03-13", "04-13", "05-13", "06-13", "07-13", "08-13"].map((d) => row(`2025-${d}`, "STATE FARM AUTO INS", 147.36));
    const [h] = hintsOf(g, rows);
    expect(h).toMatchObject({ status: "INSTALLMENTS", confidence: "strong" });
    expect(h!.rows).toHaveLength(6);
    const out = buildGarage(g, rows, "2025-09-01");
    expect(out.cars[0]!.cash.INSURANCE).toBe(7 * 14_736);
  });

  it("never offers a row the owner said an entry isn't, and keeps a row the owner picked across a re-import", () => {
    const rows = [row("2025-02-01", "SHELL OIL", 30), row("2025-02-02", "SHELL OIL", 30)];
    const e = entry({ date: "2025-02-01", kind: "FUEL", cents: 3000 });
    expect(hintsOf(garage({ entries: [e] }), rows)[0]!.rows[0]!.rowId).toBe(rows[0]!.id);
    expect(hintsOf(garage({ entries: [{ ...e, rejected: [rowKey(rows[0]!)] }] }), rows)[0]!.rows[0]!.rowId).toBe(rows[1]!.id);
    const pinned = garage({ entries: [{ ...e, links: [{ rowId: "gone", key: rowKey(rows[1]!) }] }] });
    expect(hintsOf(pinned, rows)[0]).toMatchObject({ how: "pinned", confidence: "sure", rows: [{ rowId: rows[1]!.id }] });
  });

  it("gives each row to at most one entry, nearest first", () => {
    const g = garage({ entries: [entry({ id: "x", date: "2025-02-01", kind: "FUEL", cents: 3000 }), entry({ id: "y", date: "2025-02-05", kind: "FUEL", cents: 3000 })] });
    const rows = [row("2025-02-04", "SHELL OIL", 30)];
    const hs = hintsOf(g, rows);
    expect(hs.map((h) => [h.entryId, h.status])).toEqual([
      ["x", "NOT_FOUND"],
      ["y", "MATCHED"],
    ]);
  });

  it("never counts a row twice, however the entries and rows line up", () => {
    // Many entries and rows of the same few amounts, in every kind of match at once.
    const entries = [];
    const rows: MatchRow[] = [];
    for (let i = 0; i < 40; i++) {
      const d = `2025-${String(2 + (i % 9)).padStart(2, "0")}-${String(1 + ((i * 7) % 27)).padStart(2, "0")}`;
      entries.push(entry({ id: `e${i}`, date: d, kind: i % 3 ? "FUEL" : "PARKING", cents: [3000, 4500, 2000][i % 3]!, offStatement: i % 13 === 0 }));
      rows.push(row(d, i % 2 ? "SHELL OIL" : "CITY PARKING", [30, 45, 20, 10][i % 4]!));
      if (i % 5 === 0) rows.push(row(d, "FEE", 10));
    }
    const out = buildGarage(garage({ entries }), rows, "2025-12-31");
    expect(out.statements.audit.doubleCounted).toEqual([]);
    const ids = out.log.filter((i) => i.counted).flatMap((i) => i.rowIds);
    expect(new Set(ids).size).toBe(ids.length);
    // Counted money is exactly the counted rows plus what the owner marked paid outside the statements.
    const rowCents = new Map(rows.map((r) => [r.id, -r.amountCents]));
    const offStatement = out.statements.hints.filter((h) => h.status === "OFF_STATEMENT").reduce((s, h) => s + h.cents, 0);
    const counted = out.log.filter((i) => i.counted).reduce((s, i) => s + i.cents, 0);
    expect(counted).toBe(ids.reduce((s, id) => s + rowCents.get(id)!, 0) + offStatement);
  });
});

describe("more than one car", () => {
  const two = (extra: Record<string, unknown> = {}) => normalizeGarage({ version: 2, cars: [acme, bolt], ...extra });

  it("gives a charge to the one car owned that day, and with two, to the usual car until the owner picks", () => {
    const rows = [row("2025-03-01", "SHELL OIL", 30), row("2025-07-01", "SHELL OIL", 40), row("2025-07-02", "SHELL OIL", 41)];
    const g = two({ defaultCarId: "b", rowDecisions: { [rows[2]!.id]: { kind: "FUEL", carId: "a" } } });
    expect(statementCharges(rows, g).map((c) => [c.carId, c.carGuessed])).toEqual([
      ["a", false],
      ["b", true],
      ["a", false],
    ]);
    const r = buildGarage(g, rows, "2025-08-01");
    expect(r.statements.guessed).toBe(1);
    expect(r.cars.map((c) => c.cash.FUEL)).toEqual([3000 + 4100, 4000]);
  });

  it("gives a charge a log entry matched to the entry's car", () => {
    const rows = [row("2025-07-01", "SHELL OIL", 40)];
    const g = two({ defaultCarId: "a", entries: [entry({ date: "2025-07-01", kind: "FUEL", cents: 4000, carId: "b", gallons: 10, odometer: 5300 })] });
    expect(statementCharges(rows, g).map((c) => [c.carId, c.carGuessed, c.how])).toEqual([["b", false, "log"]]);
  });

  it("splits a shared cost between the cars owned that day", () => {
    const g = two({
      entries: [
        paid({ date: "2025-03-01", kind: "PARKING", cents: 9000, carId: SHARED }),
        paid({ date: "2025-07-01", kind: "PARKING", cents: 9000, carId: SHARED }),
        paid({ date: "2025-07-02", kind: "FUEL", cents: 4000, carId: "b", gallons: 10, odometer: 5300 }),
      ],
    });
    const r = buildGarage(g, [], "2025-08-01");
    expect(r.cars.map((c) => c.cash.PARKING)).toEqual([9000 + 4500, 4500]);
    expect(r.cars.map((c) => c.cash.FUEL)).toEqual([0, 4000]);
    // The log shows each cost once, at its full amount.
    expect(r.log.filter((i) => i.kind === "PARKING").map((i) => [i.carId, i.cents])).toEqual([
      [SHARED, 9000],
      [SHARED, 9000],
    ]);
  });

  it("stops a sold car's figures at the sale and counts what it really lost", () => {
    const g = normalizeGarage({
      version: 2,
      cars: [{ ...acme, sale: { date: "2025-06-30", odometer: 25_000, priceCents: 1_600_000 } }, bolt],
      entries: [paid({ date: "2025-02-01", kind: "FUEL", cents: 3000, gallons: 10, odometer: 20_300 })],
    });
    const rows = [row("2025-07-15", "SHELL OIL", 40)];
    const r = buildGarage(g, rows, "2025-10-01");
    const [a, b] = r.cars;
    expect(a!.sold).toBe(true);
    expect(a!.through).toBe("2025-06-30");
    expect(a!.odometer.driven).toBe(5000);
    // All-in 2,000,000 less 1,600,000 sold for.
    expect(a!.accrued.DEPRECIATION).toBe(400_000);
    expect(a!.depreciation.method).toBe("SOLD");
    expect(a!.months.at(-1)!.month).toBe("2025-06");
    expect(a!.outlook12.total).toBe(0);
    // After the sale, the gas goes to the car still owned.
    expect(b!.cash.FUEL).toBe(4000);
  });
});

describe("the car report", () => {
  const g = garage(
    {
      entries: [
        paid({ date: "2025-01-12", kind: "INSURANCE", cents: 60_000, months: 6 }),
        paid({ date: "2025-02-01", kind: "FUEL", cents: 3000, gallons: 10, odometer: 20_300 }),
        paid({ date: "2025-02-10", kind: "FUEL", cents: 1500, gallons: 5, odometer: 20_420, partial: true }),
        paid({ date: "2025-02-20", kind: "FUEL", cents: 1500, gallons: 5, odometer: 20_600 }),
        paid({ date: "2025-03-01", kind: "PAYMENT", cents: 50_000 }),
        paid({ date: "2025-04-11", kind: "FUEL", cents: 3200, gallons: 10, odometer: 21_000 }),
      ],
    },
    { rentParking: [{ id: "p", fromMonth: "2025-02", toMonth: null, monthlyCents: 10_000 }] },
  );
  const r = report(g, [], "2025-04-11");

  it("measures MPG from full fill to full fill, folding partial fills in", () => {
    expect(r.fuel.fills.map((f) => [f.miles, f.gallons, f.mpg])).toEqual([
      [300, 10, 30],
      [300, 10, 30],
      [400, 10, 40],
    ]);
    expect(r.fuel.fills[1]!.folded).toBe(1);
    expect(r.fuel.mpg).toBeCloseTo(1000 / 30);
    expect(r.fuel.avgRange).toBeCloseTo((1000 / 30) * 10);
  });

  it("restarts MPG after a fill-up whose gallons aren't known", () => {
    const x = report(g, [row("2025-03-15", "SHELL OIL", 25)], "2025-04-11");
    expect(x.fuel.fills.map((f) => f.mpg)).toEqual([30, 30]);
    expect(x.fuel.withoutDetail).toBe(1);
  });

  it("keeps a fill-up with no charge in the MPG (gallons and miles are facts) but leaves its price unknown", () => {
    const missing = garage({ entries: [entry({ date: "2025-02-01", kind: "FUEL", cents: 3000, gallons: 10, odometer: 20_300 }), entry({ date: "2025-02-20", kind: "FUEL", cents: 3000, gallons: 10, odometer: 20_600 })] });
    const x = report(missing, [row("2025-02-01", "SHELL OIL", 30)], "2025-03-01");
    expect(x.fuel.fills.map((f) => [f.mpg, f.cents, f.pricePerGallon])).toEqual([
      [30, 3000, 300],
      [30, null, null],
    ]);
    expect(x.cash.FUEL).toBe(3000);
    expect(x.fuel.pricePerGallon).toBe(300);
  });

  it("takes the odometer from every log entry, matched or not", () => {
    const x = report(garage({ entries: [entry({ date: "2025-03-01", kind: "OTHER", cents: 0, odometer: 21_500 }), entry({ date: "2025-04-01", kind: "REPAIR", cents: 9999, odometer: 22_000 })] }), [], "2025-04-11");
    expect(x.odometer.current).toBe(22_000);
    expect(x.cash.REPAIR).toBe(0);
  });

  it("spreads a premium over its term and counts parking in rent every month", () => {
    // Jan 12 → Jul 12 is 181 days; Jan 12 → Apr 11 inclusive is 90 of them.
    expect(r.accrued.INSURANCE).toBe(Math.round((60_000 * 90) / 181));
    expect(r.cash.INSURANCE).toBe(60_000);
    // February and March in full, April through the 11th.
    expect(r.accrued.PARKING).toBe(20_000 + Math.round((10_000 * 11) / 30));
    expect(r.items.filter((i) => i.source === "RENT").map((i) => i.date)).toEqual(["2025-02-01", "2025-03-01", "2025-04-01"]);
  });

  it("depreciates per mile toward the selling odometer and leaves car payments out of the cost", () => {
    // All-in 2,000,000 over 100,000 miles: 20 cents a mile; 1,000 miles driven.
    expect(r.depreciation.plannedPerMile).toBe(20);
    expect(r.accrued.DEPRECIATION).toBe(20_000);
    expect(r.odometer.driven).toBe(1000);
    const costs = r.accrued.INSURANCE + r.accrued.PARKING + r.accrued.FUEL + r.accrued.DEPRECIATION;
    expect(r.totals.tco).toBe(costs);
    expect(r.totals.perMile).toBeCloseTo(costs / 1000);
    expect(r.cash.PAYMENT).toBe(50_000);
    expect(r.totals.marginalPerMile).toBeCloseTo(9200 / 1000 + 20);
  });

  it("adds up the months to the totals", () => {
    expect(r.months.map((m) => m.month)).toEqual(["2025-01", "2025-02", "2025-03", "2025-04"]);
    expect(r.months.reduce((t, m) => t + m.miles, 0)).toBe(1000);
    expect(Math.abs(r.months.at(-1)!.cumulativeTotal - r.totals.tco)).toBeLessThanOrEqual(r.months.length);
  });

  it("values the car from the market checks when asked", () => {
    const m = report(garage({ entries: g.entries }, { plan: { ...acme.plan, depreciation: "MARKET" }, values: [{ id: "v", date: "2025-03-01", privateCents: 1_700_000, tradeInCents: null, source: "" }] }), [], "2025-04-11");
    expect(m.depreciation.method).toBe("MARKET");
    expect(m.depreciation.marketValueNow).toBe(1_700_000);
    expect(m.accrued.DEPRECIATION).toBe(300_000);
  });

  it("tracks the warranty", () => {
    expect(r.warranty.expiresOn).toBe("2028-01-10");
    expect(r.warranty.milesLeft).toBe(60_000 - 21_000);
    // 39,000 miles left at ~11 a day outlasts the five years.
    expect(r.warranty.endsBy).toBe("TIME");
    expect(r.warranty.breakEvenPerDay).toBeCloseTo(39_000 / 1004);
  });

  it("schedules the next service from the grid and the months since the last one", () => {
    const done = report(garage({ entries: g.entries }, { serviceVisits: [{ id: "a", date: "2025-01-10", odometer: null, milestoneMiles: 24_000, note: "" }] }), [], "2025-04-11");
    expect(done.service.milestones[0]).toMatchObject({ miles: 24_000, status: "DONE" });
    expect(done.service.next).toMatchObject({ miles: 32_000, status: "NEXT" });
    // Done at 20,000 (the odometer that day): due 8,000 on, at 28,000, before the 32k column.
    expect(done.service.dueMiles).toBe(28_000);
    expect(done.service.milesToNext).toBe(7_000);
    expect(done.service.dueByDate).toBe("2026-01-10");
    // ~11 miles a day: 7,000 miles takes longer than the nine months left, so time comes first.
    expect(done.service.dueBy).toBe("TIME");
    expect(done.service.nextDueDate).toBe("2026-01-10");
    expect(done.service.odometerAtDue).toBeGreaterThan(21_000);
    expect(done.service.odometerAtDue).toBeLessThan(28_000);
  });

  it("counts an early service from where it was really done", () => {
    // The 56k service done at 53,750: the next is due by 61,750, not at the 64k column.
    const early = report(
      garage(
        { entries: [entry({ date: "2025-06-01", kind: "OTHER", cents: 0, odometer: 53_750 }), entry({ date: "2025-09-01", kind: "OTHER", cents: 0, odometer: 54_300 })] },
        { vehicle: { ...acme.vehicle, purchaseOdometer: 50_000 }, serviceVisits: [{ id: "s", date: "2025-06-01", odometer: null, milestoneMiles: 56_000, note: "" }] },
      ),
      [],
      "2025-09-01",
    );
    expect(early.service.next?.miles).toBe(64_000);
    expect(early.service.dueMiles).toBe(61_750);
    expect(early.service.lastVisit).toMatchObject({ miles: 53_750, milestone: 56_000 });
  });

  it("adds months without running past the end of a short month", () => {
    expect(addMonths("2025-01-31", 1)).toBe("2025-02-28");
    expect(addMonths("2025-11-15", 3)).toBe("2026-02-15");
  });
});
