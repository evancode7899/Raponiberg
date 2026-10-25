import { usd0 } from "../../formatMoney.ts";
import type { TaxReport, TaxReportBlocked } from "../../tax/buildTaxReport.ts";
import { estimateColumns, lineValue, type EstimateKey } from "../../tax/estimateLines.ts";
import type { AccountLimitsDescriptor } from "../proof/accountLimitsProof.ts";
import type { ProofDescriptor } from "../proof/index.ts";
import type { TaxAccountsReport } from "./taxAccounts.ts";

/**
 * The money calendar: each dated thing to do, with the amount the engines already know.
 * No figure is worked out here. Room comes from Account limits, estimated tax and the W-4
 * from the Taxes page's plan, and April's balance from its Worksheet, each with the proof
 * that page uses. Each account's own deadline decides the date: the 401(k), employer match
 * and CHET close on December 31, but HSA and IRA money still counts for the year until
 * April 15. So from January to the filing date, last year's items sit beside this year's.
 */

export type CalendarKind = "save" | "tax" | "file";

export type CalendarItem = {
  id: string;
  /** The date it's due by (today for a W-4 change: it only reaches paychecks still to come). */
  date: string;
  /** The tax year it counts for. */
  year: number;
  kind: CalendarKind;
  title: string;
  detail: string;
  /** The amount to act on. A tax balance is signed: owed is positive, a refund negative. Null: nothing to show. */
  cents: number | null;
  /** An amount per paycheck (a W-4 change), not one payment. */
  perPaycheck?: boolean;
  /** The proof the page it came from uses for this figure; null where that page has none. */
  proof: ProofDescriptor | null;
  /** Where to act on it. */
  href: string;
  /** Nothing left to do: the room is filled or no payment is needed. */
  done: boolean;
};

export type CalendarYear = { year: number; tax: TaxReport | TaxReportBlocked; accounts: TaxAccountsReport };

export type MoneyCalendarReport = {
  today: string;
  /** The tax years shown, oldest first. */
  years: number[];
  /** Due today or later, by date. */
  items: CalendarItem[];
  /** What couldn't be put on the calendar, and why. */
  notes: string[];
};

/** The tax years with something still open on `today`: this year, and last year until its filing date. */
export function calendarYears(today: string, supported: number[]): number[] {
  const y = Number(today.slice(0, 4));
  return [y - 1, y].filter((x) => supported.includes(x) && today <= `${x + 1}-04-15`);
}

const STEP_ORDER: CalendarKind[] = ["tax", "save", "file"];

export function buildMoneyCalendar(today: string, years: CalendarYear[]): MoneyCalendarReport {
  const items: CalendarItem[] = [];
  const notes: string[] = [];
  for (const { year, tax, accounts } of years) {
    const yearEnd = `${year}-12-31`;
    const filing = tax.blocked ? `${year + 1}-04-15` : tax.plan.filingDate;
    const limit = (x: Omit<AccountLimitsDescriptor, "report" | "year">): ProofDescriptor => ({ report: "account-limits", year, ...x });
    const people = new Map(accounts.people.map((p) => [p.id, p]));

    for (const s of accounts.steps) {
      const p = s.personId ? people.get(s.personId) : undefined;
      const kind = s.id.split("-")[0];
      const base = { year, kind: "save" as const, title: s.title, cents: s.roomCents, href: "/tax-accounts", done: s.done };
      if (kind === "match" && p) {
        items.push({ ...base, id: `${year}-${s.id}`, date: yearEnd, detail: `Deferrals go through payroll, so only paychecks before December 31 count. ${s.benefit}`, proof: null });
      } else if (kind === "k401" && p) {
        const per = p.k401.perPaycheckToMax && p.remainingPaychecks ? ` That's ${usd0(p.k401.perPaycheckToMax)} more per paycheck over the ${p.remainingPaychecks} left.` : "";
        items.push({ ...base, id: `${year}-${s.id}`, date: yearEnd, detail: `Through payroll only, by the last paycheck of the year.${per}`, proof: limit({ account: "k401", personId: p.id, figure: "room" }) });
      } else if (kind === "hsa" && p) {
        const shared = accounts.household.hsaFamilyShared ? " Family coverage: both of you share one limit, so this room and your spouse's overlap." : "";
        items.push({
          ...base,
          id: `${year}-${s.id}`,
          date: filing,
          detail: `Through payroll by December 31 also skips Social Security and Medicare tax; a contribution of your own counts for ${year} until the filing date.${shared}`,
          proof: limit({ account: "hsa", personId: p.id, figure: "room" }),
        });
      } else if (kind === "ira" && p) {
        items.push({ ...base, id: `${year}-${s.id}`, date: filing, detail: `A contribution counts for ${year} until the filing date. ${s.caution ?? s.benefit}`, proof: limit({ account: "ira", personId: p.id, figure: "room" }) });
      } else if (kind === "chet") {
        items.push({ ...base, id: `${year}-${s.id}`, date: yearEnd, detail: `Connecticut counts deposits made by December 31 only. ${s.benefit}`, proof: limit({ account: "chet", figure: "room" }) });
      }
    }
    for (const p of accounts.people) {
      const ex = p.k401.excessDeferral;
      if (!p.k401.excess || (ex && (ex.status === "RETURNED" || ex.status === "RETURNED_LATE"))) continue;
      items.push({
        id: `${year}-excess-${p.id}`,
        date: ex?.deadline ?? filing,
        year,
        kind: "save",
        title: `${p.name}: have the 401(k) plan return the excess deferral`,
        detail: "Deferred above the yearly limit across employers. Out of the plan by the deadline, it's taxed once; left in, it's taxed again when withdrawn.",
        cents: p.k401.excess,
        proof: limit({ account: "k401", personId: p.id, figure: "excess" }),
        href: "/tax-accounts",
        done: false,
      });
    }

    if (tax.blocked) {
      notes.push(`${year} taxes are waiting on documents (the Taxes page says which), so the estimated tax, W-4 and filing items for ${year} aren't shown.`);
      continue;
    }
    const plan = tax.plan;
    if (tax.isCurrentYear) {
      const per = plan.federal.perPaycheckForSafeHarbor;
      if (per && plan.remainingPaychecks > 0) {
        items.push({
          id: `${year}-w4`,
          date: today,
          year,
          kind: "tax",
          title: plan.paycheckPerson ? `${plan.paycheckPerson}: raise federal withholding (W-4)` : "Raise federal withholding (W-4)",
          detail: `Extra withholding per paycheck over the ${plan.remainingPaychecks} paychecks left covers the safe harbor without an estimated payment. It only reaches paychecks still to come, so each one that passes raises the amount.`,
          cents: per,
          perPaycheck: true,
          proof: null,
          href: "/taxes",
          done: false,
        });
      }
      for (const [state, name, shortfall] of [
        ["federal", "Federal", plan.federal.safeHarborShortfall],
        ["ct", "Connecticut", plan.ct.safeHarborShortfall],
      ] as const) {
        items.push({
          id: `${year}-q4-${state}`,
          date: plan.q4DueDate,
          year,
          kind: "tax",
          title: `${name} Q4 estimated tax`,
          detail:
            shortfall > 0
              ? `What still has to be paid in to meet the safe harbor and avoid the underpayment penalty${state === "federal" ? ", unless raising withholding covers it first" : ""}.`
              : "Projected withholding and payments already meet the safe harbor.",
          cents: shortfall,
          proof: null,
          href: "/taxes",
          done: shortfall <= 0,
        });
      }
    }
    const { cols } = estimateColumns(tax, "projected");
    const joint = cols.find((c) => c.id === "joint");
    const filed = tax.documents?.filed;
    const returns: [EstimateKey, string, boolean][] = [
      ["fed.balance", "Federal", Boolean(filed?.federal)],
      ["ct.balance", "Connecticut", Boolean(filed?.ct)],
      ["ny.balance", "New York", Boolean(filed?.ny)],
    ];
    for (const [key, name, isFiled] of returns) {
      const v = joint ? lineValue(key, joint, cols) : null;
      if (v == null || (key === "ny.balance" && !tax.ny)) continue;
      items.push({
        id: `${year}-file-${key}`,
        date: filing,
        year,
        kind: "file",
        title: `${name} ${year} return: ${v > 0 ? "pay what's owed" : v < 0 ? "refund due" : "nothing owed"}`,
        detail: isFiled
          ? `Filed: the return is in the tax documents folder.`
          : v > 0
            ? `File, or extend and pay this by the filing date. As the Worksheet projects it today.`
            : `As the Worksheet projects it today.`,
        cents: v,
        proof: { report: "tax-estimate", year, basis: "projected", key },
        href: "/taxes",
        done: isFiled,
      });
    }
  }
  const upcoming = items.filter((i) => i.date >= today);
  upcoming.sort((a, b) => a.date.localeCompare(b.date) || a.year - b.year || STEP_ORDER.indexOf(a.kind) - STEP_ORDER.indexOf(b.kind));
  return { today, years: years.map((y) => y.year), items: upcoming, notes };
}
