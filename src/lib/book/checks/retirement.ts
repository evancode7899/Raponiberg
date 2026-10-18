import { addDays } from "../../dates/isoDate.ts";
import { amountsFromLines } from "../../ingest/payroll/index.ts";
import { QNEC_LABEL } from "../../ingest/parsers/empower.ts";
import { money } from "../coverage.ts";
import { accountRef } from "../findingKeys.ts";
import type { Book, BookStub } from "../load.ts";
import type { Collector } from "./collector.ts";

const GENERIC = new Set(["PARTNERS", "PARTNER", "MANAGEMENT", "GROUP", "ADVISORY", "SELECT", "TRINET", "HOLDINGS", "SERVICES", "OPERATIONS", "CORPORATION", "COMPANY", "PLAN", "401K"]);
const tokens = (s: string) => new Set(s.toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").split(/\s+/).filter((t) => t.length >= 4 && !GENERIC.has(t)));

/** Employer money deposited outside payroll, which no stub carries. */
const NON_PAYROLL_EMPLOYER = new RegExp(`${QNEC_LABEL}|qualified non-?elective|\\bQNEC\\b`, "i");

/**
 * 401(k) contributions on the plan's statements must equal what the pay stubs withheld
 * (employee deferrals) and paid in (employer money). Plans post a paycheck's money a few
 * days after payday, so a quarter's statement may hold the previous quarter's last
 * paycheck and miss its own: each statement period must equal the sum of a consecutive
 * run of paychecks that starts and ends within three weeks of its boundaries.
 *
 * Employer money that never runs through payroll, such as a qualified non-elective
 * contribution (QNEC), has no stub line: it is a known source, left out of the comparison
 * and reported as an inference instead.
 */
export function checkRetirement(book: Book, c: Collector) {
  const employers = [...new Set(book.stubs.map((s) => s.employerKey))];
  for (const employerKey of employers) {
    const stubs = book.stubs.filter((s) => s.employerKey === employerKey).sort((a, b) => a.payDate.localeCompare(b.payDate));
    const want = tokens(employerKey);
    const account = book.ledger.accounts.find((a) => a.subtype === "401K" && [...tokens(a.name)].some((t) => want.has(t)));
    if (!account) continue;
    const personId = stubs[0]!.personId ?? undefined;
    const { ref, accounts } = accountRef(book, account.id);
    // Chains with stubs missing are already reported (and block pay); only complete ones are compared.
    const incompleteYears = new Set(
      c.findings
        .filter((f) => f.scope.employerKey === employerKey && (f.check === "pay.continuity" || f.check === "pay.after-last-stub"))
        .map((f) => f.scope.from.slice(0, 4)),
    );
    const per = (s: BookStub) => {
      const a = amountsFromLines(s.lines, "current");
      return { employee: a.retirementPretax + a.retirementRoth, employer: a.employerRetirement };
    };
    const statements = book.statements
      .filter((s) => s.accountId === account.id && s.status === "COMMITTED" && !s.isSummary)
      .sort((a, b) => a.periodStart.localeCompare(b.periodStart));
    for (const st of statements) {
      if (incompleteYears.has(st.periodStart.slice(0, 4)) || incompleteYears.has(st.periodEnd.slice(0, 4))) continue;
      // The stub chain must reach past the period (with posting lag) to compare it.
      if (!stubs.length || stubs[0]!.payDate > addDays(st.periodStart, -21) || stubs.at(-1)!.payDate < st.periodEnd) continue;
      const rows = book.rows.filter((r) => r.accountId === account.id && r.date >= st.periodStart && r.date <= st.periodEnd);
      for (const kind of ["employee", "employer"] as const) {
        const lane = kind === "employee" ? "CONTRIBUTION_EMPLOYEE" : "CONTRIBUTION_EMPLOYER";
        const laneRows = rows.filter((r) => r.lane === lane);
        const offPayroll = kind === "employer" ? laneRows.filter((r) => NON_PAYROLL_EMPLOYER.test(r.payee)) : [];
        const onStatement = laneRows.filter((r) => !offPayroll.includes(r)).reduce((t, r) => t + r.amountCents, 0);
        if (offPayroll.length) {
          c.infer({
            id: `retirement.contributions:${ref}:${st.periodStart}:${st.periodEnd}:qnec`,
            check: "retirement.contributions",
            title: `${account.name} ${st.periodStart} – ${st.periodEnd}: ${money(offPayroll.reduce((t, r) => t + r.amountCents, 0))} qualified non-elective contribution`,
            detail: "The plan sponsor deposited this outside payroll (a corrective contribution), so no pay stub carries it. It counts as employer money but is not compared with the stubs.",
          });
        }
        const amounts = stubs.map((s) => ({ date: s.payDate, v: per(s)[kind] }));
        const starts = amounts.map((a, i) => ({ ...a, i })).filter((a) => a.date >= addDays(st.periodStart, -21) && a.date <= addDays(st.periodStart, 21));
        const ends = amounts.map((a, i) => ({ ...a, i })).filter((a) => a.date >= addDays(st.periodEnd, -21) && a.date <= addDays(st.periodEnd, 21));
        let ok = false;
        for (const s of starts) {
          for (const e of ends) {
            if (e.i < s.i - 1) continue;
            let sum = 0;
            for (let k = s.i; k <= e.i; k++) sum += amounts[k]!.v;
            if (sum === onStatement) ok = true;
          }
        }
        const stubTotal = amounts.filter((a) => a.date >= st.periodStart && a.date <= st.periodEnd).reduce((t, a) => t + a.v, 0);
        if (ok)
          c.pass("retirement.contributions", { subject: `${account.name} ${st.periodStart} – ${st.periodEnd}: ${kind} money ties to the stubs`, personId, employerKey, accountId: account.id, from: st.periodStart, to: st.periodEnd, affects: ["PAY"] });
        else
          c.add({
            id: `retirement.contributions:${ref}:${st.periodStart}:${st.periodEnd}:${kind}`,
            accounts,
            check: "retirement.contributions",
            status: "FAIL",
            title: `${account.name} ${st.periodStart} – ${st.periodEnd}: ${kind} contributions don't match the pay stubs`,
            detail: `The statement shows ${money(onStatement)} of ${kind} money; the stubs paid in that quarter withheld ${money(stubTotal)}, and no shift of a paycheck across the quarter's boundaries reconciles them.`,
            fix: "Compare the statement's contribution lines with the stubs' 401(k) lines — one of them was read wrong, or contributions went to another plan.",
            scope: { personId, employerKey, accountId: account.id, from: st.periodStart, to: st.periodEnd, affects: ["PAY"] },
          });
      }
    }
  }
}
