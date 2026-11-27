import { addDays, dayNumber, fromDayNumber, periodsBetween, startOfMonth } from "../../dates/isoDate.ts";
import { rowLine, sayer, sentences, stubLine, type Amount, type Sayer } from "../said.ts";
import { billAccountIds, carriesDifference, FUND_NOTICE, transferDifferenceAdjustments } from "../../ledger/transferFees.ts";
import { bookedShare } from "../booking.ts";
import { money } from "../coverage.ts";
import { accountRef, stubRef } from "../findingKeys.ts";
import type { Book } from "../load.ts";
import type { Collector } from "./collector.ts";

/**
 * The ledger agrees with itself. Cash flow, pay and taxes are built from the Book's rows;
 * net worth from the statement timelines; both are loaded separately from the same
 * statements. These invariants hold by construction, so a failure is a bug in the app or
 * a damaged database — never a problem with the owner's documents — and the figures it
 * touches are withheld until it's fixed:
 *
 *  - every statement segment ties: opening + flows + market change + fees = closing;
 *  - no two segments of an account cover the same day (nothing counted twice);
 *  - each account's rows, booked month by month, equal its timeline's flows lane by lane
 *    (so cash flow and net worth can't disagree about a dollar or the month it fell in);
 *  - every transfer pairing nets to its difference (the owner's confirmed one, or the
 *    interest a fund's notices paid a contribution with; otherwise zero) and points at rows in the
 *    ledger, and every pay stub's deposit link points at a ledger row for its net pay.
 */
export function checkConsistency(book: Book, c: Collector) {
  const fees = transferDifferenceAdjustments(
    book.matches
      .filter(carriesDifference)
      .map((m) => ({ differenceCents: m.differenceCents, method: m.method, legs: m.legs.map((l) => ({ id: l.transactionId, amountCents: l.amountCents, accountId: l.accountId })) })),
    billAccountIds(book.accounts),
  );

  for (const a of book.ledger.accounts) {
    const { ref, accounts } = accountRef(book, a.id);
    const fail = (key: string, title: string, detail: string, from: string, to: string, amounts?: Amount[]) =>
      c.add({
        id: `ledger.consistency:${ref}:${key}`,
        accounts,
        check: "ledger.consistency",
        status: "FAIL",
        title: `${a.name}: ${title}`,
        detail,
        fix: "This is a bug in the app or a damaged database, not a problem with your documents. Ask Claude to look at it (node scripts/integrity.ts ledger shows the details).",
        scope: { accountId: a.id, from, to, affects: ["CASH_FLOW", "NET_WORTH"] },
        ...(amounts?.length ? { amounts } : {}),
      });
    /** A detail sentence's sayer, for the finding `key` makes. */
    const said = (key: string) => sayer(`ledger.consistency:${ref}:${key}`, "detail");
    let ok = true;

    const segs = a.timeline.segments;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!;
      const from = fromDayNumber(s.start);
      const to = fromDayNumber(s.end);
      const flows = s.exact.reduce((t, f) => t + f.amount, 0) + s.spread.reduce((t, f) => t + f.amount, 0);
      const delta = s.closing - (s.opening + flows + s.growth + s.fees);
      if (Math.abs(delta) > 0.5) {
        ok = false;
        const d = said(`tie:${from}`);
        const seg = (cents: number, what: string) => d.usd(Math.round(cents), `the segment's ${what}`);
        fail(`tie:${from}`, `the ledger's ${from} – ${to} segment doesn't tie`, `Opening ${seg(s.opening, "opening balance")} + flows ${seg(flows, "flows")} + market change ${seg(s.growth, "market change")} + fees ${seg(s.fees, "fees")} misses the closing ${seg(s.closing, "closing balance")} by ${seg(delta, "gap")}.`, from, to, d.amounts);
      }
      const prev = segs[i - 1];
      if (prev && s.start <= prev.end) {
        ok = false;
        fail(`overlap:${from}`, `two statements cover ${from} – ${fromDayNumber(Math.min(prev.end, s.end))}`, "The days would be counted twice.", from, fromDayNumber(prev.end));
      }
    }

    // Rows booked month by month against the timeline's flows (statements only: summaries
    // and proven idle cycles have no rows of their own).
    const months = a.timeline.firstDay ? periodsBetween(startOfMonth(a.timeline.firstDay), a.timeline.lastDay!, "month") : [];
    const fromRows = new Map<string, number>();
    const fromTimeline = new Map<string, number>();
    const put = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
    for (const r of book.rows) {
      // A bill charge dated past the last bill isn't in the ledger yet (ledger/billBooking.ts).
      if (r.accountId !== a.id || r.pending) continue;
      const amount = r.amountCents - (fees.get(r.id) ?? 0);
      if (r.precision === "EXACT") put(fromRows, `${startOfMonth(r.bookedOn)}|${r.lane}`, amount);
      else
        for (const p of months) {
          const share = bookedShare(r, p.start, p.end);
          if (share > 0) put(fromRows, `${p.start}|${r.lane}`, amount * share);
        }
    }
    for (const s of segs) {
      if (s.derived || s.idle) continue;
      for (const f of s.exact) put(fromTimeline, `${startOfMonth(fromDayNumber(f.day))}|${f.lane}`, f.amount);
      for (const f of s.spread) {
        for (const p of months) {
          const lo = Math.max(s.start, dayNumber(p.start));
          const hi = Math.min(s.end, dayNumber(p.end));
          if (lo <= hi) put(fromTimeline, `${p.start}|${f.lane}`, (f.amount * (hi - lo + 1)) / s.days);
        }
      }
    }
    const off = [...new Set([...fromRows.keys(), ...fromTimeline.keys()])]
      .map((k) => ({ k, d: (fromRows.get(k) ?? 0) - (fromTimeline.get(k) ?? 0) }))
      .filter((x) => Math.abs(x.d) > 0.5)
      .sort((x, y) => x.k.localeCompare(y.k));
    if (off.length) {
      ok = false;
      const [month] = off[0]!.k.split("|");
      const d = said(`rows:${month}`);
      fail(
        `rows:${month}`,
        `cash flow and net worth disagree from ${month!.slice(0, 7)}`,
        `The account's rows and its statement timeline book different amounts: ${off.slice(0, 4).map((x) => `${x.k.split("|").join(" ")} ${d.usd(Math.round(x.d), `what the rows and the timeline differ by, ${x.k.split("|").join(" ")}`)}`).join("; ")}${off.length > 4 ? `; and ${off.length - 4} more` : ""}.`,
        month!,
        a.timeline.lastDay!,
        d.amounts,
      );
    }
    if (ok)
      c.pass("ledger.consistency", { subject: `${a.name}: statements tie, no day twice, rows book what the timeline does`, accountId: a.id, from: a.timeline.firstDay ?? book.today, to: a.timeline.lastDay ?? book.today, affects: ["CASH_FLOW", "NET_WORTH"] });
  }

  for (const m of book.matches) {
    const rows = m.legs.map((l) => book.rowById.get(l.transactionId));
    const sum = m.legs.reduce((t, l) => t + l.amountCents, 0);
    const want = carriesDifference(m) ? m.differenceCents : 0;
    // A fund contribution its notices paid entirely with interest has no bank leg at all.
    const interestOnly = m.method === FUND_NOTICE && m.legs.length === 1;
    const first = m.legs.map((l) => l.date).sort()[0] ?? book.today;
    const last = m.legs.map((l) => l.date).sort().at(-1) ?? book.today;
    const label = m.legs.map((l) => `${l.date} ${money(l.amountCents)}`).join(" ↔ ");
    const key = m.legs.map((l) => `${accountRef(book, l.accountId).ref}:${l.date}:${l.amountCents}`).sort().join("+");
    const pair = sentences(`ledger.consistency:match:${key}`);
    const legsOf = (x: Sayer) => m.legs.map((l) => `${l.date} ${x.usd(l.amountCents, `the ${l.date} leg`, [rowLine(l.date, l.amountCents, l.transactionId)])}`).join(" ↔ ");
    const problems: string[] = [];
    if (!interestOnly && (m.legs.length < 2 || new Set(m.legs.map((l) => l.accountId)).size < 2)) problems.push("it doesn't join two different accounts");
    if (sum !== want) problems.push(`its legs net to ${pair.detail.usd(sum, "what the legs net to", m.legs.map((l) => rowLine(l.date, l.amountCents, l.transactionId)))} instead of ${pair.detail.usd(want, "what they should net to")}`);
    if (rows.some((r) => !r)) problems.push("a leg is on a statement that isn't in the ledger (held, a year-end summary, or an archived account)");
    if (rows.some((r) => r && r.lane !== "TRANSFER")) problems.push("a leg is no longer filed as a transfer, so the pair would count it twice");
    if (problems.length === 0) {
      c.pass("ledger.consistency", { subject: `Transfer pairing ${label}`, from: first, to: last, affects: ["CASH_FLOW", "NET_WORTH"] });
      continue;
    }
    c.add({
      id: `ledger.consistency:match:${key}`,
      check: "ledger.consistency",
      status: "FAIL",
      title: `Transfer pairing ${legsOf(pair.title)} is broken`,
      detail: `The pairing is stored, but ${problems.join("; ")}.`,
      fix: "Unpair it on Statements › Transfers and pair the right rows (or reclassify the leg back to a transfer).",
      scope: { from: addDays(first, -3), to: addDays(last, 3), affects: ["CASH_FLOW", "NET_WORTH"] },
      amounts: pair.amounts,
    });
  }

  for (const s of book.stubs) {
    if (!s.depositTransactionId) continue;
    const r = book.rowById.get(s.depositTransactionId);
    if (r && r.amountCents === s.printed.netCurrent) {
      c.pass("ledger.consistency", { subject: `${s.employer} stub ${s.payDate} is linked to its deposit`, personId: s.personId ?? undefined, employerKey: s.employerKey, from: s.payDate, to: s.payDate, affects: ["PAY", "TAX"] });
      continue;
    }
    const link = sentences(`ledger.consistency:stub:${stubRef(s)}`);
    c.add({
      id: `ledger.consistency:stub:${stubRef(s)}`,
      check: "ledger.consistency",
      status: "FAIL",
      title: `${s.employer} stub ${s.payDate} is linked to the wrong deposit`,
      detail: r ? `The linked bank row is ${link.detail.usd(r.amountCents, "the linked bank row's amount", [rowLine(`${r.date} ${r.payee}`, r.amountCents, r.id)])}; the stub's net pay is ${link.detail.usd(s.printed.netCurrent, "the stub's net pay", [stubLine("Net pay, as the stub prints it", s.printed.netCurrent, s.id)])}.` : "The linked bank row isn't in the ledger.",
      fix: "Re-run the classifier (Settings → Data) to re-link pay stubs; if it persists, ask Claude to look at it.",
      scope: { personId: s.personId ?? undefined, employerKey: s.employerKey, from: s.payDate, to: `${s.payDate.slice(0, 4)}-12-31`, affects: ["PAY", "TAX"] },
      amounts: link.amounts,
    });
  }
}
