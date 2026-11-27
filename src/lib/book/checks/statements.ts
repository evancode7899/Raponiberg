import { addDays, fromDayNumber, maxIso } from "../../dates/isoDate.ts";
import { chainBreaks } from "../../ledger/timeline.ts";
import { rowLine, sentences, statementLine } from "../said.ts";
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
    // A committed statement's printed totals are re-checked here, not taken from its stored
    // status: a database restored from elsewhere can't carry in a statement that doesn't tie.
    const broken = s.status === "COMMITTED" ? (s.checks ?? []).filter((k) => Math.abs(k.expectedCents - k.actualCents) > k.toleranceCents) : [];
    if (broken.length) {
      const { ref, accounts } = accountRef(book, s.accountId);
      const id = `statement.held:${ref}:${s.periodStart}:${s.periodEnd}:printed`;
      const w = sentences(id);
      c.add({
        id,
        accounts,
        check: "statement.held",
        status: "FAIL",
        title: `${nameOf(s.accountId)} ${s.periodStart} – ${s.periodEnd} doesn't match its printed totals`,
        detail: broken.map((k) => `${k.label}: printed ${w.detail.usd(k.expectedCents, `${k.label}, as the statement prints it`, [statementLine(`${k.label}, printed`, k.expectedCents, s.id)])}, rows give ${w.detail.usd(k.actualCents, `${k.label}, from the statement's rows`)}`).join("; ") + ".",
        fix: "Re-import the statement (Statements → Documents). If it still doesn't tie, the parser misreads this layout.",
        scope: { accountId: s.accountId, from: s.periodStart, to: s.periodEnd, affects: ["CASH_FLOW", "NET_WORTH"] },
        amounts: w.amounts,
      });
      continue;
    }
    if (s.status === "COMMITTED" && s.growthDerived && !s.isSummary) {
      const { ref } = accountRef(book, s.accountId);
      c.infer({
        id: `statement.growth:${ref}:${s.periodStart}:${s.periodEnd}`,
        check: "statement.held",
        title: `${nameOf(s.accountId)} ${s.periodStart} – ${s.periodEnd}: market change is what the balances leave`,
        detail:
          "The statement prints its opening and closing values but no change-in-value line, so market change is the difference the listed deposits and withdrawals don't explain. Each of those that moved money from a tracked account also has to pair with that account's statement (Every transfer pairs), so a flow the parser missed shows up there; money from an account the app doesn't track would not.",
        scope: { accountId: s.accountId, from: s.periodStart, to: s.periodEnd },
      });
    }
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
    const heldId = `statement.held:${ref}:${s.periodStart}:${s.periodEnd}`;
    const held = sentences(heldId);
    c.add({
      id: heldId,
      accounts,
      check: "statement.held",
      status: "FAIL",
      title: `${nameOf(s.accountId)} ${s.periodStart} – ${s.periodEnd} is held out of the ledger`,
      detail:
        s.status === "DISCREPANT"
          ? `The statement doesn't reconcile: its rows miss the printed balance by ${held.detail.usd(s.deltaCents, "the printed balance less what the statement's rows give")}.`
          : "The statement reconciles but hasn't been committed.",
      fix: "Open Statements → Documents and resolve it (commit it, or fix the parser for this layout).",
      scope: { accountId: s.accountId, from: s.periodStart, to: s.periodEnd, affects: ["CASH_FLOW", "NET_WORTH"] },
      amounts: held.amounts,
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
      const id = `statement.chain:${ref}:${b.at}`;
      const w = sentences(id);
      c.add({
        id,
        accounts,
        check: "statement.chain",
        status: "FAIL",
        title: `${a.name}: statement starting ${b.at} doesn't continue from the one before`,
        detail: `It opens at ${w.detail.usd(b.openingCents, `the opening balance printed on the statement starting ${b.at}`)}, but the previous statement closed at ${w.detail.usd(b.priorClosingCents, "the previous statement's printed closing balance")}.`,
        fix: "One of the two statements was read wrong, or a statement between them is missing. Check both in Statements → Documents.",
        scope: { accountId: a.id, from: addDays(b.at, -1), to: b.at, affects: [...affects] },
        amounts: w.amounts,
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
          detail: "The balance was zero before and after, and no money moved to or from the account in between (institutions don't issue statements for idle months).",
        });
        continue;
      }
      const gap = sentences(`statement.gap:${ref}:${from}:${to}`);
      c.add({
        id: `statement.gap:${ref}:${from}:${to}`,
        accounts,
        check: "statement.gap",
        status: "MISSING",
        title: `${a.name}: no statement for ${from} – ${to}`,
        detail:
          touched.length > 0
            ? `${touched.length} payment(s) to it from other accounts fall in that window (e.g. ${touched[0]!.date} ${gap.detail.usd(touched[0]!.amountCents, `the ${touched[0]!.date} payment to it`, [rowLine(touched[0]!.date, touched[0]!.amountCents, touched[0]!.id)])}).`
            : `The balance went from ${gap.detail.usd(prev.closing, "the closing balance before the gap", [statementLine("Printed closing balance", prev.closing, prev.importId)])} to ${gap.detail.usd(cur.opening, "the opening balance after the gap", [statementLine("Printed opening balance", cur.opening, cur.importId)])} with nothing on file in between.`,
        fix: `Download the ${institutionOf(a.id)} statement(s) covering ${from} – ${to} into the statements folder and scan it.`,
        // The balance on the gap's last day is the next statement's opening: known.
        scope: { accountId: a.id, from, to: addDays(to, -1), affects: ["NET_WORTH"] },
        extraScopes: BANKING.has(a.group) ? [{ accountId: a.id, from, to, affects: ["CASH_FLOW"] }] : undefined,
        needs: { accountIds: [a.id], from, to },
        amounts: gap.amounts,
      });
    }
    if (gaps === 0) c.pass("statement.gap", whole(`no gaps ${t.firstDay} – ${t.lastDay}`));
    // An owner-closed card's payoff is part of its closure (below), not an idle cycle.
    for (const w of book.idle.proven.filter((x) => x.accountId === a.id && a.closedByOwner == null)) {
      const payers = w.payerIds.map(nameOf).join(" and ");
      const idle = sentences(`statement.idle:${ref}:${w.from}`);
      const paidOff = w.payoff.length
        ? `The last statement left ${idle.detail.usd(-w.openingCents, "what the last statement left owing", [statementLine("Owing at the last statement", -w.openingCents, null)])} owing, paid off by ${payers} (${w.payoff.map((p) => `${p.date} ${idle.detail.usd(p.amountCents, `the ${p.date} payment`, [rowLine(p.date, p.amountCents, p.transactionId)])}`).join(", ")})`
        : null;
      c.infer({
        id: `statement.idle:${ref}:${w.from}`,
        check: "statement.gap",
        title: paidOff
          ? `${a.name}: no statement ${w.from} – ${w.to}, paid off then idle — counted as zero${w.provisionalFrom ? ` (provisional from ${w.provisionalFrom})` : ""}`
          : `${a.name}: no statement ${w.from} – ${w.to}, no activity — counted as zero${w.provisionalFrom ? ` (provisional from ${w.provisionalFrom})` : ""}`,
        detail: w.trailing
          ? `${institutionOf(a.id)} sends no statement for a cycle without activity. ${paidOff ? `${paidOff}, and after that` : `The last statement closed at zero, and`} ${payers} shows no payment to the card ${
              w.provisionalFrom
                ? `through ${w.to}. From ${w.provisionalFrom} it's provisional: a payment for those days could still show up on the next ${payers} statement, which would take it back.`
                : `through ${PAYMENT_GRACE_DAYS} days after each of these cycles closed.`
            }`
          : `${institutionOf(a.id)} sends no statement for a cycle without activity. ${paidOff ? `${paidOff}; the next statement opens at zero, and` : `The balance was zero before and after, and`} ${payers} (statements on file for the whole window) shows no other unpaired payment to the card in between.`,
        amounts: idle.amounts,
      });
    }

    // Closed by the owner's word, not by a $0 closing statement.
    if (a.closedByOwner != null) {
      const last = segs.filter((s) => !s.idle).at(-1)!;
      const lastDay = fromDayNumber(last.end);
      const payoff = book.idle.proven.find((w) => w.accountId === a.id && w.trailing);
      // The owner's own note (closed-accounts.json) isn't quoted: it's their words, and may print an amount no proof holds.
      const owner = "the owner marked the account closed";
      const closed = sentences(`statement.closed:${ref}:${lastDay}`);
      const beyond = `A payment to ${institutionOf(a.id)} after that statement that no other card received${payoff ? " and that the payoff doesn't account for" : ""} is counted as spending on a closing statement that isn't on file.`;
      c.infer({
        id: `statement.closed:${ref}:${lastDay}`,
        check: "statement.overdue",
        title: payoff
          ? `${a.name}: closed after ${lastDay} (owner), paid off ${payoff.to} — no statements expected`
          : `${a.name}: closed after ${lastDay} (owner) — no statements expected`,
        detail: payoff
          ? `Its last statement left ${closed.detail.usd(-payoff.openingCents, "what the last statement left owing")} owing, paid off by ${payoff.payerIds.map(nameOf).join(" and ")} (${payoff.payoff.map((p) => `${p.date} ${closed.detail.usd(p.amountCents, `the ${p.date} payment`, [rowLine(p.date, p.amountCents, p.transactionId)])}`).join(", ")}), so it ends at zero; ${owner}. ${beyond}`
          : `Its last statement closed at ${closed.detail.usd(last.closing, "the last statement's printed closing balance", [statementLine("Printed closing balance", last.closing, last.importId)])}, not zero; ${owner}. ${beyond}`,
        scope: { accountId: a.id, from: lastDay, to: t.lastDay! },
        amounts: closed.amounts,
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
    const hist = sentences(`statement.history:${ref}:${t.firstDay}`);
    const opened = (x: typeof hist) => (first ? x.detail.usd(first.opening, "the first statement's printed opening balance", [statementLine("Printed opening balance", first.opening, first.importId)]) : "");
    if (first && first.opening !== 0 && needFrom && t.firstDay! > needFrom) {
      c.add({
        id: `statement.history:${ref}:${t.firstDay}`,
        accounts,
        check: "statement.history",
        status: "MISSING",
        title: `${a.name}: history before ${t.firstDay} isn't on file`,
        detail: `The first statement on file opens with ${opened(hist)} already in the account.`,
        fix: partner
          ? `Download earlier ${institutionOf(a.id)} statements (back to when the account opened, or to the ${needFrom} merge date) into the statements folder and scan them.`
          : `Download earlier ${institutionOf(a.id)} statements (back to when the account opened, or to ${needFrom}) into the statements folder and scan them.`,
        // The balance the day before the first statement is its opening: known. Flows
        // through that day are not.
        scope: { accountId: a.id, from: needFrom, to: addDays(t.firstDay!, -2), affects: ["NET_WORTH"] },
        extraScopes: BANKING.has(a.group) ? [{ accountId: a.id, from: needFrom, to: addDays(t.firstDay!, -1), affects: ["CASH_FLOW"] }] : undefined,
        needs: { accountIds: [a.id], from: needFrom, to: addDays(t.firstDay!, -1) },
        amounts: hist.amounts,
      });
    } else if (first && first.opening !== 0 && partner && book.ledger.firstDay && t.firstDay! > book.ledger.firstDay) {
      const owner = book.persons.find((p) => p.id === accountOwner(book, a.id))?.name ?? "the partner";
      const joins = sentences(`statement.history:${ref}:${t.firstDay}:partner`);
      c.infer({
        id: `statement.history:${ref}:${t.firstDay}:partner`,
        check: "statement.history",
        title: `${a.name}: joins the household at its first statement (${t.firstDay})`,
        detail: `It's ${owner}'s own account, and its first statement on file predates the ${book.ledger.mergeDate} merge. The ${opened(joins)} it opened with was ${owner}'s money from before the merge, so it counts as newly tracked when the account joins, not as savings, and no earlier statements are needed.`,
        amounts: joins.amounts,
      });
    } else c.pass("statement.history", whole(first && first.opening !== 0 ? `first statement (${t.firstDay}) is where the records start` : `opens at $0 on ${t.firstDay}`));
  }

  // An account with no committed statement at all (made by hand, or every statement held)
  // isn't in the ledger, so its money is in no figure: said, never just left out.
  const inLedger = new Set(book.ledger.accounts.map((a) => a.id));
  for (const a of book.accounts) {
    if (inLedger.has(a.id) || a.archived) continue;
    const { ref, accounts } = accountRef(book, a.id);
    c.add({
      id: `statement.overdue:${ref}:none`,
      accounts,
      check: "statement.overdue",
      status: "MISSING",
      title: `${a.name}: no statements on file`,
      detail: "No committed statement covers this account, so whatever it holds or owes is in no figure.",
      fix: `Download its ${a.institution ?? "institution's"} statements into the statements folder and scan them, or archive the account (Settings → Accounts) if it holds nothing.`,
      scope: { accountId: a.id, from: book.today, to: book.today, affects: ["NET_WORTH", "CASH_FLOW"] },
    });
  }
}
