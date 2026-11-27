import { valueAt, type AccountTimeline } from "../../ledger/timeline.ts";
import { sayer, sentences, type Sayer } from "../said.ts";
import { accountRef } from "../findingKeys.ts";
import type { Book, BookHoldings } from "../load.ts";
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
/**
 * What's wrong with a list of positions against its account (empty: it ties), or null when
 * it can't be held to anything (no account, or a day outside its statements). The one tie
 * test: the holdings.ties check and Investments (reports/investments.ts) both use it, so
 * the page never builds on a list the check found misread. `timeline`: the account's, as
 * the statements print it.
 */
export function holdingsProblems(h: BookHoldings, timeline: AccountTimeline | undefined, say: Sayer = sayer("holdings", "title")): string[] | null {
  if (!timeline?.firstDay || h.asOf < timeline.firstDay || h.asOf > timeline.lastDay!) return null;
  const balance = valueAt(timeline, h.asOf);
  const problems: string[] = [];
  if (h.printedTotalCents != null && h.totalCents !== h.printedTotalCents) problems.push(`the statement prints ${say.usd(h.printedTotalCents, "the holdings total, as the statement prints it")} for its holdings`);
  // Against a balance read on that very day; a value between statements is spread, so a list that day must still match it to be used.
  if (h.totalCents !== balance.cents) problems.push(`the balance that day is ${say.usd(balance.cents, `the account's balance on ${h.asOf}`)}${balance.quality === "EXACT" ? "" : " (spread between statements)"}`);
  return problems;
}

export function checkHoldings(book: Book, c: Collector) {
  const accounts = new Map(book.ledger.accounts.map((a) => [a.id, a]));
  for (const h of book.holdings) {
    // A list of positions that belongs to no ledger account was read from a statement, yet
    // counts nowhere: said, not skipped.
    if (!h.accountId) {
      const w = sentences(`holdings.ties:unmatched:${h.institution}#${h.accountNumber}:${h.asOf}`);
      c.add({
        id: `holdings.ties:unmatched:${h.institution}#${h.accountNumber}:${h.asOf}`,
        check: "holdings.ties",
        status: "MISSING",
        title: `${h.institution} ••${String(h.accountNumber).slice(-4)}: positions at ${h.asOf} belong to no account in the ledger`,
        detail: `A statement lists ${h.positions.length} position${h.positions.length === 1 ? "" : "s"} (${w.detail.usd(h.totalCents, `the positions' total at ${h.asOf}`)}) for an account number no ledger account carries, so they count nowhere.`,
        fix: "Import that account's statements, or add the number to the account it belongs to (Settings → Accounts) so its positions join it.",
        scope: { from: h.asOf, to: h.asOf, affects: ["HOLDINGS"] },
        amounts: w.amounts,
      });
      continue;
    }
    const a = accounts.get(h.accountId);
    const w = sentences(`holdings.ties:${a ? accountRef(book, a.id).ref : h.accountId}:${h.asOf}`);
    const total = w.title.usd(h.totalCents, `the positions' total at ${h.asOf}`);
    const all = holdingsProblems(h, a?.timeline, w.title);
    if (!a || !all) continue;
    // The check fails only on a balance read on that very day; a spread one can't prove the list misread.
    const exact = valueAt(a.timeline, h.asOf).quality === "EXACT";
    const problems = all.filter((p) => exact || !p.includes("spread between statements"));
    const scope: FindingScope = { accountId: a.id, from: h.asOf, to: h.asOf, affects: ["HOLDINGS"] };
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
      title: `${subject} add up to ${total}, but ${problems.join(" and ")}`,
      detail: `The statement lists ${h.positions.length} position${h.positions.length === 1 ? "" : "s"}; a row was skipped or misread. Investments uses the latest positions that do add up and shows the rest as one line.`,
      fix: "Compare the statement's holdings section with the positions on Investments: a row the reader skipped or misread is a bug in the statement reader to fix.",
      scope,
      // The spread balance a dropped problem printed isn't in the title: its amount goes with it.
      amounts: w.amounts.filter((x) => problems.some((p) => p.includes(x.text)) || x.text === total),
    });
  }
}
