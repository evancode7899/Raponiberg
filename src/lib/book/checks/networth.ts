import { addDays } from "../../dates/isoDate.ts";
import { buildNetWorthReport } from "../../ledger/netWorthReport.ts";
import { transferDifferenceAdjustments } from "../../ledger/transferFees.ts";
import { bookedShare } from "../booking.ts";
import { money } from "../coverage.ts";
import type { Book } from "../load.ts";
import type { Collector } from "./collector.ts";

/**
 * The household's every month must balance: every dollar of change in net worth is
 * income, spending, outside money, retirement money, market change or a balance first
 * on file — nothing unexplained — and transfers between the household's own accounts
 * net to zero except those in flight across the month's edges. Runs last, only over
 * months the other checks leave unblocked, so a gap in one month doesn't keep the rest
 * of its year from being proven.
 *
 * "In flight" is measured the way the ledger books each leg (booking.ts): an exact leg on
 * its date clamped into its statement, a quarterly statement's period total spread across
 * the quarter. Measured any other way, a 401(k)'s undated quarterly transfer would look
 * unexplained in every month but the one holding its other leg.
 */
export function checkNetWorth(book: Book, c: Collector) {
  if (!book.ledger.firstDay) return;
  const nw = buildNetWorthReport(book.ledger, { granularity: "month", today: book.today, through: book.horizon.netWorth });
  const fees = transferDifferenceAdjustments(
    book.matches
      .filter((m) => m.status === "CONFIRMED")
      .map((m) => ({ differenceCents: m.differenceCents, legs: m.legs.map((l) => ({ id: l.transactionId, amountCents: l.amountCents })) })),
  );
  const outside = new Set(c.inferences.filter((i) => i.check === "transfer.unmatched" && i.partial).flatMap((i) => i.rowIds ?? []));
  const share = (rowId: string, date: string, from: string, to: string) => {
    const r = book.rowById.get(rowId);
    return r ? bookedShare(r, from, to) : date >= from && date <= to ? 1 : 0;
  };
  for (const p of nw.periods) {
    const opening = addDays(p.start, -1);
    // Months run only through the data edge, so findings past it don't bear on them.
    const blocked = c.findings.some((f) =>
      !f.atEdge &&
      [f.scope, ...(f.extraScopes ?? [])].some((s) => s.affects.includes("NET_WORTH") && s.from <= p.end && s.to >= opening),
    );
    if (blocked) continue;
    const end = p.end > book.horizon.netWorth ? book.horizon.netWorth : p.end;
    let inFlight = 0;
    // Spread legs leave fractions of a cent; the ledger rounds each account's total once.
    let fractional = 0;
    for (const m of book.matches) {
      const shares = m.legs.map((l) => share(l.transactionId, l.date, p.start, end));
      if (shares.every((s) => s === 0) || shares.every((s) => s === 1)) continue;
      // The ledger books a confirmed lossy transfer's shortfall as a fee on the sending leg, not a transfer.
      m.legs.forEach((l, i) => (inFlight += shares[i]! * (l.amountCents - (fees.get(l.transactionId) ?? 0))));
      fractional += shares.filter((s) => s > 0 && s < 1).length;
    }
    // Card payments from an account with no statements available are outside money.
    let fromUnavailable = 0;
    for (const id of outside) {
      const r = book.rowById.get(id);
      if (r) fromUnavailable += r.amountCents * bookedShare(r, p.start, end);
    }
    const expected = inFlight + fromUnavailable;
    const h = p.household;
    const problems: string[] = [];
    if (h.unexplainedCents !== 0) problems.push(`${money(h.unexplainedCents)} of change no statement explains`);
    if (Math.abs(h.transferResidualCents - expected) > Math.ceil(fractional / 2))
      problems.push(
        `transfers between your accounts net to ${money(h.transferResidualCents)}, but only ${money(Math.round(expected))} was in flight at the month's edges or came from accounts with no statements`,
      );
    if (problems.length === 0) {
      c.pass("networth.reconciles");
      continue;
    }
    c.add({
      id: `networth.reconciles:${p.start.slice(0, 7)}`,
      check: "networth.reconciles",
      status: "FAIL",
      title: `${p.label}: net worth doesn't reconcile`,
      detail: problems.join("; ") + ".",
      fix: "A row is in the wrong lane (e.g. an own-account transfer filed as spending), or a lossy transfer needs confirming on Review → Transfers.",
      scope: { from: p.start, to: end, affects: ["NET_WORTH", "CASH_FLOW"] },
    });
  }
}
