import { addDays } from "../../dates/isoDate.ts";
import { accountsByLast4, money, uncovered } from "../coverage.ts";
import { accountRef, rowRefs } from "../findingKeys.ts";
import type { Book, BookAccount, BookRow } from "../load.ts";
import type { Collector } from "./collector.ts";

/**
 * Every transfer between the household's own accounts must pair with its other leg.
 * When an account that could hold the other leg has no statement for those days, the
 * leg is missing data; when every candidate's statement covers them and still nothing
 * pairs, the rows contradict each other (or the row isn't an own-account transfer).
 * Either way the money's destination is unknown, so the period's cash flow and the net
 * worth breakdown can't be proven.
 */
export function checkTransfers(book: Book, c: Collector) {
  const nameOf = (id: string) => book.accounts.find((a) => a.id === id)?.name ?? "Account";
  // Accounts the household is known to have (named on pay stubs) with no statements on file.
  const untracked = [...new Set(book.stubs.flatMap((s) => s.deposits.map((d) => d.last4)).filter((l): l is string => !!l && accountsByLast4(book, l).length === 0))];
  const refs = rowRefs(book, (r) => r.lane === "TRANSFER" && !r.transferMatchId);
  // Bank payments that paid off a card in a cycle it sent no statement for: the idle
  // window holds their other leg (see idleCards.ts).
  const paidIdle = new Set(book.idle.proven.flatMap((w) => w.payoff.map((p) => p.transactionId)));
  for (const r of book.rows) {
    if (r.lane !== "TRANSFER") continue;
    if (r.transferMatchId || paidIdle.has(r.id)) {
      c.pass("transfer.unmatched");
      continue;
    }
    const candidates = otherLegCandidates(book, r);
    const from = addDays(r.date, -3);
    const to = addDays(r.date, 3);
    const notCovered = candidates.filter((a) => uncovered(book, a.id, from, to).length > 0);
    const direction = r.amountCents < 0 ? "to" : "from";
    const scope = { accountId: r.accountId, from, to, affects: ["CASH_FLOW" as const, "NET_WORTH" as const] };
    const isCard = book.accounts.find((a) => a.id === r.accountId)?.group === "Credit cards";
    if (notCovered.length === 0 && isCard && r.amountCents > 0 && !r.counterpartyInstitution && untracked.length > 0) {
      // A card payment no tracked bank account made: paid from an account not on file.
      const unavailable = new Map((book.taxProfile.unavailableAccounts ?? []).map((a) => [a.last4, a.note]));
      if (untracked.every((l) => unavailable.has(l))) {
        // ...one whose statements can't be obtained: money from outside the tracked books, partial.
        c.infer({
          id: `transfer.unmatched:${refs.get(r.id)}`,
          check: "transfer.unmatched",
          rowIds: [r.id],
          partial: true,
          title: `${r.date} ${money(r.amountCents)} payment to ${nameOf(r.accountId)} came from ${untracked.map((l) => `••${l}`).join(" / ")} (no statements available)`,
          detail: `${untracked.map((l) => `••${l}: ${unavailable.get(l) || "statements unavailable"}`).join("; ")}. Counted as money from outside the tracked accounts.`,
          scope: { from, to },
        });
        continue;
      }
      c.add({
        id: `transfer.unmatched:${refs.get(r.id)}`,
        accounts: accountRef(book, r.accountId).accounts,
        check: "transfer.unmatched",
        status: "MISSING",
        title: `${r.date} ${money(r.amountCents)} payment to ${nameOf(r.accountId)} came from an account not on file`,
        detail: `"${r.payee}" isn't on any tracked bank statement. Accounts known from pay stubs but not on file: ${untracked.map((l) => `••${l}`).join(", ")}.`,
        fix: `Add statements for ${untracked.map((l) => `••${l}`).join(" / ")} (or whichever account paid the card).`,
        scope,
        date: r.date,
      });
      continue;
    }
    if (notCovered.length > 0) {
      c.add({
        id: `transfer.unmatched:${refs.get(r.id)}`,
        accounts: accountRef(book, r.accountId).accounts,
        check: "transfer.unmatched",
        status: "MISSING",
        title: `${r.date} ${money(r.amountCents)} ${direction} ${notCovered.map((a) => a.name).join(" / ")} isn't on that account's statements`,
        detail: `${nameOf(r.accountId)} shows "${r.payee}", but no statement for ${notCovered.map((a) => a.name).join(" or ")} covers ${from} – ${to}, so where the money went (or came from) can't be seen.`,
        fix: `Download the ${notCovered[0]!.institution ?? ""} statement covering ${r.date} into the statements folder and scan it.`,
        scope,
        date: r.date,
        needs: { accountIds: notCovered.map((a) => a.id), from: r.date, to: r.date },
      });
    } else {
      c.add({
        id: `transfer.unmatched:${refs.get(r.id)}`,
        accounts: accountRef(book, r.accountId).accounts,
        check: "transfer.unmatched",
        status: "FAIL",
        title: `${r.date} ${money(r.amountCents)} transfer in ${nameOf(r.accountId)} has no other leg`,
        detail:
          candidates.length === 0
            ? `"${r.payee}" is filed as a transfer between your own accounts, but no tracked account it could be from or to exists.`
            : `"${r.payee}" should appear on ${candidates.map((a) => a.name).join(" or ")}, whose statements cover ${r.date}, but no matching row was found.`,
        fix:
          candidates.length === 0
            ? "On Review, reclassify it (a payment to an untracked card is spending; money to or from someone else is external), or add that account's statements."
            : "Pair it by hand on Review → Transfers, or reclassify it if it isn't a transfer between your own accounts (e.g. a payment to a card that isn't tracked is spending).",
        scope,
        date: r.date,
      });
    }
  }
}

/** Accounts that could hold a transfer row's other leg. */
function otherLegCandidates(book: Book, r: BookRow): BookAccount[] {
  const others = book.accounts.filter((a) => a.id !== r.accountId);
  const digits = (s: string) => s.replace(/\D/g, "");
  // The description or classifier names the other account's number.
  const hint = r.counterpartyAccountHint ? digits(r.counterpartyAccountHint) : "";
  const named = others.filter((a) =>
    a.identifiers.some((i) => {
      const last4 = digits(i).slice(-4);
      return last4.length === 4 && ((hint && hint.endsWith(last4)) || new RegExp(`\\d*${last4}\\b`).test(r.payee));
    }),
  );
  if (named.length > 0) return named;
  const inst = (r.counterpartyInstitution ?? "").toUpperCase().split(" ")[0];
  if (inst) {
    const byInstitution = others.filter((a) => (a.institution ?? "").toUpperCase().split(" ")[0] === inst);
    if (byInstitution.length > 0) return byInstitution;
  }
  // A card payment with no named source came from a bank account.
  const account = book.accounts.find((a) => a.id === r.accountId);
  return account?.group === "Credit cards" ? others.filter((a) => a.group === "Cash") : [];
}
