import { addDays } from "../../dates/isoDate.ts";
import { formatUsdFromCents } from "../../formatMoney.ts";
import type { Book } from "../load.ts";
import { buildNetWorth, netWorthSpanQuality } from "../reports/netWorth.ts";
import { checksFor, isIsoDate, sumCheck } from "./common.ts";
import { MONTHS_SPLIT_NOTE, NET_WORTH_CHECKS, type NetWorthDescriptor } from "./netWorthProof.ts";
import type { ChainLine, Proof, ProofBlock, ProofKind } from "./types.ts";

/**
 * The Dashboard's own arithmetic: where the last months of net-worth change came from.
 * Both figures are parts of the net-worth change over the same month periods
 * (buildNetWorth), summed the way the Dashboard sums them:
 *
 *  - saving: income − spending + outside money + retirement contributions (yours and the
 *    employer's) + balances already in accounts first on file.
 *  - markets: market change net of fees, by account.
 *
 * Each part links to the net-worth change proof it is a line of.
 */
export type DashboardDescriptor = {
  report: "dashboard";
  figure: "saving" | "markets";
  /** First day of the first month and last day of the last (the last may be cut short at the data edge). */
  start: string;
  end: string;
};

export function parseDashboardDescriptor(d: Record<string, unknown>): DashboardDescriptor | { error: string } {
  if (d.figure !== "saving" && d.figure !== "markets") return { error: "figure must be saving or markets." };
  if (!isIsoDate(d.start) || !isIsoDate(d.end)) return { error: "start and end must be YYYY-MM-DD." };
  if (d.start > d.end) return { error: "start is after end." };
  return { report: "dashboard", figure: d.figure, start: d.start, end: d.end };
}

export function buildDashboardProof(book: Book, d: DashboardDescriptor): Proof {
  const report = buildNetWorth(book, { granularity: "month", from: d.start, to: d.end });
  const periods = report.periods.filter((p) => p.start >= d.start && p.end <= d.end);
  const sum = (f: (h: (typeof periods)[number]["household"]) => number) => periods.reduce((t, p) => t + f(p.household), 0);
  const change = (accountIds?: string[]): NetWorthDescriptor => ({
    report: "net-worth",
    metric: "change",
    granularity: "month",
    start: d.start,
    end: d.end,
    ...(accountIds ? { accountIds } : {}),
  });
  const ofChange = { label: "the net-worth change over these months", descriptor: change() };
  // Judged over the whole span, each account on its own: month-ends inside a statement
  // period make the monthly split an estimate, not the span's total.
  const quality = netWorthSpanQuality(book, periods[0]?.start ?? d.start, periods.at(-1)?.end ?? d.end);
  const isEstimate = (id: string) => (quality.byAccount.get(id) ?? "EXACT") !== "EXACT";
  let estimated = false;
  const span = periods.length ? `${periods[0]!.label} – ${periods.at(-1)!.label}` : `${d.start} – ${d.end}`;

  let figureCents: number;
  let partsCents: number;
  const lines: ChainLine[] = [];
  if (d.figure === "saving") {
    const parts: [ChainLine["op"], string, number, string?][] = [
      [undefined, "Income", sum((h) => h.incomeCents)],
      ["−", "Spending", sum((h) => h.spendingCents)],
      ["+", "Outside money (partner, untracked accounts)", sum((h) => h.externalCents)],
      ["+", "Retirement contributions from pay", sum((h) => h.retirementEmployeeCents)],
      ["+", "Employer retirement contributions", sum((h) => h.retirementEmployerCents)],
      ["+", "Balances already in accounts first on file", sum((h) => h.newlyTrackedCents), "An account enters the books with what it held when its first statement on file begins."],
    ];
    // Spending is negative in the household's parts; its line shows it positive after "−".
    for (const [op, label, cents, note] of parts)
      if (cents !== 0 || op === undefined)
        lines.push({ ...(op ? { op } : {}), label, value: { cents: op === "−" ? -cents : cents }, source: "proven", link: ofChange, ...(note ? { note } : {}) });
    partsCents = parts.reduce((t, p) => t + p[2], 0);
    figureCents = sum((h) => h.principalCents + h.newlyTrackedCents);
  } else {
    // By account, as each account's own net-worth change counts its market change.
    const byAccount = new Map<string, number>();
    for (const p of periods) for (const a of p.byAccount) if (a.growthNetOfFeesCents) byAccount.set(a.accountId, (byAccount.get(a.accountId) ?? 0) + a.growthNetOfFeesCents);
    const name = (id: string) => report.accounts.find((a) => a.id === id)?.name ?? "An account";
    const fees = sum((h) => h.feesCents);
    const moved = [...byAccount].filter(([, cents]) => cents !== 0);
    // The total is as good as the accounts in it.
    estimated = moved.some(([id]) => isEstimate(id));
    moved
      .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))
      .forEach(([id, cents], i) =>
        lines.push({
          ...(i ? { op: "+" as const } : {}),
          label: `${name(id)}: market change (net of fees)`,
          value: { cents },
          source: isEstimate(id) ? "estimate" : "proven",
          link: { label: name(id), descriptor: change([id]) },
        }),
      );
    partsCents = [...byAccount.values()].reduce((t, c) => t + c, 0);
    figureCents = sum((h) => h.growthNetOfFeesCents);
    if (fees) lines.push({ label: "Fees taken out of it", value: { cents: fees }, source: "proven", note: "Already in the lines above; shown for reference." });
  }
  lines.push({
    op: "=",
    label: d.figure === "saving" ? "From saving" : "From markets",
    value: { cents: figureCents },
    source: d.figure === "markets" && estimated ? "estimate" : "derived",
    link: ofChange,
  });

  const blocks: ProofBlock[] = [{ kind: "chain", title: d.figure === "saving" ? "What saving added" : "What markets added", lines }];
  if (periods.length > 1)
    blocks.push({
      kind: "breakdown",
      title: "By month",
      ...(d.figure === "markets" && periods.some((p) => p.household.quality !== "EXACT") ? { note: MONTHS_SPLIT_NOTE } : {}),
      items: periods.map((p) => ({
        label: p.label,
        ...(p.through ? { sub: `to ${p.through}` } : {}),
        value: { cents: d.figure === "saving" ? p.household.principalCents + p.household.newlyTrackedCents : p.household.growthNetOfFeesCents },
        link: { label: p.label, descriptor: { ...change(), start: p.start, end: p.end } },
      })),
    });

  const from = periods[0]?.start ?? d.start;
  const to = periods.at(-1)?.end ?? d.end;
  // As the Dashboard withholds it: the change's checks, from the day before the first month.
  const { checks, withheld } = checksFor(book, { affects: "NET_WORTH", from: addDays(from, -1), to }, NET_WORTH_CHECKS);
  const n = lines.length - 1;
  return {
    report: "dashboard",
    descriptor: d,
    describes: `${d.figure === "saving" ? "Net worth added by saving" : "Net worth added by markets"}, ${span}`,
    figure: { cents: figureCents },
    selfCheck: sumCheck(figureCents, partsCents, `The ${n} line${n === 1 ? "" : "s"} above add up to ${formatUsdFromCents(partsCents)}`),
    withheld,
    blocks,
    checks,
    estimates: [],
    through: book.horizon.netWorth,
    today: book.today,
  };
}

export const dashboardKind: ProofKind<DashboardDescriptor> = {
  report: "dashboard",
  parse: parseDashboardDescriptor,
  build: ({ book }, d) => buildDashboardProof(book, d),
};
