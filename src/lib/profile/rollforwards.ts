import { netWorthBlockers } from "../book/blockers.ts";
import { accountIdForNumber, investmentIncomeByAccount } from "../book/investments.ts";
import { household } from "../book/householdView.ts";
import type { Book } from "../book/load.ts";
import { refs, type BlockerRef } from "../book/reports/blockerRef.ts";
import type { Lane } from "../classifier/taxonomy.ts";
import type { AccountGroup } from "../ledger/loadLedger.ts";
import { chainReturns, decompose, dietzParts, MIN_RETURN_CAPITAL_CENTS, type Quality } from "../ledger/timeline.ts";
import { bucketForGroup } from "./annualMath.ts";
import type { NetWorthBucket } from "./settings.ts";

/**
 * Each investment account, one calendar year at a time: opening → contributions →
 * withdrawals → income → market change → closing, with the year's Modified Dietz return.
 * A year that depends on a statement not on file carries its blockers instead of figures.
 * Shown on Net worth › Account roll-forwards.
 */

export type RollYear = {
  year: number;
  blockers: BlockerRef[];
  opening: number;
  /** The account's first statement on file starts this year with this balance already in it. */
  firstOnFile: boolean;
  employee: number;
  employer: number;
  deposits: number;
  withdrawals: number;
  /** Dividends, interest and fund distributions, where the statement reports them. */
  income: number | null;
  marketChange: number;
  fees: number;
  closing: number;
  returnRatio: number | null;
  /** The Modified Dietz parts behind returnRatio: gain ÷ time-weighted capital. */
  dietz: { gainCents: number; capitalCents: number };
  /** Change no statement explains (coverage missing inside the year); 0 when every day is covered. */
  unexplained: number;
  quality: Quality;
};

export type AccountRollforward = {
  id: string;
  name: string;
  institution: string | null;
  group: AccountGroup;
  bucket: NetWorthBucket;
  closed: boolean;
  firstDay: string;
  lastDay: string;
  /** Years with blockers carry no figures (see RollYear.blockers). */
  years: RollYear[];
  cumulative: number | null;
  annualized: number | null;
};

export type RollforwardReport = { currentYear: number; years: number[]; accounts: AccountRollforward[] };

const minIso = (a: string, b: string) => (a < b ? a : b);

export function buildAccountRollforwards(book: Book): RollforwardReport {
  const currentYear = Number(book.today.slice(0, 4));
  const firstYear = Math.min(book.ledger.firstDay ? Number(book.ledger.firstDay.slice(0, 4)) : currentYear, currentYear);
  const years: number[] = [];
  for (let y = firstYear; y <= currentYear; y++) years.push(y);

  const incomeByAccountYear = new Map<string, Map<number, number>>();
  for (const year of years) {
    for (const v of investmentIncomeByAccount(book, year).values()) {
      const id = accountIdForNumber(book, v.accountNumber);
      if (!id) continue;
      const m = incomeByAccountYear.get(id) ?? new Map<number, number>();
      m.set(year, v.cents);
      incomeByAccountYear.set(id, m);
    }
  }
  const accounts: AccountRollforward[] = household(book).ledger.accounts
    .filter((a) => a.isInvestment)
    .map((a) => {
      const t = a.timeline;
      const ys: RollYear[] = [];
      const rets: { r: number; days: number }[] = [];
      for (const year of years) {
        const from = `${year}-01-01`;
        const to = minIso(`${year}-12-31`, book.horizon.netWorth);
        if (t.firstDay! > to || (a.closed && t.lastDay! < from) || from > to) continue;
        const blockers = refs(netWorthBlockers(book, from, to, [a.id]));
        const d = decompose(t, from, to);
        const lane = (l: Lane) => d.flowsByLane[l] ?? 0;
        const inflow = (l: Lane) => d.inflowsByLane[l] ?? 0;
        const otherLanes: Lane[] = ["TRANSFER", "EXTERNAL_TRANSFER", "INCOME", "EXPENSE"];
        const inc = incomeByAccountYear.get(a.id)?.get(year) ?? null;
        const parts = dietzParts(t, from, to);
        const ret = parts.capitalCents >= MIN_RETURN_CAPITAL_CENTS ? parts.gainCents / parts.capitalCents : null;
        if (ret != null && blockers.length === 0) {
          const lo = t.firstDay! > from ? t.firstDay! : from;
          const hi = a.closed && t.lastDay! < to ? t.lastDay! : to;
          rets.push({ r: ret, days: Math.max(1, (Date.parse(hi) - Date.parse(lo)) / 86_400_000 + 1) });
        }
        ys.push({
          year,
          blockers,
          opening: d.openingCents,
          firstOnFile: t.firstDay! >= from,
          employee: lane("CONTRIBUTION_EMPLOYEE") + lane("CONTRIBUTION_PERSONAL"),
          employer: lane("CONTRIBUTION_EMPLOYER"),
          deposits: otherLanes.reduce((s, l) => s + inflow(l), 0),
          withdrawals: otherLanes.reduce((s, l) => s + lane(l) - inflow(l), 0),
          income: inc,
          marketChange: d.growthCents - (inc ?? 0),
          fees: d.feesCents,
          closing: d.closingCents,
          returnRatio: ret,
          dietz: parts,
          unexplained: d.unexplainedCents,
          quality: d.quality,
        });
      }
      // A return chained across a blocked year isn't provable.
      const chained = rets.length && ys.every((y) => y.blockers.length === 0) ? chainReturns(rets) : null;
      return {
        id: a.id,
        name: a.name,
        institution: a.institution,
        group: a.group,
        bucket: bucketForGroup(a.group),
        closed: a.closed,
        firstDay: t.firstDay!,
        lastDay: t.lastDay!,
        years: ys,
        cumulative: chained?.total ?? null,
        annualized: chained?.annualized ?? null,
      };
    })
    .sort((a, b) => Number(a.closed) - Number(b.closed) || (b.years.at(-1)?.closing ?? 0) - (a.years.at(-1)?.closing ?? 0));

  return { currentYear, years, accounts };
}
