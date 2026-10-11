import { addDays, daysBetween, endOfMonth, maxIso, minIso, periodLabel, periodsBetween, startOfMonth } from "../../dates/isoDate.ts";
import type { Book } from "../load.ts";
import type { Finding } from "../types.ts";
import type { TimelineLane } from "./timeline.ts";

export type PlanLane = TimelineLane;

/** A statement to download: the next one in an account's cycle, or one filling a gap. */
export type PlanStatement = {
  start: string;
  end: string;
  /** "Sep 2026" (monthly, by closing month), "Q3 2026" (quarterly), or the gap's span. */
  label: string;
  /** next: the cycle after what's on file (dates predicted from the cycle); gap/history: a window that's missing. */
  kind: "next" | "gap" | "history";
  /** When the issuer should have it posted (a few days after it closes; weeks for quarterly). */
  readyBy: string;
  /** ready: should be out now; posting: closed, maybe not posted yet; open: the period hasn't ended. */
  status: "ready" | "posting" | "open";
  /** Per figure, the first day it's needed for (absent: that figure doesn't wait on it). */
  neededFrom: Partial<Record<PlanLane, string>>;
  /** Open findings it would settle (for a transfer, any of the candidate accounts' statements does). */
  settles: { id: string; title: string; anyOf: string[] }[];
};

export type PlanAccount = {
  accountId: string;
  name: string;
  group: string;
  cadence: "monthly" | "quarterly";
  /** The latest statement on file, by its document name. */
  last: { title: string; start: string; end: string } | null;
  /** Where coverage ends (past `last` when later cycles are proven idle). */
  coveredThrough: string;
  statements: PlanStatement[];
};

export type PlanInstitution = { name: string; accounts: PlanAccount[] };

/** One period to unlock: a month end past the horizon. */
export type PlanTarget = {
  end: string;
  /** "Sep 2026", with the quarter or year it completes. */
  label: string;
  quarter: string | null;
  year: string | null;
  unlocked: Record<PlanLane, boolean>;
};

/** An open finding no statement would settle (a clash, a pay stub): shown with its fix. */
export type PlanOther = { id: string; title: string; fix: string; status: Finding["status"]; neededFrom: Partial<Record<PlanLane, string>> };

export type StatementPlan = {
  today: string;
  horizon: Book["horizon"];
  /** Month ends from just past the horizon to the last whole month (or this month, when caught up). */
  targets: PlanTarget[];
  /** Institutions with statements to get, the one needed earliest first. */
  institutions: PlanInstitution[];
  /** Open accounts already on file through the last target. */
  upToDate: { name: string; institution: string; coveredThrough: string; lastTitle: string | null }[];
  other: PlanOther[];
};

const BANKING = new Set(["Cash", "Credit cards"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
/** Days after closing an issuer usually has the statement posted. */
const POSTING_DAYS = { monthly: 3, quarterly: 21 } as const;

/** `iso` moved by whole months, keeping the day (clamped), or the month end when it is one. */
function addMonths(iso: string, n: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1 + n;
  const first = `${y + Math.floor(m / 12)}-${String((((m % 12) + 12) % 12) + 1).padStart(2, "0")}-01`;
  const end = endOfMonth(first);
  if (iso === endOfMonth(iso)) return end;
  return minIso(`${first.slice(0, 8)}${iso.slice(8)}`, end);
}

/** Which figures a finding holds back, and from which day (past the edge, only after it). */
function neededFrom(book: Book, f: Finding): Partial<Record<PlanLane, string>> {
  const afterEdge = addDays(book.horizon.netWorth, 1);
  const out: Partial<Record<PlanLane, string>> = {};
  for (const s of [f.scope, ...(f.extraScopes ?? [])]) {
    const from = f.atEdge ? maxIso(s.from, afterEdge) : s.from;
    const set = (lane: PlanLane) => (out[lane] = out[lane] ? minIso(out[lane]!, from) : from);
    if (s.affects.includes("CASH_FLOW")) set("cashFlow");
    if (s.affects.includes("NET_WORTH")) set("netWorth");
    // A year's taxes run through the cash-flow horizon and need pay and tax facts too.
    if (s.affects.some((a) => a === "CASH_FLOW" || a === "PAY" || a === "TAX")) set("tax");
  }
  return out;
}

/**
 * The statements to download next, per institution and account, and which month (and
 * quarter or year) of cash flow, net worth and taxes each one unlocks. An account's next
 * statements are predicted from its cycle (closing day and length), counted from the
 * latest statement on file, until they cover the last target; statements an open
 * finding is waiting on (a transfer's other leg, a gap, missing history) are added with
 * the finding they'd settle. Lanes follow the horizons: net worth waits on every open
 * account, cash flow and taxes on the bank and card accounts plus whatever their
 * findings need (e.g. a fund statement holding a transfer from checking).
 */
export function buildStatementPlan(book: Book): StatementPlan {
  const today = book.today;
  const horizon = { ...book.horizon, tax: book.horizon.cashFlow };
  const lowest = minIso(horizon.cashFlow, horizon.netWorth);
  const lastWhole = addDays(startOfMonth(today), -1);
  const last = lowest >= lastWhole ? endOfMonth(today) : lastWhole;
  const targets: PlanTarget[] = periodsBetween(addDays(lowest, 1), last, "month").map(({ end }) => {
    const m = Number(end.slice(5, 7));
    const unlocked = (lane: PlanLane) => end <= horizon[lane];
    return {
      end,
      label: monthName(end),
      quarter: m % 3 === 0 ? periodLabel(`${end.slice(0, 5)}${String(m - 2).padStart(2, "0")}-01`, "quarter") : null,
      year: m === 12 ? end.slice(0, 4) : null,
      unlocked: { cashFlow: unlocked("cashFlow"), netWorth: unlocked("netWorth"), tax: unlocked("tax") },
    };
  });

  const accounts = new Map<string, PlanAccount>();
  const planFor = (id: string): PlanAccount | null => {
    const hit = accounts.get(id);
    if (hit) return hit;
    const la = book.ledger.accounts.find((a) => a.id === id);
    const ba = book.accounts.find((a) => a.id === id);
    if (!la || !ba || !la.timeline.lastDay) return null;
    const real = la.timeline.segments.filter((s) => !s.derived && !s.idle);
    const lengths = (real.length > 1 ? real.slice(1) : real).map((s) => s.days).sort((x, y) => x - y);
    const st = book.statements
      .filter((s) => s.accountId === id && !s.isSummary && s.status === "COMMITTED")
      .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))
      .at(-1);
    const p: PlanAccount = {
      accountId: id,
      name: ba.name,
      group: ba.group,
      cadence: (lengths[Math.floor(lengths.length / 2)] ?? 31) >= 80 ? "quarterly" : "monthly",
      last: st ? { title: st.documentTitle, start: st.periodStart, end: st.periodEnd } : null,
      coveredThrough: la.timeline.lastDay,
      statements: [],
    };
    accounts.set(id, p);
    return p;
  };
  const status = (end: string, readyBy: string): PlanStatement["status"] => (today <= end ? "open" : today < readyBy ? "posting" : "ready");
  /** The account's predicted next statements, through `through`. */
  const extend = (p: PlanAccount, through: string) => {
    const months = p.cadence === "quarterly" ? 3 : 1;
    let prev = p.statements.filter((s) => s.kind === "next").at(-1)?.end ?? p.coveredThrough;
    // Cycles anchor on the latest real statement's closing day (idle cycles keep it).
    const anchor = p.last?.end ?? p.coveredThrough;
    let k = Math.max(1, Math.round(daysBetween(anchor, prev) / (30.44 * months)) + 1);
    while (prev < through) {
      const end = addMonths(anchor, k * months);
      k++;
      if (end <= prev) continue;
      const start = addDays(prev, 1);
      const readyBy = addDays(end, POSTING_DAYS[p.cadence]);
      p.statements.push({
        start,
        end,
        label: p.cadence === "quarterly" && end === endOfMonth(end) && Number(end.slice(5, 7)) % 3 === 0 ? periodLabel(addDays(startOfMonth(end), -60), "quarter") : monthName(end),
        kind: "next",
        readyBy,
        status: status(end, readyBy),
        neededFrom: {},
        settles: [],
      });
      prev = end;
    }
  };
  const need = (s: PlanStatement, lane: PlanLane, from: string) => {
    const at = maxIso(from, s.start);
    s.neededFrom[lane] = s.neededFrom[lane] ? minIso(s.neededFrom[lane]!, at) : at;
  };

  // Coverage: every open account through the last target (net worth); banking accounts for cash flow and taxes.
  const lastTarget = targets.at(-1)?.end ?? last;
  for (const a of book.ledger.accounts) {
    if (a.closed || !a.timeline.lastDay || a.timeline.lastDay >= lastTarget) continue;
    const p = planFor(a.id)!;
    extend(p, lastTarget);
    for (const s of p.statements) {
      need(s, "netWorth", s.start);
      if (BANKING.has(p.group)) {
        need(s, "cashFlow", s.start);
        need(s, "tax", s.start);
      }
    }
  }

  // Findings: the statement each one waits on, or listed apart when no statement settles it.
  const other: PlanOther[] = [];
  const nameOf = (id: string) => book.accounts.find((a) => a.id === id)?.name ?? "an account";
  for (const f of book.integrity.findings) {
    const lanes = neededFrom(book, f);
    if (!Object.keys(lanes).length) continue;
    if (!f.needs) {
      other.push({ id: f.id, title: f.title, fix: f.fix, status: f.status, neededFrom: lanes });
      continue;
    }
    const anyOf = f.needs.accountIds.map(nameOf);
    for (const id of f.needs.accountIds) {
      const p = planFor(id);
      if (!p) continue;
      let s: PlanStatement | undefined;
      if (f.needs.from > p.coveredThrough) {
        extend(p, f.needs.to);
        s = p.statements.find((x) => x.kind === "next" && x.start <= f.needs!.to && x.end >= f.needs!.from);
      } else {
        s = p.statements.find((x) => x.kind !== "next" && x.start === f.needs!.from);
        if (!s) {
          const kind = f.check === "statement.history" ? "history" : "gap";
          const end = f.needs.to;
          s = {
            start: f.needs.from,
            end,
            label: monthName(f.needs.from) === monthName(end) ? monthName(end) : `${monthName(f.needs.from)} – ${monthName(end)}`,
            kind,
            readyBy: end,
            status: "ready",
            neededFrom: {},
            settles: [],
          };
          p.statements.push(s);
        }
      }
      if (!s) continue;
      s.settles.push({ id: f.id, title: f.title, anyOf });
      for (const [lane, from] of Object.entries(lanes) as [PlanLane, string][]) need(s, lane, from);
    }
  }

  // Keep only statements something waits on, oldest first.
  const institutions = new Map<string, PlanAccount[]>();
  const planned = new Set<string>();
  for (const p of accounts.values()) {
    p.statements = p.statements.filter((s) => Object.keys(s.neededFrom).length).sort((a, b) => a.start.localeCompare(b.start));
    if (!p.statements.length) continue;
    planned.add(p.accountId);
    const inst = book.accounts.find((a) => a.id === p.accountId)?.institution ?? "Other";
    institutions.set(inst, [...(institutions.get(inst) ?? []), p]);
  }
  const firstNeed = (p: PlanAccount) => p.statements.flatMap((s) => Object.values(s.neededFrom)).sort()[0] ?? "9999";
  const byNeed = (a: PlanAccount, b: PlanAccount) => firstNeed(a).localeCompare(firstNeed(b)) || a.name.localeCompare(b.name);

  return {
    today,
    horizon: book.horizon,
    targets,
    institutions: [...institutions]
      .map(([name, accts]) => ({ name, accounts: accts.sort(byNeed) }))
      .sort((a, b) => byNeed(a.accounts[0]!, b.accounts[0]!)),
    upToDate: book.ledger.accounts
      .filter((a) => !a.closed && a.timeline.lastDay && a.timeline.lastDay >= lastTarget && !planned.has(a.id))
      .map((a) => {
        const st = book.statements.filter((s) => s.accountId === a.id && !s.isSummary && s.status === "COMMITTED").sort((x, y) => x.periodEnd.localeCompare(y.periodEnd)).at(-1);
        return { name: a.name, institution: book.accounts.find((x) => x.id === a.id)?.institution ?? "Other", coveredThrough: a.timeline.lastDay!, lastTitle: st?.documentTitle ?? null };
      })
      .sort((a, b) => a.institution.localeCompare(b.institution) || a.name.localeCompare(b.name)),
    other,
  };
}
