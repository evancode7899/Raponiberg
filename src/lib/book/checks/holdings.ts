import { valueAt } from "../../ledger/timeline.ts";
import { money } from "../coverage.ts";
import { accountRef } from "../findingKeys.ts";
import type { Book } from "../load.ts";
import type { FindingScope } from "../types.ts";
import type { Collector } from "./collector.ts";

/**
 * Every list of positions a statement prints adds up to the account's balance that day,
 * and to the total the statement prints for its holdings, to the cent. Positions are read
 * from the statement separately from its balance (ingest/holdings), so a row the reader
 * skips or misreads shows here. Investments already passes such a list over (it uses an
 * older list that ties, and shows the change since as one line); this makes the misread
 * an open finding to fix rather than something only a page notices.
 */
export function checkHoldings(book: Book, c: Collector) {
  const accounts = new Map(book.ledger.accounts.map((a) => [a.id, a]));
  for (const h of book.holdings) {
    const a = h.accountId ? accounts.get(h.accountId) : undefined;
    if (!a?.timeline.firstDay || h.asOf < a.timeline.firstDay || h.asOf > a.timeline.lastDay!) continue;
    const balance = valueAt(a.timeline, h.asOf);
    const scope: FindingScope = { accountId: a.id, from: h.asOf, to: h.asOf, affects: ["HOLDINGS"] };
    const problems: string[] = [];
    if (h.printedTotalCents != null && h.totalCents !== h.printedTotalCents) problems.push(`the statement prints ${money(h.printedTotalCents)} for its holdings`);
    // Only against a balance read on that very day: a value between statements is spread, not printed.
    if (balance.quality === "EXACT" && h.totalCents !== balance.cents) problems.push(`the balance that day is ${money(balance.cents)}`);
    const subject = `${a.name}: positions at ${h.asOf}`;
    if (!problems.length) {
      c.pass("holdings.ties", { subject, ...scope });
      continue;
    }
    const { ref, accounts: ids } = accountRef(book, a.id);
    c.add({
      id: `holdings.ties:${ref}:${h.asOf}`,
      accounts: ids,
      check: "holdings.ties",
      status: "FAIL",
      title: `${subject} add up to ${money(h.totalCents)}, but ${problems.join(" and ")}`,
      detail: `The statement lists ${h.positions.length} position${h.positions.length === 1 ? "" : "s"}; a row was skipped or misread. Investments uses the latest positions that do add up and shows the rest as one line.`,
      fix: "Compare the statement's holdings section with the positions on Investments: a row the reader skipped or misread is a bug in the statement reader to fix.",
      scope,
    });
  }
}
