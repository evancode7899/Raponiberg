import { addDays } from "../../dates/isoDate.ts";
import { stubChecks } from "../../ingest/payroll/checks.ts";
import { accountsByLast4, isCovered, money, uncovered } from "../coverage.ts";
import { personRef, stubRef } from "../findingKeys.ts";
import type { Book, BookStub } from "../load.ts";
import { employerDeposits, netYtd, stubGroups, UNKNOWN_PERSON } from "../pay.ts";
import type { Collector } from "./collector.ts";

/**
 * Pay stubs prove themselves (arithmetic), belong to someone, reached the bank, and form
 * an unbroken year: each stub's year-to-date figures carry from the one before (or the
 * jump is explained by paychecks deposited in between), nothing was paid after the
 * year's last stub, and the year's net pay equals what the bank received.
 */
export function checkPay(book: Book, c: Collector) {
  const personName = (id: string | null) => book.persons.find((p) => p.id === id)?.name ?? "someone";
  // A stub's problem makes pay unprovable from its pay date on (year-to-date figures carry
  // forward), not for the part of the year before it.
  const yearScope = (s: BookStub) => ({
    personId: s.personId ?? undefined,
    employerKey: s.employerKey,
    from: s.payDate,
    to: `${s.payDate.slice(0, 4)}-12-31`,
    affects: ["PAY" as const, "TAX" as const],
  });
  const label = (s: BookStub) => `${s.employer} stub ${s.payDate}`;
  const stubPass = (s: BookStub, what: string) => ({ subject: `${label(s)} ${what}`, personId: s.personId ?? undefined, employerKey: s.employerKey, from: s.payDate, to: s.payDate, affects: ["PAY" as const, "TAX" as const] });
  // Accounts whose statements can't be obtained (household settings): pay deposited there
  // is taken from the stubs and labelled partial instead of blocking.
  const unavailable = new Map((book.taxProfile.unavailableAccounts ?? []).map((a) => [a.last4, a.note]));
  const toUnavailable = (s: BookStub) => s.deposits.length > 0 && s.deposits.every((d) => d.last4 != null && unavailable.has(d.last4));

  for (const s of book.stubs) {
    // Arithmetic.
    const bad = stubChecks(s).filter((x) => !x.ok);
    if (bad.length === 0 && s.warnings.length === 0) c.pass("paystub.arithmetic", stubPass(s, "adds up"));
    else
      c.add({
        id: `paystub.arithmetic:${stubRef(s)}`,
        check: "paystub.arithmetic",
        status: "FAIL",
        title: `${label(s)} doesn't add up`,
        detail: [...bad.map((x) => `${x.label}: printed ${money(x.expected)}, lines give ${money(x.actual)}`), ...s.warnings].join("; "),
        fix: `The stub (${s.documentTitle}) was read wrong — the ${s.source} extractor needs fixing for this layout.`,
        scope: yearScope(s),
      });

    // Person.
    if (s.personId) c.pass("paystub.person", stubPass(s, `belongs to ${personName(s.personId)}`));
    else
      c.add({
        id: `paystub.person:${stubRef(s)}`,
        check: "paystub.person",
        status: "FAIL",
        title: `${label(s)} is for "${s.employee}", who isn't in the household settings`,
        detail: "Its pay can't be attributed to anyone.",
        fix: "Add a name rule for them under Taxes → Inputs → Household.",
        scope: yearScope(s),
      });

    // Deposit.
    if (s.depositTransactionId || toUnavailable(s)) {
      c.pass("paystub.deposit", stubPass(s, s.depositTransactionId ? "reached the bank" : "was paid to an account with no statements available"));
      continue;
    }
    const accounts = s.deposits.flatMap((d) => (d.last4 ? accountsByLast4(book, d.last4) : []));
    const covered = accounts.some((a) => isCovered(book, a.id, s.payDate));
    const where = s.deposits.map((d) => `••${d.last4 ?? "?"} ${money(d.amount)}`).join(" + ") || "an unknown account";
    c.add({
      id: `paystub.deposit:${stubRef(s)}`,
      check: "paystub.deposit",
      status: covered && s.deposits.length === 1 ? "FAIL" : "MISSING",
      title: `${label(s)}: net pay ${money(s.printed.netCurrent)} isn't on a bank statement`,
      detail:
        s.deposits.length > 1
          ? `The paycheck was split (${where}); split deposits can't be matched to one bank row yet.`
          : accounts.length === 0
            ? `It was deposited to ${where}, which isn't a tracked account.`
            : covered
              ? `${accounts[0]!.name}'s statement covers ${s.payDate}, but no deposit of ${money(s.printed.netCurrent)} is within 5 days of it.`
              : `No statement for ${accounts[0]!.name} covers ${s.payDate}.`,
      fix:
        accounts.length === 0
          ? `Add statements for the account the pay went to (${s.deposits.map((d) => `••${d.last4 ?? "?"}`).join(", ")}).`
          : covered
            ? "Check the stub and the bank row (Transactions) — one of them was read wrong."
            : `Download the ${accounts[0]!.institution ?? ""} statement covering ${s.payDate}.`,
      scope: yearScope(s),
    });
  }

  // Year chains, per person | employer | year.
  const inferredIds = new Set<string>();
  /** Whose pay each paycheck deposit is (from its stub, or the chain that infers it), so its pass is scoped to them. */
  const depositOwner = new Map<string, { personId?: string; employerKey: string }>();
  for (const s of book.stubs) if (s.depositTransactionId) depositOwner.set(s.depositTransactionId, { personId: s.personId ?? undefined, employerKey: s.employerKey });
  const employerKeys = new Map<string, string>();
  for (const [key, stubs] of stubGroups(book)) {
    const [personId, employerKey, yearStr] = key.split("|") as [string, string, string];
    const year = Number(yearStr);
    const groupRef = `${personRef(book, personId === UNKNOWN_PERSON ? null : personId)}|${employerKey}|${year}`;
    const yearEnd = `${year}-12-31`;
    const last = stubs.at(-1)!;
    const scope = { personId: personId === UNKNOWN_PERSON ? undefined : personId, employerKey, from: `${year}-01-01`, to: yearEnd, affects: ["PAY" as const, "TAX" as const] };
    const who = `${personName(personId)} · ${last.employer} ${year}`;
    const deposits = employerDeposits(book, employerKey);
    const linkedIds = new Set(book.stubs.map((s) => s.depositTransactionId).filter(Boolean));
    const unlinked = deposits.filter((r) => !linkedIds.has(r.id));
    for (const r of deposits) if (r.merchantKey) employerKeys.set(r.merchantKey, employerKey);

    // Continuity: YTD net before each pay date = the previous pay date's YTD net. Checks
    // paid the same day (a regular and an off-cycle check) print the same combined YTD,
    // so they count as one payment.
    const byDate = new Map<string, BookStub[]>();
    for (const s of stubs) byDate.set(s.payDate, [...(byDate.get(s.payDate) ?? []), s]);
    let prevNet = 0;
    let prevDate = `${year - 1}-12-31`;
    let broken = false;
    /** Net pay before the year's first stub on file, known only from its year-to-date figures. */
    let carriedIn = 0;
    for (const sameDay of byDate.values()) {
      const s = sameDay.reduce((a, b) => (netYtd(b) > netYtd(a) ? b : a));
      const paid = sameDay.reduce((t, x) => t + x.printed.netCurrent, 0);
      const jump = netYtd(s) - paid - prevNet;
      const isFirst = prevDate === `${year - 1}-12-31`;
      if (jump !== 0) {
        const between = unlinked.filter((r) => r.date > addDays(prevDate, 3) && r.date < addDays(s.payDate, -3));
        const explained = between.reduce((t, r) => t + r.amountCents, 0);
        if (jump > 0 && isFirst && explained !== jump) {
          // The year's earliest stubs aren't available: the first stub on file carries their
          // totals in its year-to-date figures. The year's pay stands, marked partial (owner's
          // rule, 2026-10-04) — the paychecks before it can't be checked one by one.
          carriedIn = jump;
          c.infer({
            id: `pay.continuity:${stubRef(s)}`,
            check: "pay.continuity",
            partial: true,
            title: `${who}: pay before ${s.payDate} is known only from year-to-date totals (partial)`,
            detail: `The first stub on file (${s.payDate}) already shows ${money(jump)} of net pay earlier in ${year}. Those earlier stubs aren't available, so that pay is taken from the ${s.payDate} stub's year-to-date figures and can't be checked paycheck by paycheck.`,
            scope: { personId: scope.personId, employerKey, from: `${year}-01-01`, to: addDays(s.payDate, -1) },
          });
        } else if (jump > 0 && explained === jump) {
          for (const r of between) {
            inferredIds.add(r.id);
            depositOwner.set(r.id, { personId: scope.personId, employerKey });
          }
          c.infer({
            id: `pay.continuity:${stubRef(s)}`,
            check: "pay.continuity",
            title: `${who}: ${between.length} paycheck(s) between ${prevDate} and ${s.payDate} have no stub`,
            detail: `Their total (${money(jump)} net) is inferred from two sources: the year-to-date figures on the ${s.payDate} stub and the deposits the bank received (${between.map((r) => `${r.date} ${money(r.amountCents)}`).join(", ")}).`,
          });
        } else {
          broken = true;
          c.add({
            id: `pay.continuity:${stubRef(s)}`,
            check: "pay.continuity",
            status: jump < 0 ? "FAIL" : "MISSING",
            title: jump < 0 ? `${who}: year-to-date pay goes backwards at ${s.payDate}` : `${who}: pay stub(s) missing between ${prevDate} and ${s.payDate}`,
            detail:
              jump < 0
                ? `The ${s.payDate} stub's year-to-date net is ${money(-jump)} less than the stub before it plus this check.`
                : `Year-to-date net pay jumps ${money(jump)} more than this check, and the bank deposits in between ${between.length ? `(${money(explained)})` : "(none found)"} don't account for it.`,
            fix: jump < 0 ? "One of the two stubs was read wrong; check them in Statements → Documents." : `Download the ${s.employer} pay stub(s) dated between ${prevDate} and ${s.payDate}.`,
            scope,
          });
        }
      }
      prevNet = netYtd(s);
      prevDate = s.payDate;
    }
    if (!broken) c.pass("pay.continuity", { subject: `${who}: year-to-date totals carry from stub to stub`, ...scope });

    // Nothing paid after the year's last stub. A paycheck without a stub only leaves the
    // pay after the last stub unread: the stubs on file prove the year up to it.
    const after = unlinked.filter((r) => r.date > addDays(last.payDate, 3) && r.date <= yearEnd);
    if (after.length === 0) c.pass("pay.after-last-stub", { subject: `${who}: nothing paid after the ${last.payDate} stub`, ...scope });
    else
      c.add({
        id: `pay.after-last-stub:${groupRef}`,
        check: "pay.after-last-stub",
        status: "MISSING",
        title: `${who}: ${after.length} paycheck(s) after the ${last.payDate} stub have no stub`,
        detail: `Deposits: ${after.map((r) => `${r.date} ${money(r.amountCents)}`).join(", ")}. The year's pay can't be read without the latest stub.`,
        fix: `Download the ${last.employer} pay stub(s) dated after ${last.payDate}.`,
        scope: { ...scope, from: addDays(last.payDate, 1) },
      });

    // Paychecks deposited to an account with no statements available: from the stubs, partial.
    const lost = stubs.filter(toUnavailable);
    const lostNet = lost.reduce((t, s) => t + s.printed.netCurrent, 0);
    if (lost.length) {
      const where = [...new Set(lost.flatMap((s) => s.deposits.map((d) => d.last4!)))];
      c.infer({
        id: `pay.unavailable:${groupRef}`,
        check: "pay.deposits-tie",
        partial: true,
        title: `${who}: ${lost.length} paycheck(s), ${money(lostNet)} net, went to ${where.map((l) => `••${l}`).join(", ")} (no statements available)`,
        detail: `${where.map((l) => `••${l}: ${unavailable.get(l) || "statements unavailable"}`).join("; ")}. That pay is taken from the stubs; the deposits can't be checked.`,
        scope: { personId: scope.personId, employerKey, from: `${year}-01-01`, to: yearEnd },
      });
    }

    // Year-to-date net = what the bank received (paychecks to tracked accounts).
    const tracked = stubs.filter((s) => !toUnavailable(s));
    const expected = netYtd(last) - carriedIn - lostNet;
    const depositAccounts = [...new Set(tracked.flatMap((s) => s.deposits.flatMap((d) => (d.last4 ? accountsByLast4(book, d.last4) : []))).map((a) => a.id))];
    const firstTracked = tracked[0];
    const windowFrom = firstTracked?.periodStart && firstTracked.periodStart.startsWith(String(year)) ? firstTracked.periodStart : (firstTracked?.payDate ?? `${year}-01-01`);
    const holes = depositAccounts.flatMap((id) => uncovered(book, id, windowFrom, last.payDate));
    const linkedHere = stubs.map((s) => (s.depositTransactionId ? book.rowById.get(s.depositTransactionId) : undefined)).filter((r) => !!r);
    const received =
      linkedHere.reduce((t, r) => t + r!.amountCents, 0) + unlinked.filter((r) => r.date >= `${year}-01-01` && r.date <= addDays(last.payDate, 3)).reduce((t, r) => t + r.amountCents, 0);
    if (tracked.length === 0 && expected === 0) {
      c.pass("pay.deposits-tie", { subject: `${who}: no paychecks to tracked accounts`, ...scope });
    } else if (depositAccounts.length === 0 || holes.length > 0) {
      c.add({
        id: `pay.deposits-tie:${groupRef}`,
        check: "pay.deposits-tie",
        status: "MISSING",
        title: `${who}: bank statements don't cover every pay date`,
        detail: depositAccounts.length === 0 ? "The stubs don't name a tracked deposit account." : `Not covered: ${holes.map((h) => `${h.from} – ${h.to}`).join(", ")}.`,
        fix: "Download the bank statements covering those dates.",
        // Pay is unprovable from the first uncovered date, not before it.
        scope: holes.length ? { ...scope, from: holes.map((h) => h.from).sort()[0]! } : scope,
      });
    } else if (received === expected) c.pass("pay.deposits-tie", { subject: `${who}: year-to-date net pay ${money(expected)} = what the bank received`, ...scope });
    else if (received < expected)
      c.add({
        id: `pay.deposits-tie:${groupRef}`,
        check: "pay.deposits-tie",
        status: "MISSING",
        title: `${who}: ${money(expected - received)} of net pay never reached a tracked account`,
        detail: `The ${last.payDate} stub says ${money(netYtd(last))} net so far${carriedIn ? ` (${money(carriedIn)} of it before the first stub on file)` : ""}${lostNet ? ` (${money(lostNet)} to accounts with no statements)` : ""}; tracked bank accounts received ${money(received)} from ${last.employer}. The rest was deposited to an account that isn't on file (or its deposits aren't recognized as this employer's).`,
        fix: "Add statements for the account those paychecks went to, or the missing pay stubs that name it.",
        scope,
      });
    else
      c.add({
        id: `pay.deposits-tie:${groupRef}`,
        check: "pay.deposits-tie",
        status: "FAIL",
        title: `${who}: the bank received more from ${last.employer} than the stubs paid`,
        detail: `The ${last.payDate} stub says ${money(netYtd(last))} net so far; the bank received ${money(received)} (difference ${money(received - expected)}).`,
        fix: "A deposit from this employer that isn't pay (an expense reimbursement?) or a misread stub. Compare the stubs with the deposits on Transactions.",
        scope,
      });
  }

  // Years with no stubs at all between years an employer's stubs cover: the person was
  // still employed, so that year's pay is missing, not zero.
  const yearsOf = new Map<string, Set<number>>();
  for (const s of book.stubs) {
    const k = `${s.personId ?? UNKNOWN_PERSON}|${s.employerKey}`;
    yearsOf.set(k, (yearsOf.get(k) ?? new Set()).add(Number(s.payDate.slice(0, 4))));
  }
  for (const [k, ys] of yearsOf) {
    const [personId, employerKey] = k.split("|") as [string, string];
    const employer = book.stubs.find((s) => s.employerKey === employerKey)!.employer;
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    let gaps = 0;
    for (let y = lo + 1; y < hi; y++) {
      if (ys.has(y)) continue;
      gaps++;
      c.add({
        id: `pay.year-gap:${personRef(book, personId === UNKNOWN_PERSON ? null : personId)}|${employerKey}:${y}`,
        check: "pay.year-gap",
        status: "MISSING",
        title: `${personName(personId)} · ${employer}: no ${y} pay stubs`,
        detail: `Stubs are on file for ${lo} and ${hi}, but none for ${y} — the year's pay is unknown, not zero.`,
        fix: `Download the ${employer} pay stubs for ${y} (the year's last one carries the whole year's totals).`,
        scope: { personId: personId === UNKNOWN_PERSON ? undefined : personId, employerKey, from: `${y}-01-01`, to: `${y}-12-31`, affects: ["PAY", "TAX"] },
      });
    }
    if (gaps === 0)
      c.pass("pay.year-gap", { subject: `${personName(personId)} · ${employer}: stubs every year ${lo} – ${hi}`, personId: personId === UNKNOWN_PERSON ? undefined : personId, employerKey, from: `${lo}-01-01`, to: `${hi}-12-31`, affects: ["PAY", "TAX"] });
  }

  // Paycheck deposits no stub explains (an employer with no stubs on file at all, or
  // paychecks the chains above don't reach). Employers already reported above are
  // skipped so each gap is reported once.
  const linked = new Set(book.stubs.map((s) => s.depositTransactionId).filter(Boolean));
  const reported = new Set(c.findings.filter((f) => f.check.startsWith("pay.") && f.scope.employerKey).map((f) => `${f.scope.employerKey}|${f.scope.from.slice(0, 4)}`));
  const orphans = new Map<string, typeof book.rows>();
  for (const r of book.rows) {
    if (r.lane !== "INCOME" || r.category !== "Paycheck" || r.amountCents <= 0 || linked.has(r.id) || inferredIds.has(r.id)) continue;
    const employerKey = r.merchantKey ? employerKeys.get(r.merchantKey) : undefined;
    if (employerKey && reported.has(`${employerKey}|${r.date.slice(0, 4)}`)) continue;
    const k = `${r.merchantKey ?? r.payee}|${r.date.slice(0, 4)}`;
    orphans.set(k, [...(orphans.get(k) ?? []), r]);
  }
  for (const r of book.rows) {
    if (r.lane !== "INCOME" || r.category !== "Paycheck" || !(linked.has(r.id) || inferredIds.has(r.id))) continue;
    c.pass("pay.unexplained-deposits", {
      subject: `${r.payee} ${r.date} ${money(r.amountCents)} ${linked.has(r.id) ? "has its stub" : "is explained by the stubs around it"}`,
      accountId: r.accountId,
      ...depositOwner.get(r.id),
      from: r.date,
      to: r.date,
      affects: ["PAY", "TAX"],
    });
  }
  for (const [k, rows] of orphans) {
    const year = k.split("|").at(-1)!;
    c.add({
      id: `pay.unexplained-deposits:${k}`,
      check: "pay.unexplained-deposits",
      status: "MISSING",
      title: `${rows.length} paycheck deposit(s) from "${rows[0]!.payee}" in ${year} have no pay stub`,
      detail: `${rows.map((r) => `${r.date} ${money(r.amountCents)}`).join(", ")}. Without the stubs, the gross pay, taxes and deductions behind them are unknown.`,
      fix: "Download the pay stubs for these paychecks (or, if a deposit isn't pay, recategorize it on Transactions).",
      scope: { from: `${year}-01-01`, to: `${year}-12-31`, affects: ["PAY", "TAX"] },
    });
  }
}
