import { addDays, fromDayNumber, maxIso } from "../../dates/isoDate.ts";
import { chainBreaks } from "../../ledger/timeline.ts";
import { money } from "../coverage.ts";
import { accountRef } from "../findingKeys.ts";
import { PAYMENT_GRACE_DAYS } from "../idleCards.ts";
import type { Book } from "../load.ts";
import { accountOwner, isPartnerAccount } from "../owners.ts";
import type { Collector } from "./collector.ts";

const BANKING = new Set(["Cash", "Credit cards"]);

/**
 * Statements: every one reconciles and is counted, consecutive ones chain, there are no
 * gaps (unless provably empty), the latest one is on file, and nothing predates the
 * first statement unseen.
 */
export function checkStatements(book: Book, c: Collector) {
  const nameOf = (id: string) => book.accounts.find((a) => a.id === id)?.name ?? "Account";
  const institutionOf = (id: string) => book.accounts.find((a) => a.id === id)?.institution ?? "the institution";

  for (const s of book.statements) {
    if (s.status === "COMMITTED") {
      c.pass("statement.held", {
        subject: `${nameOf(s.accountId)} ${s.periodStart} – ${s.periodEnd}${s.isSummary ? " (summary)" : ""}`,
        accountId: s.accountId,
        from: s.periodStart,
        to: s.periodEnd,
        affects: ["CASH_FLOW", "NET_WORTH"],
      });
      continue;
    }
    const { ref, accounts } = accountRef(book, s.accountId);
    c.add({
      id: `statement.held:${ref}:${s.periodStart}:${s.periodEnd}`,
      accounts,
      check: "statement.held",
      status: "FAIL",
      title: `${nameOf(s.accountId)} ${s.periodStart} – ${s.periodEnd} is held out of the ledger`,
      detail:
        s.status === "DISCREPANT"
          ? `The statement doesn't reconcile: its rows miss the printed balance by ${money(s.deltaCents)}.`
          : "The statement reconciles but hasn't been committed.",
      fix: "Open Statements → Documents and resolve it (commit it, or fix the parser for this layout).",
      scope: { accountId: s.accountId, from: s.periodStart, to: s.periodEnd, affects: ["CASH_FLOW", "NET_WORTH"] },
    });
  }

  for (const a of book.ledger.accounts) {
    const t = a.timeline;
    const affects = BANKING.has(a.group) ? (["CASH_FLOW", "NET_WORTH"] as const) : (["NET_WORTH"] as const);
    const { ref, accounts } = accountRef(book, a.id);
    // What a pass over the whole account vouches for.
    const whole = (subject: string) => ({ subject: `${a.name}: ${subject}`, accountId: a.id, from: t.firstDay ?? book.today, to: t.lastDay ?? book.today, affects: [...affects] });

    // Chain: opening = prior closing.
    const breaks = chainBreaks(t);
    if (breaks.length === 0) c.pass("statement.chain", whole(`${t.firstDay} – ${t.lastDay}, every opening = the previous closing`));
    for (const b of breaks) {
      c.add({
        id: `statement.chain:${ref}:${b.at}`,
        accounts,
        check: "statement.chain",
        status: "FAIL",
        title: `${a.name}: statement starting ${b.at} doesn't continue from the one before`,
        detail: `It opens at ${money(b.openingCents)}, but the previous statement closed at ${money(b.priorClosingCents)}.`,
        fix: "One of the two statements was read wrong, or a statement between them is missing. Check both in Statements → Documents.",
        scope: { accountId: a.id, from: addDays(b.at, -1), to: b.at, affects: [...affects] },
      });
    }

    // Gaps: missing unless provably empty.
    const segs = [...t.segments].sort((x, y) => x.start - y.start);
    let gaps = 0;
    for (let i = 1; i < segs.length; i++) {
      const prev = segs[i - 1]!;
      const cur = segs[i]!;
      if (cur.start <= prev.end + 1) continue;
      gaps++;
      const from = fromDayNumber(prev.end + 1);
      const to = fromDayNumber(cur.start - 1);
      const inst = (a.institution ?? "").toUpperCase();
      const touched = book.rows.filter(
        (r) => r.accountId !== a.id && r.date >= from && r.date <= to && r.lane === "TRANSFER" && r.transferMatchId == null && inst !== "" && (r.counterpartyInstitution ?? "").toUpperCase().includes(inst.split(" ")[0]!),
      );
      // Issuers that skip idle cycles are judged by the stricter bank-side proof alone.
      const notIdle = book.idle.unproven.find((u) => u.accountId === a.id && u.from === from);
      if (notIdle) {
        c.add({
          id: `statement.gap:${ref}:${from}:${to}`,
          accounts,
          check: "statement.gap",
          status: "MISSING",
          title: `${a.name}: no statement for ${from} – ${to}`,
          detail: `The months can't be proven idle: ${notIdle.reason}`,
          fix: `Download the ${institutionOf(a.id)} statement(s) covering ${from} – ${to} (if ${institutionOf(a.id)} issued none, the paying bank's statements for that window prove it).`,
          scope: { accountId: a.id, from, to: addDays(to, -1), affects: ["NET_WORTH"] },
          extraScopes: BANKING.has(a.group) ? [{ accountId: a.id, from, to, affects: ["CASH_FLOW"] }] : undefined,
          needs: { accountIds: [a.id], from, to },
        });
        continue;
      }
      if (prev.closing === 0 && cur.opening === 0 && touched.length === 0) {
        c.infer({
          id: `statement.gap:${ref}:${from}:${to}`,
          check: "statement.gap",
          title: `${a.name}: no statement ${from} – ${to}, provably empty`,
          detail: "The balance was $0 before and after, and no money moved to or from the account in between (institutions don't issue statements for idle months).",
        });
        continue;
      }
      c.add({
        id: `statement.gap:${ref}:${from}:${to}`,
        accounts,
        check: "statement.gap",
        status: "MISSING",
        title: `${a.name}: no statement for ${from} – ${to}`,
        detail:
          touched.length > 0
            ? `${touched.length} payment(s) to it from other accounts fall in that window (e.g. ${touched[0]!.date} ${money(touched[0]!.amountCents)}).`
            : `The balance went from ${money(prev.closing)} to ${money(cur.opening)} with nothing on file in between.`,
        fix: `Download the ${institutionOf(a.id)} statement(s) covering ${from} – ${to} into the statements folder and scan it.`,
        // The balance on the gap's last day is the next statement's opening: known.
        scope: { accountId: a.id, from, to: addDays(to, -1), affects: ["NET_WORTH"] },
        extraScopes: BANKING.has(a.group) ? [{ accountId: a.id, from, to, affects: ["CASH_FLOW"] }] : undefined,
        needs: { accountIds: [a.id], from, to },
      });
    }
    if (gaps === 0) c.pass("statement.gap", whole(`no gaps ${t.firstDay} – ${t.lastDay}`));
    for (const w of book.idle.proven.filter((x) => x.accountId === a.id)) {
      const payers = w.payerIds.map(nameOf).join(" and ");
      const paidOff = w.payoff.length
        ? `The last statement left ${money(-w.openingCents)} owing, paid off by ${payers} (${w.payoff.map((p) => `${p.date} ${money(p.amountCents)}`).join(", ")})`
        : null;
      c.infer({
        id: `statement.idle:${ref}:${w.from}`,
        check: "statement.gap",
        title: paidOff
          ? `${a.name}: no statement ${w.from} – ${w.to}, paid off then idle — counted as $0`
          : `${a.name}: no statement ${w.from} – ${w.to}, no activity — counted as $0`,
        detail: w.trailing
          ? `${institutionOf(a.id)} sends no statement for a cycle without activity. ${paidOff ? `${paidOff}, and after that` : `The last statement closed at $0, and`} ${payers} shows no payment to the card through ${PAYMENT_GRACE_DAYS} days after each of these cycles closed.`
          : `${institutionOf(a.id)} sends no statement for a cycle without activity. ${paidOff ? `${paidOff}; the next statement opens at $0, and` : `The balance was $0 before and after, and`} ${payers} (statements on file for the whole window) shows no other unpaired payment to the card in between.`,
      });
    }

    // Overdue: the next statement should exist by now.
    if (!a.closed) {
      const real = segs.filter((s) => !s.derived && !s.idle);
      const lengths = (real.length > 1 ? real.slice(1) : real).map((s) => s.days).sort((x, y) => x - y);
      const cadence = Math.max(28, lengths[Math.floor(lengths.length / 2)] ?? 31);
      const due = addDays(t.lastDay!, cadence + 15);
      if (due < book.today) {
        c.add({
          id: `statement.overdue:${ref}:${t.lastDay}`,
          accounts,
          check: "statement.overdue",
          status: "MISSING",
          title: `${a.name}: statements after ${t.lastDay} aren't on file`,
          detail: `The next statement was due by ${due}.`,
          fix: `Download the latest ${institutionOf(a.id)} statement(s) into the statements folder and scan it.`,
          scope: { accountId: a.id, from: addDays(t.lastDay!, 1), to: book.today, affects: [...affects] },
          needs: { accountIds: [a.id], from: addDays(t.lastDay!, 1), to: addDays(t.lastDay!, cadence) },
        });
      } else c.pass("statement.overdue", whole(`latest statement through ${t.lastDay}, next due by ${due}`));
    }

    // History: a first statement that already holds money. A partner's own account only
    // needs history back to the merge date: before it, that money was the partner's own,
    // and the account joins the household at its first statement (its opening balance is
    // newly tracked, not savings).
    const first = segs[0];
    const partner = isPartnerAccount(book, a.id);
    const needFrom = book.ledger.firstDay && (partner ? maxIso(book.ledger.firstDay, book.ledger.mergeDate) : book.ledger.firstDay);
    if (first && first.opening !== 0 && needFrom && t.firstDay! > needFrom) {
      c.add({
        id: `statement.history:${ref}:${t.firstDay}`,
        accounts,
        check: "statement.history",
        status: "MISSING",
        title: `${a.name}: history before ${t.firstDay} isn't on file`,
        detail: `The first statement on file opens with ${money(first.opening)} already in the account.`,
        fix: partner
          ? `Download earlier ${institutionOf(a.id)} statements (back to when the account opened, or to the ${needFrom} merge date) into the statements folder and scan them.`
          : `Download earlier ${institutionOf(a.id)} statements (back to when the account opened, or to ${needFrom}) into the statements folder and scan them.`,
        // The balance the day before the first statement is its opening: known. Flows
        // through that day are not.
        scope: { accountId: a.id, from: needFrom, to: addDays(t.firstDay!, -2), affects: ["NET_WORTH"] },
        extraScopes: BANKING.has(a.group) ? [{ accountId: a.id, from: needFrom, to: addDays(t.firstDay!, -1), affects: ["CASH_FLOW"] }] : undefined,
        needs: { accountIds: [a.id], from: needFrom, to: addDays(t.firstDay!, -1) },
      });
    } else if (first && first.opening !== 0 && partner && book.ledger.firstDay && t.firstDay! > book.ledger.firstDay) {
      const owner = book.persons.find((p) => p.id === accountOwner(book, a.id))?.name ?? "the partner";
      c.infer({
        id: `statement.history:${ref}:${t.firstDay}:partner`,
        check: "statement.history",
        title: `${a.name}: joins the household at its first statement (${t.firstDay})`,
        detail: `It's ${owner}'s own account, and its first statement on file predates the ${book.ledger.mergeDate} merge. The ${money(first.opening)} it opened with was ${owner}'s money from before the merge, so it counts as newly tracked when the account joins, not as savings, and no earlier statements are needed.`,
      });
    } else c.pass("statement.history", whole(first && first.opening !== 0 ? `first statement (${t.firstDay}) is where the records start` : `opens at $0 on ${t.firstDay}`));
  }
}
