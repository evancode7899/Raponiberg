import { describe, expect, it } from "vitest";
import type { BookRow } from "../load";
import { findAnomalies, type AnomalyInputs } from "./anomalies";
import type { RecurringCharge } from "./spending";

// Invented rows at invented merchants: every amount and date is made up.
let n = 0;
const row = (date: string, cents: number, merchant: string, over: Partial<BookRow> = {}): BookRow =>
  ({ id: `r${++n}`, date, bookedOn: date, amountCents: cents, lane: "EXPENSE", accountId: "card-1", payee: merchant, merchantKey: merchant, category: "Shopping", classifiedBy: "rule", precision: "EXACT", ...over }) as BookRow;
const months = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => {
    const m = from + i;
    const y = 2025 + Math.floor((m - 1) / 12);
    const mo = ((m - 1) % 12) + 1;
    const start = `${y}-${String(mo).padStart(2, "0")}-01`;
    const end = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
    return { start, end, label: start.slice(0, 7) };
  });
const bill = (key: string, over: Partial<RecurringCharge>): RecurringCharge => ({ key, name: key, category: "Bills", kind: "bill", cadence: "monthly", count: 6, monthsSeen: 6, typicalCents: 50_00, last12Cents: 0, annualCents: 0, firstDate: "", lastDate: "", lastCents: 0, active: true, changeCents: null, ...over });
const run = (over: Partial<AnomalyInputs>) => findAnomalies({ rows: [], dayOf: (r) => r.date, months: months(1, 8), recurring: [], explainedRow: () => false, ...over });
const kinds = (r: ReturnType<typeof run>) => r.items.map((i) => [i.kind, i.merchant]);

describe("anomalies", () => {
  it("finds nothing with no months, or nothing unusual", () => {
    expect(findAnomalies({ rows: [], dayOf: (r) => r.date, months: [], recurring: [], explainedRow: () => false }).items).toEqual([]);
    expect(run({ rows: [row("2025-03-04", -40_00, "Corner Deli")] }).items).toEqual([]);
  });

  it("flags the same charge a day apart on the same card, not on two cards, small ones, or the same day", () => {
    const rows = [
      row("2025-05-10", -84_00, "Example Outfitters"),
      row("2025-05-11", -84_00, "Example Outfitters"),
      row("2025-05-10", -84_00, "Sample Books", { accountId: "card-1" }),
      row("2025-05-11", -84_00, "Sample Books", { accountId: "card-2" }),
      row("2025-05-10", -5_00, "Corner Deli"),
      row("2025-05-11", -5_00, "Corner Deli"),
      row("2025-05-12", -30_00, "Lunch Spot"),
      row("2025-05-12", -30_00, "Lunch Spot"),
    ];
    const r = run({ rows });
    expect(kinds(r)).toEqual([["duplicate", "Example Outfitters"]]);
    expect(r.items[0]!.cents).toBe(84_00);
    expect(r.counts.duplicate).toBe(1);
  });

  it("leaves a merchant alone where same-amount charges are a pattern, and what the owner explained", () => {
    const fares = ["2025-03-01", "2025-03-02", "2025-03-09", "2025-03-10", "2025-03-20", "2025-03-21"].map((d) => row(d, -12_50, "Metro Fares"));
    expect(run({ rows: fares }).items).toEqual([]);
    const pair = [row("2025-05-10", -84_00, "Example Outfitters"), row("2025-05-11", -84_00, "Example Outfitters", { classifiedBy: "USER" })];
    const r = run({ rows: pair, explainedRow: (x) => x.classifiedBy === "USER" });
    expect([r.items, r.explained]).toEqual([[], 1]);
  });

  it("names a merchant new in the latest month, once there's half a year before it", () => {
    const rows = [row("2025-01-05", -20_00, "Old Shop"), row("2025-08-03", -150_00, "Fresh Market"), row("2025-08-20", -10_00, "Tiny Kiosk")];
    expect(kinds(run({ rows }))).toEqual([["new-merchant", "Fresh Market"]]);
    expect(run({ rows, months: months(4, 8) }).items).toEqual([]);
  });

  it("calls a steady rise price creep, not a one-month spike", () => {
    const creep = ["2025-01-03", "2025-02-03", "2025-03-03", "2025-04-03", "2025-05-03", "2025-06-03", "2025-07-03", "2025-08-03"].map((d, i) => row(d, i < 6 ? -50_00 : -55_00, "Stream Co"));
    const r = run({ rows: creep, recurring: [bill("Stream Co", { lastDate: "2025-08-03" })] });
    expect(kinds(r)).toEqual([["price-creep", "Stream Co"]]);
    expect(r.items[0]!.cents).toBe(5_00);
    const spike = creep.map((x, i) => (i === 7 ? { ...x, amountCents: -50_00 } : x));
    expect(run({ rows: spike, recurring: [bill("Stream Co", { lastDate: "2025-08-03" })] }).items).toEqual([]);
  });

  it("misses a bill only once its due day and grace fall inside the proven months", () => {
    const rows = ["2025-03-02", "2025-04-02", "2025-05-02", "2025-06-02"].map((d) => row(d, -60_00, "Phone Co"));
    const recurring = [bill("Phone Co", { lastDate: "2025-06-02", typicalCents: 60_00 })];
    // Through July: July 2 and its grace have passed.
    const r = run({ rows, recurring, months: months(1, 7) });
    expect(kinds(r)).toEqual([["missing-bill", "Phone Co"]]);
    expect(r.items[0]).toMatchObject({ dueOn: "2025-07-02", cents: 60_00 });
    // Through June: not due yet. Two cycles gone by the end of August: Recurring lists it as stopped, not as a miss.
    expect(run({ rows, recurring, months: months(1, 6) }).items).toEqual([]);
    expect(run({ rows, recurring, months: months(1, 8) }).items).toEqual([]);
  });

  it("misses a credit that came most months and not in the latest", () => {
    const rows = ["2025-02-10", "2025-03-10", "2025-04-10", "2025-05-10", "2025-06-10"].map((d) => row(d, 15_00, "Card Credit"));
    expect(kinds(run({ rows }))).toEqual([["missing-credit", "Card Credit"]]);
    expect(run({ rows: [...rows, row("2025-08-10", 15_00, "Card Credit")] }).items).toEqual([]);
  });
});
