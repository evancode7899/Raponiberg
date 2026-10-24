import { addDays, dayNumber, endOfMonth, fromDayNumber } from "../dates/isoDate.ts";
import { refreshLedgerStatus, type Ledger, type LedgerAccount } from "../ledger/loadLedger.ts";
import { withIdleWindows, type AccountTimeline } from "../ledger/timeline.ts";
import { RELABEL } from "../transfers/relabel.ts";
import { money } from "./coverage.ts";
import type { BookRow, BookTransferMatch } from "./load.ts";

/**
 * Idle card cycles. Some issuers (Capital One, Chase) send no statement for a cycle with
 * no activity, so a run of missing statements can be a run of idle months rather than a
 * gap. By the owner's rule such a window counts as covered — for coverage and for every
 * figure — when it's proven from the bank side:
 *
 *  - the card is at $0 when the window ends (the next statement opens at $0, or none
 *    came after),
 *  - every bank account that has ever paid the card has statements covering the window,
 *  - and the payments to the issuer in the window that aren't paired with a statement on
 *    file add up to exactly the balance the last statement left owing: none when it
 *    closed at $0, the payoff when it didn't (Chase's autopay of the statement balance
 *    lands in the next cycle, which then has no statement). Anything else would show.
 *
 * The window's balance is the carried-in balance until the payoff, then $0; the payoff
 * is the card's side of those bank payments.
 *
 * After a card's last statement, cycles count as idle only once their payment would
 * have left the bank inside the bank's own statements (cycle end + the grace period).
 *
 * A card the owner marked closed (closedAccounts.ts) gets the same payoff after its last
 * statement, whatever the issuer: the bank payments the transfer matcher found settled
 * what the last statement left owing (runMatching.ts, "closed-card-payoff:") are the
 * card's payoff, and it ends at $0 on the payoff's day. It has no cycles after that.
 */

/** Issuers that send no statement for a cycle without activity, and how their card payments read on a bank statement. */
export const SKIPS_IDLE_STATEMENTS: { institution: string; payment: RegExp }[] = [
  { institution: "CAPITAL ONE", payment: /CAPITAL ONE/ },
  { institution: "CHASE", payment: /PAYMENT TO CHASE CARD|CHASE CREDIT CRD/ },
];

/** Days after a cycle closes by which its payment has left the bank (Capital One's due date is 25 days out). */
export const PAYMENT_GRACE_DAYS = 30;

export type IdleWindow = {
  accountId: string;
  from: string;
  to: string;
  payerIds: string[];
  trailing: boolean;
  /** Balance carried in from the last statement (≤ 0), paid off by `payoff`. */
  openingCents: number;
  /** The bank rows that paid it off. */
  payoff: { transactionId: string; date: string; amountCents: number }[];
};
/** A window before a $0 balance that couldn't be proven idle, and why. */
export type IdleRejection = { accountId: string; from: string; to: string; reason: string };
export type IdleReport = { proven: IdleWindow[]; unproven: IdleRejection[] };

const upper = (s: string | null) => (s ?? "").trim().toUpperCase();

const issuerOf = (a: LedgerAccount) =>
  a.group === "Credit cards" ? SKIPS_IDLE_STATEMENTS.find((i) => (a.institution ?? "").toUpperCase().includes(i.institution)) : undefined;

/** Last day of the unbroken run of coverage that includes `from`, or null if `from` isn't covered. */
function coveredThrough(t: AccountTimeline, from: string): string | null {
  let day = dayNumber(from);
  let reached: number | null = null;
  for (const s of [...t.segments].sort((x, y) => x.start - y.start)) {
    if (s.end < day) continue;
    if (s.start > day) break;
    reached = s.end;
    day = s.end + 1;
  }
  return reached == null ? null : fromDayNumber(reached);
}

/** Same day of the next month (clamped), i.e. the next cycle's closing day. */
function nextCycleEnd(iso: string): string {
  const day = Number(iso.slice(8, 10));
  const nextMonthEnd = endOfMonth(addDays(endOfMonth(iso), 1));
  return `${nextMonthEnd.slice(0, 8)}${String(Math.min(day, Number(nextMonthEnd.slice(8, 10)))).padStart(2, "0")}`;
}

/**
 * @param identifiers every identifier each account has had, so a bank payment naming
 *   another card of the same issuer ("ending in 1234") isn't counted against this one.
 */
export function proveIdleWindows(
  ledger: Ledger,
  rows: BookRow[],
  matches: BookTransferMatch[],
  identifiers: Map<string, string[]> = new Map(),
): IdleReport {
  const report: IdleReport = { proven: [], unproven: [] };
  const byId = new Map(ledger.accounts.map((a) => [a.id, a]));

  for (const card of ledger.accounts) {
    const issuer = issuerOf(card);
    const closedCard = card.group === "Credit cards" && card.closedByOwner != null;
    if (!issuer && !closedCard) continue;
    const institution = upper(card.institution);
    const paysCard = (r: BookRow) =>
      issuer
        ? issuer.payment.test(r.payee.toUpperCase())
        : !!r.classifiedBy?.startsWith(RELABEL.CLOSED_CARD_PAYOFF) && upper(r.counterpartyInstitution) === institution;
    const own = (identifiers.get(card.id) ?? []).map((i) => i.replace(/\D/g, "").slice(-4)).filter((i) => i.length === 4);
    // Bank-side payments to the issuer that no statement on file accounts for (to this
    // card, or to an unnamed card of the issuer's).
    const payments = rows
      .filter(
        (r) =>
          byId.get(r.accountId)?.group === "Cash" &&
          r.transferMatchId == null &&
          paysCard(r) &&
          (!r.counterpartyAccountHint || own.length === 0 || own.includes(r.counterpartyAccountHint.slice(-4))),
      )
      .sort((x, y) => x.date.localeCompare(y.date));
    const unpaired = (from: string, to: string) => payments.filter((r) => r.date >= from && r.date <= to);
    // Bank accounts that have paid this card (the other leg of its pairings, or a payment to it).
    const payerIds = [
      ...new Set([
        ...matches
          .filter((m) => m.legs.some((l) => l.accountId === card.id))
          .flatMap((m) => m.legs.map((l) => l.accountId))
          .filter((id) => id !== card.id && byId.get(id)?.group === "Cash"),
        ...payments.map((r) => r.accountId),
      ]),
    ];
    const payerName = (id: string) => byId.get(id)?.name ?? "the bank";
    const payoffOf = (rs: BookRow[]) => rs.map((r) => ({ transactionId: r.id, date: r.date, amountCents: r.amountCents }));
    const total = (rs: BookRow[]) => rs.reduce((t, r) => t + r.amountCents, 0);

    const segs = [...card.timeline.segments].sort((x, y) => x.start - y.start);
    // Gaps between statements: only issuers that skip idle statements leave them.
    for (let i = 1; issuer && i < segs.length; i++) {
      const prev = segs[i - 1]!;
      const cur = segs[i]!;
      // A credit balance (> 0) isn't paid off by the bank; it would carry into a statement.
      if (cur.start <= prev.end + 1 || prev.closing > 0 || cur.opening !== 0) continue;
      const from = fromDayNumber(prev.end + 1);
      const to = fromDayNumber(cur.start - 1);
      const reject = (reason: string) => report.unproven.push({ accountId: card.id, from, to, reason });
      if (payerIds.length === 0) {
        reject("No bank payment to this card is on file, so there's no bank account to check for activity.");
        continue;
      }
      const short = payerIds.find((p) => (coveredThrough(byId.get(p)!.timeline, from) ?? "") < to);
      if (short) {
        reject(`${payerName(short)} statements don't cover the whole window, so a payment to the card can't be ruled out.`);
        continue;
      }
      const inWindow = unpaired(from, to);
      if (prev.closing === 0 && inWindow.length > 0) {
        reject(`${payerName(inWindow[0]!.accountId)} paid ${card.institution} ${money(inWindow[0]!.amountCents)} on ${inWindow[0]!.date} with no statement on file to pair it with.`);
        continue;
      }
      if (total(inWindow) !== prev.closing) {
        reject(
          `The last statement left ${money(-prev.closing)} owing, but the bank paid ${card.institution} ${money(-total(inWindow))} in the window` +
            (inWindow.length ? ` (${inWindow.map((r) => `${r.date} ${money(r.amountCents)}`).join(", ")}).` : "."),
        );
        continue;
      }
      report.proven.push({ accountId: card.id, from, to, payerIds, trailing: false, openingCents: prev.closing, payoff: payoffOf(inWindow) });
    }

    // After the last statement: whole cycles whose payment window the banks already cover.
    const last = segs.at(-1);
    if (!last || last.closing > 0 || payerIds.length === 0) continue;
    const from = fromDayNumber(last.end + 1);
    const ends = payerIds.map((p) => coveredThrough(byId.get(p)!.timeline, from));
    if (ends.some((e) => e == null)) continue;
    let limit = ends.sort()[0]!;
    const after = unpaired(from, limit);
    // The payoff of whatever the last statement left owing: the first payments that add up to it.
    let paid = 0;
    let n = 0;
    while (paid !== last.closing && n < after.length) paid += after[n++]!.amountCents;
    if (paid !== last.closing) continue;
    const payoff = after.slice(0, n);
    if (!issuer) {
      // A closed card is settled on the payoff's day (nothing to settle when it ended at $0).
      if (payoff.length) report.proven.push({ accountId: card.id, from, to: payoff.at(-1)!.date, payerIds, trailing: true, openingCents: last.closing, payoff: payoffOf(payoff) });
      continue;
    }
    const stray = after[n];
    if (stray) limit = addDays(stray.date, -1);
    let to: string | null = null;
    for (let end = nextCycleEnd(fromDayNumber(last.end)); addDays(end, PAYMENT_GRACE_DAYS) <= limit; end = nextCycleEnd(end)) to = end;
    if (to && (payoff.at(-1)?.date ?? from) <= to) {
      report.proven.push({ accountId: card.id, from, to, payerIds, trailing: true, openingCents: last.closing, payoff: payoffOf(payoff) });
    }
  }
  return report;
}

/** Fills every proven idle window into the ledger's timelines (in place). */
export function applyIdleWindows(
  ledger: Ledger,
  rows: BookRow[],
  matches: BookTransferMatch[],
  today: string,
  identifiers?: Map<string, string[]>,
): IdleReport {
  const report = proveIdleWindows(ledger, rows, matches, identifiers);
  for (const a of ledger.accounts) {
    const windows = report.proven.filter((w) => w.accountId === a.id);
    if (windows.length) a.timeline = withIdleWindows(a.timeline, windows);
  }
  refreshLedgerStatus(ledger, today);
  return report;
}
