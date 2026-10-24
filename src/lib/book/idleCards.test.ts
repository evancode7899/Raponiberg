import { describe, expect, it } from "vitest";
import { groupFor, type Ledger } from "../ledger/loadLedger";
import { buildTimeline, valueAt, type SegmentInput } from "../ledger/timeline";
import { applyIdleWindows, proveIdleWindows } from "./idleCards";
import type { BookRow, BookTransferMatch } from "./load";

// Synthetic accounts and amounts only.

type Acct = { id: string; subtype: string; institution: string; segs: [string, string, number, number][] };

function ledgerOf(accts: Acct[]): Ledger {
  return {
    accounts: accts.map((a) => {
      const segs: SegmentInput[] = a.segs.map(([s, e, o, c]) => ({ accountId: a.id, periodStart: s, periodEnd: e, openingCents: o, closingCents: c, growthCents: 0, feesCents: 0, flows: [] }));
      return { id: a.id, name: a.id, institution: a.institution, type: "X", subtype: a.subtype as never, group: groupFor(a.subtype, "X"), isInvestment: false, timeline: buildTimeline(a.id, segs), statementCount: segs.length, closed: false };
    }),
    mergeDate: "2024-12-01",
    completeThrough: null,
    firstDay: null,
  };
}

const row = (id: string, accountId: string, date: string, cents: number, matchId: string | null = null): BookRow => ({
  id, date, precision: "EXACT", statement: { start: date, end: date }, bookedOn: date, amountCents: cents, lane: "TRANSFER", accountId, payee: "CAPITAL ONE CRCARDPMT", merchantKey: null, category: "Transfers", categoryGroup: null,
  counterpartyKind: "OWN_ACCOUNT", counterpartyInstitution: "Capital One", counterpartyAccountHint: null, classifiedBy: null, transferMatchId: matchId, statementImportId: "st", documentId: "doc",
});
const match = (id: string, bankRow: BookRow, cardId: string): BookTransferMatch => ({
  id, status: "CONFIRMED", differenceCents: 0,
  legs: [
    { transactionId: bankRow.id, accountId: bankRow.accountId, date: bankRow.date, amountCents: bankRow.amountCents },
    { transactionId: `${bankRow.id}-c`, accountId: cardId, date: bankRow.date, amountCents: -bankRow.amountCents },
  ],
});

const bank: Acct = { id: "bank", subtype: "CHECKING", institution: "Bank", segs: [["2024-01-01", "2024-12-31", 100_00, 100_00]] };
// Card idle between Mar 20 and Jun 19, paid once (from the bank) before that.
const card: Acct = { id: "card", subtype: "CREDIT_CARD", institution: "Capital One", segs: [["2024-01-20", "2024-02-19", 0, -50_00], ["2024-02-20", "2024-03-19", -50_00, 0], ["2024-06-20", "2024-07-19", 0, 0]] };
const paid = row("p1", "bank", "2024-03-10", -50_00, "m1");

describe("idle card cycles", () => {
  it("covers a $0 gap when the paying bank is on file and shows no payment", () => {
    const ledger = ledgerOf([bank, card]);
    const report = applyIdleWindows(ledger, [paid], [match("m1", paid, "card")], "2024-12-31");
    expect(report.proven.find((w) => !w.trailing)).toMatchObject({ accountId: "card", from: "2024-03-20", to: "2024-06-19", payerIds: ["bank"] });
    const t = ledger.accounts.find((a) => a.id === "card")!.timeline;
    expect(valueAt(t, "2024-05-01")).toMatchObject({ cents: 0, quality: "EXACT" });
  });

  it("doesn't when the bank paid the issuer in the window with nothing to pair it with", () => {
    const stray = row("p2", "bank", "2024-04-15", -12_34);
    const report = proveIdleWindows(ledgerOf([bank, card]), [paid, stray], [match("m1", paid, "card")]);
    expect(report.proven.some((w) => !w.trailing)).toBe(false);
    expect(report.unproven[0]!.reason).toContain("2024-04-15");
  });

  it("ignores a payment paired with the issuer's other card", () => {
    const other: Acct = { id: "other", subtype: "CREDIT_CARD", institution: "Capital One", segs: [["2024-04-01", "2024-04-30", -12_34, 0]] };
    const toOther = row("p3", "bank", "2024-04-15", -12_34, "m2");
    const report = proveIdleWindows(ledgerOf([bank, card, other]), [paid, toOther], [match("m1", paid, "card"), match("m2", toOther, "other")]);
    expect(report.proven.some((w) => w.accountId === "card" && w.from === "2024-03-20")).toBe(true);
  });

  it("doesn't when the paying bank's statements don't cover the window", () => {
    const short: Acct = { ...bank, segs: [["2024-01-01", "2024-04-30", 100_00, 100_00], ["2024-06-01", "2024-12-31", 100_00, 100_00]] };
    const report = proveIdleWindows(ledgerOf([short, card]), [paid], [match("m1", paid, "card")]);
    expect(report.proven.some((w) => !w.trailing)).toBe(false);
    expect(report.unproven[0]!.reason).toContain("don't cover");
  });

  it("doesn't when no bank payment to the card is on file", () => {
    const report = proveIdleWindows(ledgerOf([bank, card]), [], []);
    expect(report.proven).toEqual([]);
    expect(report.unproven).toHaveLength(1);
  });

  it("leaves gaps with a balance on either side as plain missing statements", () => {
    const owing: Acct = { ...card, segs: [["2024-01-20", "2024-02-19", 0, -50_00], ["2024-06-20", "2024-07-19", -50_00, 0]] };
    const report = proveIdleWindows(ledgerOf([bank, owing]), [paid], [match("m1", paid, "owing")]);
    expect(report.proven.filter((w) => !w.trailing)).toEqual([]);
    expect(report.unproven).toEqual([]);
  });

  it("only applies to issuers that skip idle statements", () => {
    const amex: Acct = { ...card, institution: "American Express" };
    expect(proveIdleWindows(ledgerOf([bank, amex]), [paid], [match("m1", paid, "card")]).proven).toEqual([]);
  });

  it("after the last statement, covers only cycles whose payment window the bank covers", () => {
    // Bank through Dec 31: cycles ending Aug 19 … Nov 19 are proven (Nov 19 + 30 = Dec 19).
    const report = proveIdleWindows(ledgerOf([bank, card]), [paid], [match("m1", paid, "card")]);
    expect(report.proven.find((w) => w.trailing)).toMatchObject({ from: "2024-07-20", to: "2024-11-19" });
  });

  it("after the last statement, stops before an unpaired payment", () => {
    const stray = row("p4", "bank", "2024-10-01", -9_99);
    const report = proveIdleWindows(ledgerOf([bank, card]), [paid, stray], [match("m1", paid, "card")]);
    expect(report.proven.find((w) => w.trailing)).toMatchObject({ from: "2024-07-20", to: "2024-08-19" });
  });
});

describe("idle card cycles after a payoff (Chase)", () => {
  const chase: Acct = { id: "chase", subtype: "CREDIT_CARD", institution: "Chase", segs: [["2024-01-11", "2024-02-10", 0, -110_00], ["2024-06-11", "2024-07-10", 0, -20_00]] };
  const ids = new Map([["chase", ["1234"]]]);
  const pay = (id: string, date: string, cents: number, hint: string | null = "1234"): BookRow => ({
    ...row(id, "bank", date, cents), payee: `Payment To Chase Card Ending IN ${hint ?? ""}`, counterpartyInstitution: "Chase", counterpartyAccountHint: hint,
  });

  it("covers the cycles after a statement when the bank paid exactly its balance and the next one opens at $0", () => {
    const ledger = ledgerOf([bank, chase]);
    const payoff = pay("c1", "2024-03-08", -110_00);
    const report = applyIdleWindows(ledger, [payoff], [], "2024-12-31", ids);
    expect(report.proven.find((w) => !w.trailing)).toMatchObject({ from: "2024-02-11", to: "2024-06-10", openingCents: -110_00, payoff: [{ transactionId: "c1" }] });
    const t = ledger.accounts.find((a) => a.id === "chase")!.timeline;
    expect(valueAt(t, "2024-03-01")).toMatchObject({ cents: -110_00, quality: "EXACT" });
    expect(valueAt(t, "2024-04-01")).toMatchObject({ cents: 0, quality: "EXACT" });
  });

  it("doesn't when the bank paid a different amount", () => {
    const report = proveIdleWindows(ledgerOf([bank, chase]), [pay("c1", "2024-03-08", -100_00)], [], ids);
    expect(report.proven.some((w) => !w.trailing)).toBe(false);
    expect(report.unproven[0]!.reason).toContain("owing");
  });

  it("ignores a payment naming another card of the issuer", () => {
    const report = proveIdleWindows(ledgerOf([bank, chase]), [pay("c1", "2024-03-08", -110_00), pay("c2", "2024-04-08", -5_00, "9999")], [], ids);
    expect(report.proven.find((w) => !w.trailing)).toMatchObject({ from: "2024-02-11", payoff: [{ transactionId: "c1" }] });
  });

  it("after the last statement, covers the payoff and the idle cycles after it", () => {
    const ledger = ledgerOf([bank, chase]);
    const report = applyIdleWindows(ledger, [pay("c1", "2024-03-08", -110_00), pay("c3", "2024-08-07", -20_00)], [], "2024-12-31", ids);
    // Bank through Dec 31: cycles ending Aug 10 … Nov 10 (Nov 10 + 30 = Dec 10).
    expect(report.proven.find((w) => w.trailing)).toMatchObject({ from: "2024-07-11", to: "2024-11-10", openingCents: -20_00 });
    const t = ledger.accounts.find((a) => a.id === "chase")!.timeline;
    expect(valueAt(t, "2024-08-01")).toMatchObject({ cents: -20_00 });
    expect(valueAt(t, "2024-09-30")).toMatchObject({ cents: 0, quality: "EXACT" });
  });

  it("after the last statement, nothing is covered until the balance is paid off", () => {
    const report = proveIdleWindows(ledgerOf([bank, chase]), [pay("c1", "2024-03-08", -110_00)], [], ids);
    expect(report.proven.some((w) => w.trailing)).toBe(false);
  });
});

describe("owner-closed cards", () => {
  // Closing statement left $48.00 owing; the bank paid it off three days later.
  const closed: Acct = { id: "closed", subtype: "CREDIT_CARD", institution: "Example Card Co", segs: [["2024-05-12", "2024-06-10", 0, -30_00], ["2024-06-11", "2024-07-11", -30_00, -48_00]] };
  const payoff = (id: string, date: string, cents: number, classifiedBy: string | null = "closed-card-payoff:bank-card-payment"): BookRow => ({
    ...row(id, "bank", date, cents), payee: "EXAMPLE CARD CO PAYMENT", counterpartyInstitution: "Example Card Co", classifiedBy,
  });
  const ledgerClosed = () => {
    const ledger = ledgerOf([bank, closed]);
    ledger.accounts.find((a) => a.id === "closed")!.closedByOwner = "closed by phone";
    return ledger;
  };

  it("the matcher's payoff settles the card, which ends at $0 on the payoff's day", () => {
    const ledger = ledgerClosed();
    const report = applyIdleWindows(ledger, [payoff("x1", "2024-07-14", -48_00)], [], "2024-12-31");
    expect(report.proven).toEqual([
      expect.objectContaining({ accountId: "closed", from: "2024-07-12", to: "2024-07-14", trailing: true, openingCents: -48_00, payoff: [expect.objectContaining({ transactionId: "x1" })] }),
    ]);
    const card = ledger.accounts.find((a) => a.id === "closed")!;
    expect(valueAt(card.timeline, "2024-07-13")).toMatchObject({ cents: -48_00 });
    expect(valueAt(card.timeline, "2024-07-14")).toMatchObject({ cents: 0, quality: "EXACT" });
    expect(card.timeline.lastDay).toBe("2024-07-14");
    expect(card.closed).toBe(true);
  });

  it("only counts payments the matcher marked as the payoff", () => {
    const report = proveIdleWindows(ledgerClosed(), [payoff("x1", "2024-07-14", -48_00, "closed-card:bank-card-payment")], []);
    expect(report.proven).toEqual([]);
  });

  it("isn't settled by the bank's statements alone when they don't reach the payoff", () => {
    const short: Acct = { ...bank, segs: [["2024-01-01", "2024-07-12", 100_00, 100_00]] };
    const ledger = ledgerOf([short, closed]);
    ledger.accounts.find((a) => a.id === "closed")!.closedByOwner = "closed by phone";
    expect(proveIdleWindows(ledger, [payoff("x1", "2024-07-14", -48_00)], []).proven).toEqual([]);
  });

  it("an open card of an issuer that sends every statement gets no payoff window", () => {
    expect(proveIdleWindows(ledgerOf([bank, closed]), [payoff("x1", "2024-07-14", -48_00)], []).proven).toEqual([]);
  });
});
