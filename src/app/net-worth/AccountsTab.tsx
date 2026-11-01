"use client";

import { QualityBadge } from "@/components/ledger/LedgerBits";
import { Card, NotFigure, StatementTable, type TableRow } from "@/components/ui/kit";
import type { ProofTarget } from "@/components/ui/proof/context";
import { rollTotalValue, rollValue, shownRollLines, type RollLine, type RollTotalLine } from "@/lib/profile/rollLines";
import type { BlockerRef } from "@/lib/book/reports/blockerRef";
import { formatPercentRatio, usd0 as usd } from "@/lib/formatMoney";
import type { AccountRollforward, RollforwardReport, RollYear } from "@/lib/profile/rollforwards";
import { noFigure, unswept } from "@/lib/book/proof/clearance";
import { rollforwardsDerived } from "@/lib/book/derived/netWorth";
import { derivedTarget, type DerivedFigure } from "@/lib/book/derived/types";
import { ProofValue } from "@/components/ui/proof/ProofValue";

type Cell = Extract<TableRow, { cells: unknown }>["cells"][number];
const pct = (r: number | null | undefined, digits = 1) => (r == null ? "—" : formatPercentRatio(r, digits));
const blockedCell = (blockers: BlockerRef[]): Cell => ({ text: "", proof: unswept("blocked"), blockers });
const uniq = (bs: BlockerRef[]) => [...new Map(bs.map((b) => [b.id, b])).values()];
const yearLabel = (y: number, currentYear: number) => (y === currentYear ? `${y} YTD` : String(y));
/** One roll-forward line of one account-year, opening its proof. */
const rollP = (a: AccountRollforward, x: RollYear, line: RollLine): ProofTarget => ({
  descriptor: { report: "annual", figure: "rollforward", year: x.year, accountId: a.id, line },
  shownCents: line === "return" ? null : rollValue(x, line),
});

/**
 * Each investment account, one column per year: opening → contributions → withdrawals →
 * income → market change → closing, with the year's return. A year that depends on a
 * statement not on file shows why instead of figures.
 */
export function AccountsTab({ r }: { r: RollforwardReport }) {
  const open = r.accounts.filter((a) => !a.closed);
  const closed = r.accounts.filter((a) => a.closed);
  const derived = rollforwardsDerived(r);
  return (
    <div className="flex flex-col gap-4">
      <Card
        tone="overview"
        title="Every investment account, year by year"
        subtitle={
          <>
            Every column ties: opening + contributions + deposits − withdrawals + income + market change + fees = closing. Returns are time-weighted: each month&apos;s
            Modified Dietz (money moved in or out doesn&apos;t count as performance), chained; a month with under <NotFigure why="the rule's threshold: below it a return is mostly rounding">$1,000</NotFigure> invested is left out. Dividends and interest are split out where the
            statement reports them (Fidelity); elsewhere they&apos;re inside market change.
          </>
        }
      >
        <Summary accounts={r.accounts} years={r.years} currentYear={r.currentYear} />
      </Card>
      {open.map((a) => (
        <AccountCard key={a.id} a={a} currentYear={r.currentYear} derived={derived} />
      ))}
      {closed.length > 0 && (
        <details className="rounded-lg border border-line bg-surface p-4">
          <summary className="cursor-pointer text-sm font-semibold text-fg">Closed accounts ({closed.length})</summary>
          <div className="mt-3 flex flex-col gap-4">
            {closed.map((a) => (
              <AccountCard key={a.id} a={a} currentYear={r.currentYear} derived={derived} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function Summary({ accounts, years, currentYear }: { accounts: AccountRollforward[]; years: number[]; currentYear: number }) {
  const shown = years.filter((y) => accounts.some((a) => a.years.some((x) => x.year === y)));
  const at = (a: AccountRollforward, y: number) => a.years.find((x) => x.year === y);
  const rows: TableRow[] = accounts
    .filter((a) => !a.closed || a.years.length)
    .map((a) => ({
      label: (
        <span className={a.closed ? "text-muted" : ""}>
          {a.name}
          {a.closed && " (closed)"}
        </span>
      ),
      cells: shown.map((y) => {
        const x = at(a, y);
        if (!x) return null;
        return x.blockers.length ? blockedCell(x.blockers) : { text: usd(x.closing), title: x.returnRatio != null ? `Return ${pct(x.returnRatio)}` : undefined, proof: rollP(a, x, "closing") };
      }),
    }));
  // A total over a year with any blocked account isn't provable.
  const sum = (line: RollTotalLine) =>
    shown.map((y): Cell => {
      const blockers = uniq(accounts.flatMap((a) => at(a, y)?.blockers ?? []));
      const cents = accounts.reduce((s, a) => s + (at(a, y) ? rollTotalValue(at(a, y)!, line) : 0), 0);
      return blockers.length ? blockedCell(blockers) : { text: usd(cents), proof: { descriptor: { report: "annual", figure: "rollforward-total", year: y, line }, shownCents: cents } };
    });
  rows.push({ label: "Total invested", total: true, cells: sum("closing") });
  rows.push({ label: "Contributions (you + employer)", muted: true, cells: sum("contributions") });
  rows.push({ label: "Income + market change", muted: true, cells: sum("growth") });
  return <StatementTable columns={shown.map((y) => yearLabel(y, currentYear))} rows={rows} />;
}

function AccountCard({ a, currentYear, derived }: { a: AccountRollforward; currentYear: number; derived: DerivedFigure[] }) {
  const ys = a.years;
  // The lines this card draws (shownRollLines: the list the proof sweep enumerates too).
  const shows = new Set(shownRollLines(ys));
  const cell = (x: RollYear, c: Cell): Cell => (x.blockers.length ? blockedCell(x.blockers) : c);
  const row = (label: string, line: Exclude<RollLine, "opening" | "closing" | "return">, f: (x: RollYear) => number | null, opts: Partial<Extract<TableRow, { cells: Cell[] }>> = {}): TableRow => ({
    label,
    indent: !opts.strong && !opts.total,
    ...opts,
    cells: ys.map((x) => cell(x, f(x) == null ? { text: "—", proof: noFigure("no value that year") } : { text: usd(f(x)), proof: rollP(a, x, line) })),
  });
  const rows: TableRow[] = [
    {
      label: "Opening balance",
      cells: ys.map((x) =>
        cell(x, {
          text: usd(x.opening),
          proof: rollP(a, x, "opening"),
          title: x.firstOnFile && x.opening ? "Balance already in the account when its first statement on file begins" : undefined,
          dim: x.firstOnFile && x.opening !== 0,
        }),
      ),
    },
  ];
  if (shows.has("employee")) rows.push(row("Your contributions", "employee", (x) => x.employee));
  if (shows.has("employer")) rows.push(row("Employer contributions", "employer", (x) => x.employer));
  if (shows.has("deposits")) rows.push(row("Deposits & transfers in", "deposits", (x) => x.deposits));
  if (shows.has("withdrawals")) rows.push(row("Withdrawals & transfers out", "withdrawals", (x) => x.withdrawals));
  rows.push(row("Balance after net contributions", "after-contributions", (x) => rollValue(x, "after-contributions"), { strong: true }));
  if (shows.has("income")) rows.push(row("Dividends & interest", "income", (x) => x.income));
  rows.push(row("Net change in market value", "market", (x) => x.marketChange));
  if (shows.has("fees")) rows.push(row("Fees", "fees", (x) => x.fees));
  rows.push({
    label: "Closing balance",
    total: true,
    cells: ys.map((x) =>
      cell(x, {
        text: (
          <>
            {usd(x.closing)}
            <QualityBadge quality={x.quality} />
          </>
        ),
        proof: rollP(a, x, "closing"),
      }),
    ),
  });
  rows.push({ label: "Rate of return", muted: true, cells: ys.map((x) => cell(x, { text: pct(x.returnRatio), proof: rollP(a, x, "return") })) });

  return (
    <Card
      title={a.name}
      subtitle={
        <>
          {a.group} · on file {a.firstDay} → {a.closed ? `${a.lastDay} (closed)` : a.lastDay}
          {a.cumulative != null && (
            <>
              {" · "}
              <ProofValue proof={derivedTarget("net-worth", derived, "rollforward-since", a.id)}>{pct(a.annualized ?? a.cumulative, 1)}</ProofValue>
              {a.annualized != null ? " a year since first on file" : " since first on file"}
            </>
          )}
        </>
      }
    >
      <StatementTable columns={ys.map((x) => yearLabel(x.year, currentYear))} rows={rows} minWidth="28rem" />
    </Card>
  );
}
