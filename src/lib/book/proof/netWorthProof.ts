import { addDays, dayNumber, fromDayNumber, type Granularity } from "../../dates/isoDate.ts";
import { formatUsdFromCents } from "../../formatMoney.ts";
import type { LedgerAccount } from "../../ledger/loadLedger.ts";
import { valueAt, type Segment } from "../../ledger/timeline.ts";
import type { Book } from "../load.ts";
import { buildCashFlowReport } from "../reports/cashFlow.ts";
import { buildNetWorth } from "../reports/netWorth.ts";
import type { CheckId } from "../types.ts";
import { checksFor, estimatesFor, isIsoDate, sumCheck } from "./common.ts";
import type { ChainLine, Proof, ProofBlock, ProofEstimate, ProofGroup, ProofKind, ProofLink, ProofRow } from "./types.ts";

/**
 * The proof behind a net-worth figure. Two recipes:
 *
 *  - balance: what the household (or some accounts) held at the end of one day. Each
 *    account's balance is read off the statement period (timeline segment) holding that
 *    day: its opening, the rows booked up to the day, and for an investment statement the
 *    day's share of market change and fees. Derived stretches (a summary less the
 *    statements around it), interpolated gaps and proven idle card cycles ($0) are
 *    listed as estimates. The figure comes from the same valueAt the report uses; the
 *    parts are re-added on their own and compared.
 *  - change: how the balance moved over whole report periods: opening + income − spending
 *    + outside money + retirement contributions + market change … = closing, summed over
 *    the same periods buildNetWorth reports, so it can't drift from the page. Each part
 *    links to its own proof.
 */

export type NetWorthDescriptor =
  | {
      report: "net-worth";
      metric: "balance";
      /** End of this day. */
      date: string;
      /** Only these accounts (the household when omitted). */
      accountIds?: string[];
      /** Only accounts holding money (assets) or owing it (debts) that day. */
      side?: "assets" | "debts";
    }
  | {
      report: "net-worth";
      metric: "change";
      granularity: Granularity;
      /** First day of the first period and last day of the last (inclusive). */
      start: string;
      end: string;
      accountIds?: string[];
    };

type BalanceDescriptor = Extract<NetWorthDescriptor, { metric: "balance" }>;
type ChangeDescriptor = Extract<NetWorthDescriptor, { metric: "change" }>;

/** The checks that can withhold a net-worth figure, in the order the drawer lists them. */
export const NET_WORTH_CHECKS: CheckId[] = [
  "statement.held",
  "statement.chain",
  "statement.gap",
  "statement.history",
  "statement.overdue",
  "transfer.unmatched",
  "transfer.decisions",
  "ledger.consistency",
  "ledger.freshness",
  "networth.reconciles",
];

export function parseNetWorthDescriptor(d: Record<string, unknown>): NetWorthDescriptor | { error: string } {
  if (d.accountIds != null && (!Array.isArray(d.accountIds) || d.accountIds.some((x) => typeof x !== "string"))) return { error: "accountIds must be a list of ids." };
  const accounts = (d.accountIds as string[] | undefined)?.length ? { accountIds: d.accountIds as string[] } : {};
  if (d.metric === "balance") {
    if (!isIsoDate(d.date)) return { error: "date must be YYYY-MM-DD." };
    if (d.side != null && d.side !== "assets" && d.side !== "debts") return { error: "side must be assets or debts." };
    return {
      report: "net-worth",
      metric: "balance",
      date: d.date,
      ...accounts,
      ...(d.side ? { side: d.side as "assets" | "debts" } : {}),
    };
  }
  if (d.metric === "change") {
    if (!["month", "quarter", "year"].includes(d.granularity as string)) return { error: "granularity must be month, quarter or year." };
    if (!isIsoDate(d.start) || !isIsoDate(d.end)) return { error: "start and end must be YYYY-MM-DD." };
    if (d.start > d.end) return { error: "start is after end." };
    return {
      report: "net-worth",
      metric: "change",
      granularity: d.granularity as Granularity,
      start: d.start,
      end: d.end,
      ...accounts,
    };
  }
  return { error: "metric must be balance or change." };
}

// ---------------------------------------------------------------------------
// Balance at a date

/** One account's balance at a day, as the timeline values it, and the parts that make it. */
type AccountBalance = {
  account: LedgerAccount;
  cents: number;
  /** The parts re-added on their own, rounded once. */
  partsCents: number;
  group: ProofGroup | null;
  estimate: ProofEstimate | null;
};

const QUALITY_WORDS = {
  ESTIMATED: "inside an investment statement: its market change, fees and undated flows are spread evenly over the statement's days",
  DERIVED: "in a stretch no statement covers, derived from a year-end summary less the statements around it",
  INTERPOLATED: "in a gap between statements: interpolated between the last balance before it and the next statement's opening",
  STALE: "after its last statement: the last balance carried forward",
  UNKNOWN: "before its first statement",
} as const;

function accountBalance(book: Book, a: LedgerAccount, date: string): AccountBalance {
  const t = a.timeline;
  const v = valueAt(t, date);
  const day = dayNumber(date);
  const segs = t.segments;
  const statementOf = (s: Segment): ProofGroup["statement"] => {
    const st = s.importId ? book.statements.find((x) => x.id === s.importId) : undefined;
    const from = fromDayNumber(s.start);
    const to = fromDayNumber(s.end);
    return {
      id: s.importId ? `${s.importId}@${from}` : `idle:${a.id}:${from}`,
      account: a.name,
      institution: a.institution,
      periodStart: from,
      periodEnd: to,
      documentTitle: s.idle
        ? "No statement: a cycle without activity, counted as $0"
        : s.derived
          ? `${st?.documentTitle ?? "Summary"} (this stretch derived from it)`
          : (st?.documentTitle ?? ""),
      status: s.idle ? "IDLE" : s.derived ? "DERIVED" : (st?.status ?? "COMMITTED"),
      ...(st ? { importId: st.id } : {}),
    };
  };
  /** A line that isn't a ledger row: a balance, or a statement's market change / fees (its day's share when `share` < 1). */
  const line = (id: string, iso: string, payee: string, category: string, cents: number, share = 1): ProofRow => ({
    id,
    date: iso,
    bookedOn: iso,
    payee,
    category,
    account: a.name,
    amountCents: cents,
    countedCents: cents * share,
    share,
    precision: share === 1 ? "EXACT" : "PERIOD",
  });
  const estimate =
    v.quality === "EXACT"
      ? null
      : {
          id: `nw:${a.id}:${date}:${v.quality}`,
          title: `${a.name}: ${formatUsdFromCents(v.cents)} on ${date}`,
          detail: `Valued ${QUALITY_WORDS[v.quality]}.`,
        };

  const inSeg = segs.find((s) => s.start <= day && day <= s.end);
  if (inSeg) {
    const s = inSeg;
    const done = day >= s.end;
    const frac = done ? 1 : (day - s.start + 1) / s.days;
    const segStart = fromDayNumber(s.start);
    const rows: ProofRow[] = [line(`open:${a.id}:${segStart}`, segStart, s.idle ? "Balance carried in" : "Opening balance", "Balance", s.opening)];
    // Re-added in the order valueInSegment adds (timeline.ts), so the rounding matches.
    let sum = s.opening;
    s.exact.forEach((f, i) => {
      if (f.day > day) return;
      sum += f.amount;
      const r = f.id ? book.rowById.get(f.id) : undefined;
      const on = fromDayNumber(f.day);
      rows.push({
        id: `${f.id ?? "flow"}:${i}`,
        date: r?.date ?? on,
        bookedOn: on,
        payee: r?.payee ?? (s.idle ? "Paid off from the bank" : "—"),
        category: r?.category ?? f.lane,
        account: a.name,
        amountCents: r?.amountCents ?? f.amount,
        countedCents: f.amount,
        share: 1,
        precision: "EXACT",
        ...(r?.partOf || (r && r.amountCents !== f.amount && f.lane === "TRANSFER") ? { piece: true } : {}),
        ...(r ? { rowId: r.id } : {}),
      });
    });
    s.spread.forEach((f, i) => {
      sum += f.amount * frac;
      const r = f.id ? book.rowById.get(f.id) : undefined;
      rows.push({
        id: `${f.id ?? "spread"}:s${i}`,
        date: r?.date ?? fromDayNumber(s.end),
        bookedOn: fromDayNumber(s.end),
        payee: r?.payee ?? (s.derived ? "Derived from the summary" : "—"),
        category: r?.category ?? f.lane,
        account: a.name,
        amountCents: r?.amountCents ?? f.amount,
        countedCents: f.amount * frac,
        share: frac,
        precision: "PERIOD",
        ...(r ? { rowId: r.id } : {}),
      });
    });
    sum += (s.growth + s.fees) * frac;
    if (s.growth) rows.push(line(`growth:${a.id}:${segStart}`, fromDayNumber(s.end), "Market change", "Market change", s.growth, frac));
    if (s.fees) rows.push(line(`fees:${a.id}:${segStart}`, fromDayNumber(s.end), "Fees", "Fees", s.fees, frac));
    // On its last day a statement's balance is the printed closing; anything its lines don't explain is listed, never hidden.
    if (done && Math.round(sum) !== s.closing) {
      const rest = s.closing - sum;
      rows.push(line(`rest:${a.id}:${segStart}`, fromDayNumber(s.end), "Not itemized on the statement", "Difference", rest));
      sum += rest;
    }
    const partsCents = Math.round(sum);
    return {
      account: a,
      cents: v.cents,
      partsCents,
      group: { statement: statementOf(s), subtotalCents: partsCents, rows },
      estimate: s.idle ? null : estimate,
    };
  }
  if (segs.length === 0 || day < segs[0]!.start) {
    // Not on file yet: nothing to read it from.
    return {
      account: a,
      cents: v.cents,
      partsCents: v.cents,
      group: null,
      estimate,
    };
  }
  const last = segs.at(-1)!;
  if (day > last.end) {
    const rows = [line(`last:${a.id}`, fromDayNumber(last.end), "Closing balance, last statement on file", "Balance", last.closing)];
    return {
      account: a,
      cents: v.cents,
      partsCents: last.closing,
      group: {
        statement: statementOf(last),
        subtotalCents: last.closing,
        rows,
      },
      estimate,
    };
  }
  const prev = [...segs].reverse().find((s) => s.end < day)!;
  const rows = [line(`prev:${a.id}`, fromDayNumber(prev.end), "Closing balance, last statement before the gap", "Balance", prev.closing)];
  if (v.cents !== prev.closing) rows.push(line(`interp:${a.id}`, date, "Interpolated toward the next statement's opening", "Interpolated", v.cents - prev.closing));
  return {
    account: a,
    cents: v.cents,
    partsCents: v.cents,
    group: { statement: statementOf(prev), subtotalCents: v.cents, rows },
    estimate,
  };
}

/**
 * The accounts a balance counts: those on file by that day (as the report's periods
 * count them: an account whose first statement starts later isn't in the books yet).
 */
function balancesAt(book: Book, date: string, accountIds?: string[], side?: "assets" | "debts"): AccountBalance[] {
  const ids = accountIds?.length ? new Set(accountIds) : null;
  return book.ledger.accounts
    .filter((a) => (!ids || ids.has(a.id)) && a.timeline.firstDay! <= date)
    .map((a) => accountBalance(book, a, date))
    .filter((b) => !side || (side === "assets" ? b.cents > 0 : b.cents < 0));
}

export function buildBalanceProof(book: Book, d: BalanceDescriptor): Proof {
  const list = balancesAt(book, d.date, d.accountIds, d.side);
  const figureCents = list.reduce((t, b) => t + b.cents, 0);
  const partsCents = list.reduce((t, b) => t + b.partsCents, 0);
  const groups = list.flatMap((b) => (b.group ? [b.group] : []));
  const blocks: ProofBlock[] = [];
  if (list.length > 1 || (d.accountIds?.length ?? 0) > 1 || d.side || !d.accountIds?.length)
    blocks.push({
      kind: "breakdown",
      title: "By account",
      items: [...list]
        .sort((x, y) => Math.abs(y.cents) - Math.abs(x.cents))
        .map((b) => ({
          label: b.account.name,
          value: { cents: b.cents },
          ...(b.estimate ? { sub: "estimated" } : {}),
          link: {
            label: b.account.name,
            descriptor: {
              report: "net-worth",
              metric: "balance",
              date: d.date,
              accountIds: [b.account.id],
            },
          },
        })),
    });
  blocks.push({
    kind: "rows",
    title: "How it adds up",
    figureCents,
    groups: [...groups].sort((x, y) => Math.abs(y.subtotalCents) - Math.abs(x.subtotalCents)),
    note: "Each account's balance on the day, read off the statement period holding it: the opening balance, every row booked up to that day, and for an investment statement the day's share of its market change and fees.",
  });

  const accountIds = d.accountIds?.length || d.side ? list.map((b) => b.account.id) : undefined;
  const { checks, withheld } = checksFor(book, { affects: "NET_WORTH", from: d.date, to: d.date, accountIds }, NET_WORTH_CHECKS);
  const rowIds = new Set(groups.flatMap((g) => g.rows.map((r) => r.id.slice(0, r.id.lastIndexOf(":")))));
  const estimates = [...list.flatMap((b) => (b.estimate ? [b.estimate] : [])), ...estimatesFor(book, { rowIds, from: d.date, to: d.date, accountIds })];
  const rowCount = groups.reduce((t, g) => t + g.rows.length, 0);
  const who = d.accountIds?.length ? d.accountIds.map((id) => book.ledger.accounts.find((a) => a.id === id)?.name ?? "an account").join(", ") : "Net worth";
  return {
    report: "net-worth",
    descriptor: d,
    describes: `${d.side === "assets" ? "Assets" : d.side === "debts" ? "Debts" : who}${d.side && d.accountIds?.length ? ` (${who})` : ""}, end of ${d.date}`,
    figure: { cents: figureCents },
    selfCheck: sumCheck(
      figureCents,
      partsCents,
      `The ${groups.length} statement period${groups.length === 1 ? "" : "s"} below (${rowCount} line${rowCount === 1 ? "" : "s"}) add up to ${formatUsdFromCents(partsCents)}`,
    ),
    withheld,
    blocks,
    checks,
    estimates,
    through: book.horizon.netWorth,
    today: book.today,
  };
}

// ---------------------------------------------------------------------------
// Change over periods

type Parts = {
  opening: number;
  closing: number;
  newlyTracked: number;
  income: number;
  spending: number;
  external: number;
  employee: number;
  employer: number;
  /** Money in/out of one account, transfers between own accounts included (accounts only). */
  contributions: number;
  transfer: number;
  growth: number;
  fees: number;
  unexplained: number;
};

const zero = (): Parts => ({
  opening: 0,
  closing: 0,
  newlyTracked: 0,
  income: 0,
  spending: 0,
  external: 0,
  employee: 0,
  employer: 0,
  contributions: 0,
  transfer: 0,
  growth: 0,
  fees: 0,
  unexplained: 0,
});

export function buildChangeProof(book: Book, d: ChangeDescriptor): Proof {
  const report = buildNetWorth(book, {
    granularity: d.granularity,
    from: d.start,
    to: d.end,
  });
  const periods = report.periods.filter((p) => p.start >= d.start && p.end <= d.end);
  const ids = d.accountIds?.length ? new Set(d.accountIds) : null;
  const name = (id: string) => report.accounts.find((a) => a.id === id)?.name ?? "An account";

  // The page's own per-period figures, summed: the household's, or the chosen accounts'.
  const total = zero();
  const byAccount = new Map<string, Parts>();
  periods.forEach((p, i) => {
    for (const a of p.byAccount) {
      const x = byAccount.get(a.accountId) ?? zero();
      if (!byAccount.has(a.accountId)) x.opening = i === 0 ? a.openingCents : 0;
      x.closing = a.closingCents;
      x.newlyTracked += a.newlyTrackedCents;
      x.contributions += a.contributionsCents;
      x.growth += a.growthNetOfFeesCents;
      x.fees += a.feesCents;
      x.unexplained += a.unexplainedCents;
      byAccount.set(a.accountId, x);
    }
    // An account left out of a later period (nothing in it) closed the window at $0.
    for (const [id, x] of byAccount) if (!p.byAccount.some((a) => a.accountId === id)) x.closing = 0;
    if (ids) return;
    const h = p.household;
    if (i === 0) total.opening = h.openingCents;
    total.closing = h.closingCents;
    total.newlyTracked += h.newlyTrackedCents;
    total.income += h.incomeCents;
    total.spending += h.spendingCents;
    total.external += h.externalCents;
    total.employee += h.retirementEmployeeCents;
    total.employer += h.retirementEmployerCents;
    total.transfer += h.transferResidualCents;
    total.growth += h.growthNetOfFeesCents;
    total.fees += h.feesCents;
    total.unexplained += h.unexplainedCents;
  });
  if (ids)
    for (const [id, x] of byAccount) {
      if (!ids.has(id)) continue;
      for (const k of Object.keys(total) as (keyof Parts)[]) total[k] += x[k];
    }

  const figureCents = total.closing - total.opening;
  const first = periods[0];
  const last = periods.at(-1);
  const balance = (date: string): ProofLink["descriptor"] => ({
    report: "net-worth",
    metric: "balance",
    date,
    ...(d.accountIds?.length ? { accountIds: d.accountIds } : {}),
  });
  const cashFlow = (metric: "income" | "spending" | "external"): ProofLink["descriptor"] => ({
    report: "cash-flow",
    metric,
    granularity: d.granularity,
    start: d.start,
    end: last?.end ?? d.end,
  });
  const estimated = periods.some((p) => (ids ? p.byAccount.filter((a) => ids.has(a.accountId)) : [p.household]).some((x) => x.quality !== "EXACT"));

  // What cash flow counts for the same days, so a line that differs says so.
  const cf =
    !ids && first
      ? buildCashFlowReport(book, {
          granularity: d.granularity,
          from: d.start,
          to: last!.end,
        }).periods.filter((p) => p.start >= d.start && p.end <= last!.end)
      : [];
  const cfSum = (f: (p: (typeof cf)[number]) => number) => cf.reduce((t, p) => t + f(p), 0);
  const cfNote = (ours: number, theirs: number, what: string) =>
    ours === theirs
      ? undefined
      : `Cash flow counts ${formatUsdFromCents(theirs)} of ${what} on these days (its proof lists the rows): it counts some rows in another month than the statement books them, rent in the month it pays for.`;

  const lines: ChainLine[] = [];
  const add = (l: ChainLine & { value: { cents: number } }) => {
    if (l.value.cents !== 0 || l.op === undefined || l.op === "=") lines.push(l);
  };
  add({
    label: `Opening, end of ${first ? addDays(first.start, -1) : d.start}`,
    value: { cents: total.opening },
    source: "proven",
    ...(first
      ? {
          link: {
            label: "the opening balance",
            descriptor: balance(addDays(first.start, -1)),
          },
        }
      : {}),
  });
  add({
    op: "+",
    label: "Balances already in accounts first on file",
    value: { cents: total.newlyTracked },
    source: "proven",
    note: "An account enters the books with what it held when its first statement on file begins.",
  });
  if (ids) {
    add({
      op: "+",
      label: "Money in and out (transfers between your accounts included)",
      value: { cents: total.contributions },
      source: "proven",
    });
  } else {
    add({
      op: "+",
      label: "Income",
      value: { cents: total.income },
      source: "proven",
      link: { label: "income", descriptor: cashFlow("income") },
      note: cf.length
        ? cfNote(
            total.income,
            cfSum((p) => p.incomeCents),
            "income",
          )
        : undefined,
    });
    add({
      op: "−",
      label: "Spending",
      value: { cents: -total.spending },
      source: "proven",
      link: { label: "spending", descriptor: cashFlow("spending") },
      note: cf.length
        ? cfNote(
            -total.spending,
            cfSum((p) => p.spendingCents),
            "spending",
          )
        : undefined,
    });
    add({
      op: "+",
      label: "Outside money (partner, untracked accounts)",
      value: { cents: total.external },
      source: "proven",
      link: { label: "outside money", descriptor: cashFlow("external") },
      note: cf.length
        ? cfNote(
            total.external,
            cfSum((p) => p.externalByCategory.reduce((t, c) => t + c.cents, 0)),
            "outside money",
          )
        : undefined,
    });
    add({
      op: "+",
      label: "Retirement contributions from pay",
      value: { cents: total.employee },
      source: "proven",
    });
    add({
      op: "+",
      label: "Employer retirement contributions",
      value: { cents: total.employer },
      source: "proven",
    });
    add({
      op: "+",
      label: "Between your own accounts, in transit",
      value: { cents: total.transfer },
      source: "proven",
      note: "Transfers between tracked accounts net to zero once both legs are on file; this is money mid-move across a period boundary.",
    });
  }
  add({
    op: "+",
    label: "Market change (net of fees)",
    value: { cents: total.growth },
    source: estimated ? "estimate" : "proven",
    note: total.fees ? `Fees ${formatUsdFromCents(total.fees)}.` : undefined,
  });
  add({
    op: "+",
    label: "Not explained by statements",
    value: { cents: total.unexplained },
    source: "estimate",
    note: "Change no statement explains: coverage is missing somewhere in these days.",
  });
  add({
    op: "=",
    label: `Closing, end of ${last?.end ?? d.end}`,
    value: { cents: total.closing },
    source: estimated ? "estimate" : "proven",
    ...(last
      ? {
          link: { label: "the closing balance", descriptor: balance(last.end) },
        }
      : {}),
  });
  const partsCents = ids
    ? total.newlyTracked + total.contributions + total.growth + total.unexplained
    : total.newlyTracked + total.income + total.spending + total.external + total.employee + total.employer + total.transfer + total.growth + total.unexplained;

  const blocks: ProofBlock[] = [{ kind: "chain", title: "Opening + what moved = closing", lines }];
  if (periods.length > 1) {
    blocks.push({
      kind: "breakdown",
      title: `By ${d.granularity}`,
      items: periods.map((p) => ({
        label: p.label,
        ...(p.through ? { sub: `to ${p.through}` } : {}),
        value: {
          cents: ids ? periodChange(periods, p, ids) : p.household.closingCents - p.household.openingCents,
        },
        link: {
          label: p.label,
          descriptor: { ...d, start: p.start, end: p.end },
        },
      })),
    });
  }
  const accounts = [...byAccount].filter(([id]) => !ids || ids.has(id));
  if (accounts.length > 1)
    blocks.push({
      kind: "breakdown",
      title: "By account",
      items: accounts
        .map(([id, x]) => ({ id, cents: x.closing - x.opening }))
        .filter((x) => x.cents !== 0)
        .sort((x, y) => Math.abs(y.cents) - Math.abs(x.cents))
        .map((x) => ({
          label: name(x.id),
          value: { cents: x.cents },
          link: { label: name(x.id), descriptor: { ...d, accountIds: [x.id] } },
        })),
    });

  const from = first?.start ?? d.start;
  const to = last?.end ?? d.end;
  const accountIds = d.accountIds?.length ? d.accountIds : undefined;
  // A change needs the opening balance too: its checks start the day before (blockers.ts netWorthBlockers).
  const { checks, withheld } = checksFor(book, { affects: "NET_WORTH", from: addDays(from, -1), to, accountIds }, NET_WORTH_CHECKS);
  const estimates = estimatesFor(book, {
    rowIds: new Set(),
    from,
    to,
    accountIds,
  });
  const who = accountIds ? accountIds.map(name).join(", ") : "Net worth";
  const span = !first ? `${d.start} – ${d.end}` : periods.length === 1 ? first.label : `${first.label} – ${last!.label}`;
  return {
    report: "net-worth",
    descriptor: d,
    describes: `${who}: change over ${span}${last?.through ? ` (through ${last.through})` : ""}`,
    figure: { cents: figureCents },
    selfCheck: sumCheck(figureCents, partsCents, `The parts between the opening and closing balances add up to ${formatUsdFromCents(partsCents)}`),
    withheld,
    blocks,
    checks,
    estimates,
    through: book.horizon.netWorth,
    today: book.today,
  };
}

/** The chosen accounts' change over one period, an account's opening counted from the period before when it's left out of this one. */
function periodChange(periods: ReturnType<typeof buildNetWorth>["periods"], p: (typeof periods)[number], ids: Set<string>): number {
  const i = periods.indexOf(p);
  const prev = i > 0 ? periods[i - 1]! : null;
  let cents = 0;
  for (const id of ids) {
    const now = p.byAccount.find((a) => a.accountId === id);
    const before = prev?.byAccount.find((a) => a.accountId === id);
    const opening = now ? now.openingCents : (before?.closingCents ?? 0);
    cents += (now?.closingCents ?? 0) - opening;
  }
  return cents;
}

export function buildNetWorthProof(book: Book, d: NetWorthDescriptor): Proof {
  return d.metric === "balance" ? buildBalanceProof(book, d) : buildChangeProof(book, d);
}

export const netWorthKind: ProofKind<NetWorthDescriptor> = {
  report: "net-worth",
  parse: parseNetWorthDescriptor,
  build: ({ book }, d) => buildNetWorthProof(book, d),
};
