import { endOfMonth, periodLabel, periodsBetween, startOfMonth, type Granularity } from "../../dates/isoDate.ts";
import { blockersFor, netWorthBlockers, taxBlockers, taxYearThrough } from "../blockers.ts";
import type { Book } from "../load.ts";
import type { Finding } from "../types.ts";

export type TimelineLane = "cashFlow" | "netWorth" | "tax";

/**
 * One figure for one period. `blocked`: open findings withhold it. `pending`: the period
 * runs past the data edge — some accounts' statements don't reach its end yet, and the
 * only findings touching it are past the edge too (figures run only through the
 * proven-through date). `proven`: neither.
 */
export type TimelineCell = {
  state: "proven" | "blocked" | "pending";
  /** Ids of the open findings that withhold it (see `findings`). */
  blockers: string[];
  /** Ids of findings past the data edge that touch it: what it's waiting on, not withheld by. */
  edge: string[];
  /** Accounts whose latest statement ends before the period does. */
  awaiting: { account: string; lastDay: string }[];
};

export type TimelinePeriod = { label: string; start: string; end: string } & Record<TimelineLane, TimelineCell>;

export type TimelineFinding = Pick<Finding, "id" | "check" | "status" | "title" | "detail" | "fix" | "atEdge">;

export type BlockerTimeline = {
  from: string;
  to: string;
  horizon: Book["horizon"];
  month: TimelinePeriod[];
  quarter: TimelinePeriod[];
  year: TimelinePeriod[];
  /** Every finding a cell refers to. */
  findings: TimelineFinding[];
};

/**
 * Which cash flow, net worth and tax figures each open finding withholds, month by
 * month and rolled up to quarters and years. Uses the same blocker rules the modules
 * use, so a red cell here is a figure the matching page withholds: cash flow and net
 * worth as their reports look them up, a tax year as the tax report does (pay and
 * investment income for the year, bank accounts through the filing deadline); a month
 * or quarter of taxes covers pay, investment income and bank accounts within it.
 */
export function buildBlockerTimeline(book: Book): BlockerTimeline {
  const from = startOfMonth(book.ledger.firstDay ?? book.today);
  const to = endOfMonth(book.today);
  const used = new Map<string, TimelineFinding>();
  const ids = (fs: Finding[]) =>
    fs.map((f) => {
      used.set(f.id, { id: f.id, check: f.check, status: f.status, title: f.title, detail: f.detail, fix: f.fix, atEdge: f.atEdge });
      return f.id;
    });

  const open = book.ledger.accounts.filter((a) => !a.closed && a.timeline.lastDay);
  const awaitingFor = (end: string, horizon: string, cashOnly: boolean) =>
    end <= horizon
      ? []
      : open
          .filter((a) => (!cashOnly || a.group === "Cash" || a.group === "Credit cards") && a.timeline.lastDay! < end)
          .sort((a, b) => a.timeline.lastDay!.localeCompare(b.timeline.lastDay!))
          .map((a) => ({ account: a.name, lastDay: a.timeline.lastDay! }));
  const cell = (fs: Finding[], awaiting: TimelineCell["awaiting"]): TimelineCell => {
    const blockers = ids(fs.filter((f) => !f.atEdge));
    const edge = ids(fs.filter((f) => f.atEdge));
    return { state: blockers.length ? "blocked" : edge.length || awaiting.length ? "pending" : "proven", blockers, edge, awaiting };
  };

  const periods = (g: Granularity): TimelinePeriod[] =>
    periodsBetween(from, to, g).map(({ start, end }) => {
      const year = Number(start.slice(0, 4));
      return {
        label: periodLabel(start, g),
        start,
        end,
        cashFlow: cell(blockersFor(book, { affects: "CASH_FLOW", from: start, to: end }), awaitingFor(end, book.horizon.cashFlow, true)),
        netWorth: cell(netWorthBlockers(book, start, end), awaitingFor(end, book.horizon.netWorth, false)),
        tax: cell(g === "year" ? taxBlockers(book, year) : taxBlockers(book, year, { from: start, to: end }), awaitingFor(end, taxYearThrough(book, year), true)),
      };
    });

  const month = periods("month");
  const quarter = periods("quarter");
  const year = periods("year");
  return { from, to, horizon: book.horizon, month, quarter, year, findings: [...used.values()] };
}
