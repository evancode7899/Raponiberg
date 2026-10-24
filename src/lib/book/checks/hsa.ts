import { addDays } from "../../dates/isoDate.ts";
import { contributionKind } from "../../hsa/report.ts";
import { amountsFromLines } from "../../ingest/payroll/index.ts";
import { money } from "../coverage.ts";
import { accountRef } from "../findingKeys.ts";
import type { Book } from "../load.ts";
import { accountOwner } from "../taxAdvantaged.ts";
import type { Collector } from "./collector.ts";

/** Payroll posts a paycheck's HSA money a few days after payday: a statement may hold the last one before it and miss its own. */
const LAG_DAYS = 21;

/**
 * HSA money taken from pay (yours and your employer's, on the stubs) must arrive in the HSA:
 * each statement period's payroll deposits equal a consecutive run of paychecks that starts
 * and ends within three weeks of the period's edges, as retirement.contributions does for
 * 401(k)s. Compared only where the stubs reach past the period, so a period before the
 * first stub with HSA money (or after the last) isn't judged on stubs that aren't on file.
 */
export function checkHsaContributions(book: Book, c: Collector) {
  const hsas = book.ledger.accounts.filter((a) => a.group === "Health savings");
  for (const account of hsas) {
    // Whose pay funds it: the account's owner, or the household's one HSA payer.
    const owner = accountOwner(book, account.id);
    const payers = new Set(book.stubs.filter((s) => { const a = amountsFromLines(s.lines, "current"); return a.hsa + a.employerHsa > 0; }).map((s) => s.personId));
    const personId = owner ?? (payers.size === 1 ? [...payers][0] : undefined);
    if (!personId) continue;
    const amounts = book.stubs
      .filter((s) => s.personId === personId)
      .map((s) => {
        const a = amountsFromLines(s.lines, "current");
        return { date: s.payDate, v: a.hsa + a.employerHsa };
      })
      .filter((x) => x.v !== 0)
      .sort((x, y) => x.date.localeCompare(y.date));
    if (!amounts.length) continue;
    const { ref, accounts } = accountRef(book, account.id);
    const statements = book.statements.filter((s) => s.accountId === account.id && s.status === "COMMITTED" && !s.isSummary).sort((a, b) => a.periodStart.localeCompare(b.periodStart));
    for (const st of statements) {
      if (amounts[0]!.date > addDays(st.periodStart, -LAG_DAYS) || amounts.at(-1)!.date < st.periodEnd) continue;
      const deposits = book.rows.filter((r) => r.accountId === account.id && r.date >= st.periodStart && r.date <= st.periodEnd && r.amountCents > 0 && contributionKind(r) != null);
      const onStatement = deposits.reduce((t, r) => t + r.amountCents, 0);
      const near = (edge: string) => amounts.map((a, i) => ({ ...a, i })).filter((a) => a.date >= addDays(edge, -LAG_DAYS) && a.date <= addDays(edge, LAG_DAYS));
      const inPeriod = amounts.filter((a) => a.date >= st.periodStart && a.date <= st.periodEnd);
      let ok = onStatement === 0 && inPeriod.length === 0;
      for (const s of near(st.periodStart))
        for (const e of near(st.periodEnd)) {
          if (ok || e.i < s.i - 1) continue;
          let sum = 0;
          for (let k = s.i; k <= e.i; k++) sum += amounts[k]!.v;
          if (sum === onStatement) ok = true;
        }
      const scope = { accountId: account.id, personId, from: st.periodStart, to: st.periodEnd, affects: ["PAY" as const, "TAX" as const] };
      const subject = `${account.name} ${st.periodStart} – ${st.periodEnd}: payroll HSA money`;
      if (ok) {
        c.pass("contributions.hsa", { subject: `${subject} ties to the stubs`, ...scope });
        continue;
      }
      c.add({
        id: `contributions.hsa:${ref}:${st.periodStart}:${st.periodEnd}`,
        accounts,
        check: "contributions.hsa",
        status: "FAIL",
        title: `${subject}: ${money(onStatement)} arrived, the stubs took ${money(inPeriod.reduce((t, a) => t + a.v, 0))}`,
        detail: `No run of paychecks around the period (allowing ${LAG_DAYS} days for payroll to post) adds up to the ${money(onStatement)} the HSA statement shows from payroll.`,
        fix: "Compare the HSA statement's contributions with the HSA lines on the pay stubs around it. Employer money paid outside payroll (a yearly lump) or a contribution you made yourself belongs in an exception with a note.",
        scope,
      });
    }
  }
}
