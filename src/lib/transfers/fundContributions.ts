import { addDays } from "../dates/isoDate.ts";
import { mergeCalls } from "../funds/report.ts";
import type { FundCall } from "../funds/types.ts";
import type { Leg } from "./matchTransfers.ts";

/**
 * A private fund's capital statement prints one "Contributions" total for the quarter, and
 * the ledger files it as money arriving from checking. After an equalisation that isn't
 * the whole story: the fund hands part of earlier contributions back with interest, and
 * its notice nets both against the new call. The statement still counts the whole net
 * contribution, the bank wired only what the notice asked for, and the interest paid the
 * rest without ever leaving the fund.
 *
 * So a quarter's contribution pairs with its wires by the notices, not by amount, and only
 * when the notices prove every dollar:
 *
 *   - the quarter's notices (issued inside the statement's period, for the investor number
 *     the account carries) credit interest;
 *   - what they call, less what they hand back, is the statement's contribution exactly;
 *   - each notice that asked for money has exactly one bank wire to the manager for that
 *     amount, between its issue date and three weeks after it was due;
 *   - and the contribution less those wires is the notices' interest exactly.
 *
 * The pairing then carries the interest as its difference, which the ledger keeps on the
 * fund's side as growth (ledger/transferFees.ts). A quarter whose notices asked for
 * nothing pairs with no wire at all: its whole contribution was interest. Anything the
 * notices don't explain to the cent is left unpaired, for the owner.
 */
export type FundContributionMatch = { legIds: string[]; differenceCents: number };

/** As the fund view looks for a notice's wire (funds/report.ts). */
const WIRE_DAYS_AFTER_DUE = 21;

export function planFundContributions(legs: Leg[], calls: FundCall[]): FundContributionMatch[] {
  const byInvestor = new Map<string, FundCall[]>();
  for (const c of calls) if (c.investorId) byInvestor.set(c.investorId, [...(byInvestor.get(c.investorId) ?? []), c]);
  // The manager's letter and its ILPA template are two copies of one notice.
  const notices = new Map([...byInvestor].map(([id, cs]) => [id, mergeCalls(cs.map((doc) => ({ source: { documentId: "", title: "" }, doc }))).map((m) => m.call)]));

  const used = new Set<string>();
  const out: FundContributionMatch[] = [];
  const contributions = legs
    .filter((l) => l.role === "TRANSFER" && l.datePrecision === "PERIOD" && l.amountCents > 0)
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.id.localeCompare(b.id));
  for (const l of contributions) {
    const inPeriod = l.identifiers.flatMap((i) => notices.get(i) ?? []).filter((c) => c.issued >= l.periodStart && c.issued <= l.periodEnd);
    const interest = inPeriod.reduce((s, c) => s + c.interestCents, 0);
    // No interest: a plain call, which the bank's wire matches to the cent on its own.
    if (interest <= 0) continue;
    if (inPeriod.reduce((s, c) => s + c.contributionCents - c.returnedCents, 0) !== l.amountCents) continue;
    const wires: Leg[] = [];
    let forced = true;
    for (const c of [...inPeriod].sort((a, b) => a.issued.localeCompare(b.issued))) {
      if (c.netDueCents <= 0) continue;
      const until = addDays(c.due ?? c.issued, WIRE_DAYS_AFTER_DUE);
      const found = legs.filter(
        (w) =>
          !used.has(w.id) &&
          !wires.includes(w) &&
          w.role === "TRANSFER" &&
          w.datePrecision === "EXACT" &&
          (w.subtype === "CHECKING" || w.subtype === "SAVINGS") &&
          w.amountCents === -c.netDueCents &&
          w.counterpartyInstitution === l.institution &&
          w.date >= c.issued &&
          w.date <= until,
      );
      if (found.length !== 1) {
        forced = false;
        break;
      }
      wires.push(found[0]!);
    }
    if (!forced || l.amountCents + wires.reduce((s, w) => s + w.amountCents, 0) !== interest) continue;
    for (const w of wires) used.add(w.id);
    out.push({ legIds: [l.id, ...wires.map((w) => w.id)], differenceCents: interest });
  }
  return out;
}
