import { describe, expect, it } from "vitest";
import type { BookRow } from "./load.ts";
import { countsOn, rentPayments } from "./rent.ts";

let n = 0;
const row = (date: string, cents: number, key: string, extra: Partial<BookRow> = {}): BookRow => ({
  id: `r${++n}`,
  date,
  precision: "EXACT",
  statement: { start: date, end: date },
  bookedOn: date,
  amountCents: cents,
  lane: "EXPENSE",
  accountId: "checking",
  payee: key,
  merchantKey: key,
  category: "Housing & utilities",
  categoryGroup: "Essentials",
  counterpartyKind: null,
  counterpartyInstitution: null,
  counterpartyAccountHint: null,
  classifiedBy: null,
  transferMatchId: null,
  ...extra,
});
const covers = (rows: BookRow[]) => Object.fromEntries(rentPayments(rows).map((p) => [p.date, p.covers.slice(0, 7)]));

describe("rentPayments", () => {
  it("counts a payment in the first half of a month for that month, and one in the second half for the next", () => {
    // By posting date: Nov holds two rents, Dec none, Feb two, Mar none.
    const rows = ["2025-11-03", "2025-11-28", "2026-01-02", "2026-02-02", "2026-02-26", "2026-04-02"].map((d) => row(d, -400001, "LANDLORD"));
    expect(covers(rows)).toEqual({
      "2025-11-03": "2025-11",
      "2025-11-28": "2025-12",
      "2026-01-02": "2026-01",
      "2026-02-02": "2026-02",
      "2026-02-26": "2026-03",
      "2026-04-02": "2026-04",
    });
  });

  it("moves the payment nearer an empty month when the date rule gives one month two rents", () => {
    // Feb 3 and Feb 14 both fall in February by the date rule and March has none: the
    // later one (paid unusually early) pays for March.
    const rows = ["2026-01-05", "2026-02-03", "2026-02-14", "2026-04-03"].map((d) => row(d, -300000, "LANDLORD"));
    expect(covers(rows)).toEqual({ "2026-01-05": "2026-01", "2026-02-03": "2026-02", "2026-02-14": "2026-03", "2026-04-03": "2026-04" });
  });

  it("keeps a real double when no neighbouring month is empty", () => {
    const rows = ["2026-01-02", "2026-02-02", "2026-02-10", "2026-03-02", "2026-04-02"].map((d) => row(d, -300000, "LANDLORD"));
    expect(rentPayments(rows).filter((p) => p.covers === "2026-02-01")).toHaveLength(2);
  });

  it("files a small charge to the landlord with its month but never moves it, and leaves utilities out", () => {
    const rows = [
      ...["2025-07-30", "2025-08-26", "2025-09-26"].map((d) => row(d, -380000, "LANDLORD")),
      row("2025-09-08", -12345, "LANDLORD"),
      row("2025-09-25", -9876, "EVERSOURCE"),
    ];
    expect(rentPayments(rows).map((p) => [p.date, p.covers.slice(0, 7), p.full])).toEqual([
      ["2025-07-30", "2025-08", true],
      ["2025-08-26", "2025-09", true],
      ["2025-09-08", "2025-09", false],
      ["2025-09-26", "2025-10", true],
    ]);
  });

  it("judges rent against recent rent, so increases never turn early rent into small charges", () => {
    // Rent more than doubles over the years; every month is still a full rent.
    const early = ["2024-01-02", "2024-02-02", "2024-03-02", "2024-04-02"].map((d) => row(d, -200000, "LANDLORD"));
    const later = ["2024-05-02", "2024-06-02", "2024-07-02", "2024-08-02", "2024-09-02", "2024-10-02", "2024-11-02", "2024-12-02"].map((d) => row(d, -500000, "LANDLORD"));
    const fee = row("2024-10-08", -15000, "LANDLORD");
    const pays = rentPayments([...early, ...later, fee]);
    expect(pays.filter((p) => p.full)).toHaveLength(12);
    expect(pays.find((p) => p.date === "2024-10-08")).toMatchObject({ full: false, covers: "2024-10-01" });
  });

  it("counts a new landlord's first payments however they're made, inside the household's rent rhythm", () => {
    // Moving: the old landlord through March, a wire for April, cheques from May.
    const old = ["2025-01-02", "2025-02-03", "2025-03-03"].map((d) => row(d, -300000, "OLD LANDLORD"));
    const wire = row("2025-04-01", -320000, "ONLINE DOMESTIC WIRE");
    const cheques = ["2025-05-02", "2025-06-02", "2025-07-02"].map((d) => row(d, -320000, "CHECK"));
    expect(covers([...old, wire, ...cheques])["2025-04-01"]).toBe("2025-04");
  });

  it("lets a deposit-plus-rent lump pay for an otherwise empty month, but leaves a deposit beside a paid month out", () => {
    const rent = ["2025-03-03", "2025-04-02", "2025-06-02", "2025-07-02"].map((d) => row(d, -300000, "LANDLORD"));
    // Paid late April for May (deposit included): May has no other rent, so this is May's.
    const lump = row("2025-04-22", -650000, "WITHDRAWAL");
    expect(covers([...rent, lump])["2025-04-22"]).toBe("2025-05");
    // A deposit paid when the month already has its rent isn't rent.
    const deposit = row("2025-03-05", -600000, "WIRE");
    expect(rentPayments([...rent, row("2025-05-02", -300000, "LANDLORD"), deposit]).some((p) => p.rowId === deposit.id)).toBe(false);
  });

  it("ignores one-offs with no rent around them, and anything paid by card", () => {
    expect(rentPayments([row("2026-01-02", -300000, "ONE OFF"), row("2026-02-02", -300000, "ONE OFF")])).toEqual([]);
    const rent = ["2026-01-02", "2026-02-02", "2026-03-02"].map((d) => row(d, -300000, "LANDLORD"));
    const sofa = row("2026-02-10", -280000, "FURNITURE STORE", { accountId: "card" });
    const pays = rentPayments([...rent, sofa], [{ id: "card", type: "CREDIT_CARD", subtype: "CREDIT_CARD" }, { id: "checking", type: "CHECKING", subtype: "CHECKING" }]);
    expect(pays.map((p) => p.payee)).toEqual(Array(3).fill("LANDLORD"));
  });

  it("leaves a card charge cancelled by its own credit alone (Bilt's card side)", () => {
    const bank = ["2026-06-01", "2026-06-30", "2026-07-27", "2026-08-27"].map((d) => row(d, -450001, "BILT CARD HOUSING"));
    const card = [row("2026-06-30", -450001, "BPS BILT HOUSING", { accountId: "bilt" }), row("2026-06-30", 450001, "BILT RENT CHARGE", { accountId: "bilt" })];
    const card2 = [row("2026-07-25", -450001, "BPS BILT HOUSING", { accountId: "bilt" }), row("2026-07-25", 450001, "BILT RENT CHARGE", { accountId: "bilt" })];
    const card3 = [row("2026-05-29", -450001, "BPS BILT HOUSING", { accountId: "bilt" }), row("2026-05-30", 450001, "BILT RENT CHARGE", { accountId: "bilt" })];
    expect(rentPayments([...bank, ...card, ...card2, ...card3]).map((p) => p.payee)).toEqual(Array(4).fill("BILT CARD HOUSING"));
  });
});

describe("countsOn", () => {
  it("counts rent on the first of the month it covers and everything else where the ledger books it", () => {
    const rent = ["2026-01-02", "2026-02-02", "2026-03-02"].map((d) => row(d, -300000, "LANDLORD"));
    const coffee = row("2026-02-02", -500, "CAFE", { category: "Dining" });
    const on = countsOn([...rent, coffee]);
    expect(rent.map(on)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    expect(on(coffee)).toBe("2026-02-02");
  });
});
