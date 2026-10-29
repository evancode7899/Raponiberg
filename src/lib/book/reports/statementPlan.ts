import { addBusinessDays, addDays, daysBetween, endOfMonth, maxIso, minIso, periodLabel, periodsBetween, startOfMonth } from "../../dates/isoDate.ts";
import { issuerOf, PAYMENT_GRACE_DAYS } from "../idleCards.ts";
import type { Book } from "../load.ts";
import { employerDeposits, stubGroups, UNKNOWN_PERSON } from "../pay.ts";
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
  /** When the issuer should have it posted (a week after it closes; five to nine weeks for quarterly). */
  readyBy: string;
  /** ready: should be out now; posting: closed, maybe not posted yet; open: the period hasn't ended. */
  status: "ready" | "posting" | "open";
  /** Per figure, the first day it's needed for (absent: that figure doesn't wait on it). */
  neededFrom: Partial<Record<PlanLane, string>>;
  /** Open findings it would settle (for a transfer, any of the candidate accounts' statements does). */
  settles: { id: string; title: string; anyOf: string[] }[];
  /**
   * A card whose issuer sends no statement for a cycle without activity: if none comes,
   * the bank accounts that pay it prove the cycle idle once their statements run through
   * `through` (cycle end + the payment grace period), expected by `readyBy` (or already
   * `onFile`).
   */
  ifIdle?: { banks: string[]; through: string; readyBy: string | null; onFile: boolean };
};

/** One pay stub to download: a paycheck the bank already shows, or one the pay cycle says is due. */
export type PlanStub = {
  /** The deposit's date, or the predicted pay date. */
  date: string;
  kind: "deposited" | "expected";
  /** ready: paid, so the stub should be out; open: the pay date hasn't come. */
  status: "ready" | "open";
  neededFrom: Partial<Record<PlanLane, string>>;
};

/** A person's employer whose stubs the year's pay (and so its taxes) still waits on. */
export type PlanEmployer = {
  key: string;
  person: string;
  employer: string;
  cadence: Cadence | null;
  last: { title: string; payDate: string };
  stubs: PlanStub[];
  /** Open findings the stubs settle. */
  settles: { id: string; title: string }[];
};

type Cadence = "weekly" | "biweekly" | "semimonthly" | "monthly";

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
  /** Pay stubs to download, per person and employer: taxes wait on them as they do on statements. */
  stubs: PlanEmployer[];
  other: PlanOther[];
};

const BANKING = new Set(["Cash", "Credit cards"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
/**
 * Business days after closing an issuer usually has the statement posted: banks and
 * cards about a week (Chase: 5 business days); plan and brokerage quarterlies about five
 * weeks; private funds' capital-account statements wait on the fund's quarter-end
 * valuation, about nine weeks.
 */
const POSTING_BUSINESS_DAYS = (p: Pick<PlanAccount, "cadence" | "group">) => (p.cadence === "monthly" ? 5 : p.group === "Other" ? 45 : 25);

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

/** An employer's pay cycle, from its distinct pay dates (off-cycle checks don't move the median). */
function cadenceOf(dates: string[]): Cadence | null {
  if (dates.length < 2) return null;
  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i]!, d)).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)]!;
  if (median <= 9) return "weekly";
  if (median <= 17) {
    // Semimonthly pay lands mid-month and at month end; biweekly drifts through the month.
    const day = (d: string) => Number(d.slice(8));
    const fixed = dates.filter((d) => (day(d) >= 13 && day(d) <= 16) || daysBetween(d, endOfMonth(d)) <= 3).length;
    return fixed >= dates.length * 0.8 ? "semimonthly" : "biweekly";
  }
  return median >= 25 && median <= 35 ? "monthly" : null;
}

/** Pay dates after `after` through `through` on the cycle (semimonthly: the 15th and the month end, a weekend moved to the Friday before). */
function payDatesAfter(cadence: Cadence, after: string, through: string): string[] {
  const out: string[] = [];
  const weekday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
  const friday = (d: string) => (weekday(d) === 6 ? addDays(d, -1) : weekday(d) === 0 ? addDays(d, -2) : d);
  if (cadence === "semimonthly") {
    for (let m = startOfMonth(after); m <= through; m = addDays(endOfMonth(m), 1))
      for (const d of [friday(`${m.slice(0, 8)}15`), friday(endOfMonth(m))]) if (d > after && d <= through) out.push(d);
    return out;
  }
  for (let d = cadence === "monthly" ? addMonths(after, 1) : addDays(after, cadence === "weekly" ? 7 : 14); d <= through; d = cadence === "monthly" ? addMonths(d, 1) : addDays(d, cadence === "weekly" ? 7 : 14)) out.push(d);
  return out;
}

/**
 * The pay stubs taxes wait on through `through`, per person and employer, for the years
 * past the horizon: the paychecks the bank shows after the last stub (pay.after-last-stub),
 * and past the bank statements on file, the paychecks the employer's cycle says are due —
 * so the stubs to get are known before the statements that would reveal them arrive. An
 * employer the bank shows paying nothing for two cycles after its last stub is done.
 */
function stubPlan(book: Book, through: string): PlanEmployer[] {
  const firstYear = Number(addDays(book.horizon.cashFlow, 1).slice(0, 4));
  const groups = stubGroups(book);
  const linked = new Set(book.stubs.map((s) => s.depositTransactionId).filter(Boolean));
  const out: PlanEmployer[] = [];
  for (const [key, stubs] of groups) {
    const [personId, employerKey, yearStr] = key.split("|") as [string, string, string];
    const year = Number(yearStr);
    if (year < firstYear || `${year}-01-01` > through) continue;
    const last = stubs.at(-1)!;
    const yearEnd = minIso(`${year}-12-31`, through);
    // The cycle, from this year's pay dates and last year's (a new year has few).
    const prior = groups.get(`${personId}|${employerKey}|${year - 1}`) ?? [];
    const cadence = cadenceOf([...new Set([...prior, ...stubs].map((s) => s.payDate))]);
    const deposits = employerDeposits(book, employerKey);
    const paid = deposits.filter((r) => !linked.has(r.id) && r.date > addDays(last.payDate, 3) && r.date <= yearEnd).map((r) => r.date);
    // How far the banks the employer pays into are on file.
    const banks = [...new Set(deposits.map((r) => r.accountId))];
    const bankThrough = banks.length ? banks.map((id) => book.ledger.accounts.find((a) => a.id === id)?.timeline.lastDay ?? last.payDate).sort()[0]! : last.payDate;
    const step = cadence === "weekly" ? 7 : cadence === "monthly" ? 31 : 15;
    if (!paid.length && bankThrough >= addDays(last.payDate, 2 * step + 5)) continue;
    const due = cadence ? payDatesAfter(cadence, maxIso(last.payDate, addDays(bankThrough, -3)), yearEnd).filter((d) => paid.every((p) => Math.abs(daysBetween(p, d)) > 5)) : [];
    const items: PlanStub[] = [
      ...paid.map((date) => ({ date, kind: "deposited" as const, status: "ready" as const, neededFrom: { tax: date } })),
      ...due.map((date) => ({ date, kind: "expected" as const, status: date <= book.today ? ("ready" as const) : ("open" as const), neededFrom: { tax: date } })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    if (!items.length) continue;
    const person = book.persons.find((p) => p.id === personId)?.name ?? "Someone";
    out.push({
      key,
      person,
      employer: last.employer,
      cadence,
      last: { title: last.documentTitle, payDate: last.payDate },
      stubs: items,
      settles: book.integrity.findings
        .filter((f) => f.check === "pay.after-last-stub" && f.scope.employerKey === employerKey && (f.scope.personId ?? UNKNOWN_PERSON) === personId && f.scope.to.startsWith(yearStr))
        .map((f) => ({ id: f.id, title: f.title })),
    });
  }
  return out.sort((a, b) => a.stubs[0]!.date.localeCompare(b.stubs[0]!.date) || a.person.localeCompare(b.person));
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
      const readyBy = addBusinessDays(end, POSTING_BUSINESS_DAYS(p));
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

  // Pay stubs, listed apart from statements: the year's taxes wait on them too.
  const stubs = stubPlan(book, lastTarget);
  const byStub = new Set(stubs.flatMap((e) => e.settles.map((f) => f.id)));

  // Findings: the statement each one waits on, or listed apart when no statement settles it.
  const other: PlanOther[] = [];
  const nameOf = (id: string) => book.accounts.find((a) => a.id === id)?.name ?? "an account";
  for (const f of book.integrity.findings) {
    const lanes = neededFrom(book, f);
    if (!Object.keys(lanes).length || byStub.has(f.id)) continue;
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

  // A card that skips idle statements may never issue the one asked for: then its cycle is
  // proven from the bank side (idleCards.ts), once the paying banks' statements run past
  // the cycle's payment window. Say which, and when that's expected, up front.
  for (const p of [...accounts.values()]) {
    const card = book.ledger.accounts.find((a) => a.id === p.accountId);
    if (!card || !issuerOf(card)) continue;
    const fromIdle = book.idle.proven.filter((w) => w.accountId === card.id).flatMap((w) => w.payerIds);
    const fromMatches = book.matches.filter((m) => m.legs.some((l) => l.accountId === card.id)).flatMap((m) => m.legs.map((l) => l.accountId));
    const payers = [...new Set(fromIdle.length ? fromIdle : fromMatches)].filter((id) => id !== card.id && book.accounts.find((a) => a.id === id)?.group === "Cash");
    if (!payers.length) continue;
    for (const s of p.statements) {
      if (s.kind !== "next" || !Object.keys(s.neededFrom).length) continue;
      const through = addDays(s.end, PAYMENT_GRACE_DAYS);
      const onFile = payers.every((id) => (book.ledger.accounts.find((a) => a.id === id)?.timeline.lastDay ?? "") >= through);
      const ready = payers.map((id) => {
        const bank = planFor(id);
        if (!bank || bank.coveredThrough >= through) return today;
        extend(bank, through);
        return bank.statements.find((x) => x.kind === "next" && x.end >= through)?.readyBy ?? null;
      });
      s.ifIdle = { banks: payers.map(nameOf), through, readyBy: ready.includes(null) ? null : ready.sort().at(-1)!, onFile };
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
    stubs,
    other,
  };
}
