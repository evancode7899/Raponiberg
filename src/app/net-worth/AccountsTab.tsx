"use client";

import { BlockedValue } from "@/components/ledger/Blocked";
import { QualityBadge, QualityLegend } from "@/components/ledger/LedgerBits";
import { Card, StatementTable, type TableRow } from "@/components/ui/kit";
import type { BlockerRef } from "@/lib/book/reports/blockerRef";
import { formatPercentRatio, usd0 as usd } from "@/lib/formatMoney";
import type { AccountRollforward, RollforwardReport, RollYear } from "@/lib/profile/rollforwards";

type Cell = Extract<TableRow, { cells: unknown }>["cells"][number];
const pct = (r: number | null | undefined, digits = 1) => (r == null ? "—" : formatPercentRatio(r, digits));
const blockedCell = (blockers: BlockerRef[]): Cell => ({ text: <BlockedValue blockers={blockers} /> });
const uniq = (bs: BlockerRef[]) => [...new Map(bs.map((b) => [b.id, b])).values()];
const yearLabel = (y: number, currentYear: number) => (y === currentYear ? `${y} YTD` : String(y));

/**
 * Each investment account, one column per year: opening → contributions → withdrawals →
 * income → market change → closing, with the year's return. A year that depends on a
 * statement not on file shows why instead of figures.
 */
export function AccountsTab({ r }: { r: RollforwardReport }) {
  const open = r.accounts.filter((a) => !a.closed);
  const closed = r.accounts.filter((a) => a.closed);
  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Every investment account, year by year"
        subtitle={
          <div className="flex flex-col gap-1">
            <span>
              Every column ties: opening + contributions + deposits − withdrawals + income + market change + fees = closing. Returns are Modified Dietz (money
              moved in or out doesn&apos;t count as performance); a year with under $1,000 invested shows no return. Dividends and interest are split out where the
              statement reports them (Fidelity); elsewhere they&apos;re inside market change.
            </span>
            <QualityLegend />
          </div>
        }
      >
        <Summary accounts={r.accounts} years={r.years} currentYear={r.currentYear} />
      </Card>
      {open.map((a) => (
        <AccountCard key={a.id} a={a} currentYear={r.currentYear} />
      ))}
      {closed.length > 0 && (
        <details className="rounded-lg border border-line bg-surface p-4">
          <summary className="cursor-pointer text-sm font-semibold text-fg">Closed accounts ({closed.length})</summary>
          <div className="mt-3 flex flex-col gap-4">
            {closed.map((a) => (
              <AccountCard key={a.id} a={a} currentYear={r.currentYear} />
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
        return x.blockers.length ? blockedCell(x.blockers) : { text: usd(x.closing), title: x.returnRatio != null ? `Return ${pct(x.returnRatio)}` : undefined };
      }),
    }));
  // A total over a year with any blocked account isn't provable.
  const sum = (f: (x: RollYear) => number) =>
    shown.map((y): Cell => {
      const blockers = uniq(accounts.flatMap((a) => at(a, y)?.blockers ?? []));
      return blockers.length ? blockedCell(blockers) : { text: usd(accounts.reduce((s, a) => s + (at(a, y) ? f(at(a, y)!) : 0), 0)) };
    });
  rows.push({ label: "Total invested", total: true, cells: sum((x) => x.closing) });
  rows.push({ label: "Contributions (you + employer)", muted: true, cells: sum((x) => x.employee + x.employer) });
  rows.push({ label: "Income + market change", muted: true, cells: sum((x) => (x.income ?? 0) + x.marketChange + x.fees) });
  return <StatementTable columns={shown.map((y) => yearLabel(y, currentYear))} rows={rows} />;
}

function AccountCard({ a, currentYear }: { a: AccountRollforward; currentYear: number }) {
  const ys = a.years;
  const any = (f: (x: RollYear) => number | null) => ys.some((x) => !x.blockers.length && (f(x) ?? 0) !== 0);
  const cell = (x: RollYear, c: Cell): Cell => (x.blockers.length ? blockedCell(x.blockers) : c);
  const row = (label: string, f: (x: RollYear) => number | null, opts: Partial<Extract<TableRow, { cells: Cell[] }>> = {}): TableRow => ({
    label,
    indent: !opts.strong && !opts.total,
    ...opts,
    cells: ys.map((x) => cell(x, { text: f(x) == null ? "—" : usd(f(x)) })),
  });
  const rows: TableRow[] = [
    {
      label: "Opening balance",
      cells: ys.map((x) =>
        cell(x, {
          text: usd(x.opening),
          title: x.firstOnFile && x.opening ? "Balance already in the account when its first statement on file begins" : undefined,
          dim: x.firstOnFile && x.opening !== 0,
        }),
      ),
    },
  ];
  if (any((x) => x.employee)) rows.push(row("Your contributions", (x) => x.employee));
  if (any((x) => x.employer)) rows.push(row("Employer contributions", (x) => x.employer));
  if (any((x) => x.deposits)) rows.push(row("Deposits & transfers in", (x) => x.deposits));
  if (any((x) => x.withdrawals)) rows.push(row("Withdrawals & transfers out", (x) => x.withdrawals));
  rows.push(row("Balance after net contributions", (x) => x.opening + x.employee + x.employer + x.deposits + x.withdrawals, { strong: true }));
  if (ys.some((x) => x.income != null)) rows.push(row("Dividends & interest", (x) => x.income));
  rows.push(row("Net change in market value", (x) => x.marketChange));
  if (any((x) => x.fees)) rows.push(row("Fees", (x) => x.fees));
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
      }),
    ),
  });
  rows.push({ label: "Rate of return", muted: true, cells: ys.map((x) => cell(x, { text: pct(x.returnRatio) })) });

  return (
    <Card
      title={a.name}
      subtitle={
        <>
          {a.group} · on file {a.firstDay} → {a.closed ? `${a.lastDay} (closed)` : a.lastDay}
          {a.annualized != null ? ` · ${pct(a.annualized, 1)} a year since first on file` : a.cumulative != null ? ` · ${pct(a.cumulative, 1)} since first on file` : ""}
        </>
      }
    >
      <StatementTable columns={ys.map((x) => yearLabel(x.year, currentYear))} rows={rows} minWidth="28rem" />
    </Card>
  );
}
