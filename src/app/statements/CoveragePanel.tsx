"use client";

import { btn, Card, EmptyState } from "@/components/ui/kit";
import { formatDisplayDateFromYmd } from "@/lib/displayTime";
import type { MonthCell } from "@/lib/ledger/coverageReport";
import { useEffect, useRef } from "react";
import { openIssues } from "./IntegrityPanels";
import { Timeline } from "./Timeline";
import type { BookReport } from "./useBookReport";

const CELL: Record<MonthCell, { cls: string; label: string }> = {
  FULL: { cls: "bg-pos", label: "Statements cover the whole month" },
  IDLE: { cls: "bg-pos/45", label: "No activity, so the card issuer sent no statement (proven $0)" },
  DERIVED: { cls: "bg-info", label: "Derived from a year-end report" },
  PARTIAL: { cls: "bg-warn", label: "Partly covered" },
  MISSING: { cls: "bg-neg", label: "No statement — upload it to fill the gap" },
  INACTIVE: { cls: "bg-surface-3/40", label: "Account not open / closed" },
};

const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

/**
 * Coverage two ways: which statements and pay stubs are on file per account and month
 * (the inputs), then which months of cash flow, net worth and taxes they prove (the
 * figures). What to do about a gap is on the Issues tab, one finding per gap.
 */
export function CoveragePanel({ r, onGo }: { r: BookReport; onGo: (tab: "issues" | "plan") => void }) {
  const data = r.coverage;
  const scroller = useRef<HTMLDivElement>(null);
  // Open on the most recent months.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, [data]);

  if (data.accounts.length === 0 && data.untrackedCards.length === 0 && (data.paystubSources ?? []).length === 0) {
    return <EmptyState title="No statements on file yet">Import some on the Import tab and coverage shows up here.</EmptyState>;
  }

  const years = [...new Set(data.months.map((m) => m.slice(0, 4)))];
  const { failing, missing } = openIssues(r);
  const open = failing.length + missing.length;
  const awaiting = r.findings.filter((f) => f.atEdge).length;
  const yearBorder = (i: number) => (data.months[i]!.slice(5, 7) === "01" ? "border-l border-line-strong" : "");
  const rowLabel = (name: string, meta: React.ReactNode) => (
    <td className="sticky left-0 z-10 whitespace-nowrap bg-surface py-0.5 pr-4 text-xs">
      <span className="text-fg">{name}</span>
      <span className="ml-1.5 text-faint">{meta}</span>
    </td>
  );
  const cells = (months: MonthCell[], title: (i: number, c: MonthCell) => string) =>
    months.map((c, i) => (
      <td key={i} className={`p-[1.5px] ${yearBorder(i)}`}>
        <div title={title(i, c)} className={`h-3.5 w-3.5 rounded-[3px] ${CELL[c].cls}`} />
      </td>
    ));
  const groupHeader = (label: string) => (
    <tr key={`group-${label}`}>
      {/* The cell spans the whole table, so the label (not the cell) sticks while the months scroll. */}
      <td colSpan={data.months.length + 1} className="pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-muted">
        <span className="sticky left-0">{label}</span>
      </td>
    </tr>
  );
  // One section per account type, A–Z within each. The report already lists accounts in the
  // app's group order (cash first, cards last); cards known only from payments sit with the
  // other credit cards.
  const byName = (x: string, y: string) => x.localeCompare(y, undefined, { sensitivity: "base", numeric: true });
  const rows = [
    ...data.accounts.map((a) => ({ group: a.group, name: a.name, row: { kind: "account" as const, a } })),
    ...data.untrackedCards.map((c) => ({ group: "Credit cards", name: c.name, row: { kind: "untracked" as const, c } })),
  ];
  const groups = [...new Set(rows.map((r) => r.group))];
  rows.sort((x, y) => groups.indexOf(x.group) - groups.indexOf(y.group) || byName(x.name, y.name));

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Statement coverage"
        subtitle={
          <>
            Every account, every month. Every open account has statements through{" "}
            <span className="font-semibold text-fg">{formatDisplayDateFromYmd(r.horizon.netWorth)}</span>, the data edge. Statement cycles don&apos;t need to
            line up with months; the dashboards handle that.
          </>
        }
      >
        <div ref={scroller} className="app-scroll overflow-x-auto pb-1">
          <table className="border-separate border-spacing-0 text-[10px]">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-surface" />
                {years.map((y) => (
                  <th key={y} colSpan={data.months.filter((m) => m.startsWith(y)).length} className="border-l border-line-strong px-1 pb-0.5 text-left font-semibold text-fg-2">
                    {y}
                  </th>
                ))}
              </tr>
              <tr>
                <th className="sticky left-0 z-10 bg-surface" />
                {data.months.map((m, i) => (
                  <th key={m} className={`w-[17px] pb-1 text-center font-normal text-faint ${yearBorder(i)}`}>
                    {MONTHS[Number(m.slice(5, 7)) - 1]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => [
                groupHeader(g),
                ...rows
                  .filter((r) => r.group === g)
                  .map(({ row }) =>
                    row.kind === "account" ? (
                      <tr key={row.a.accountId}>
                        {rowLabel(row.a.name, `${row.a.statementCount} · ${row.a.cadenceDays >= 80 ? "quarterly" : "monthly"}${row.a.closed ? " · closed" : ""}`)}
                        {cells(row.a.months, (i, c) => `${data.months[i]}: ${CELL[c].label}`)}
                      </tr>
                    ) : (
                      <tr key={`untracked-${row.c.name}`}>
                        {rowLabel(row.c.name, <span className="text-neg">0 statements · closed after {row.c.lastPayment}</span>)}
                        {cells(row.c.months, (i, cell) => `${data.months[i]}: ${CELL[cell].label}`)}
                      </tr>
                    ),
                  ),
              ])}
              {(data.paystubSources ?? []).length > 0 && groupHeader("Pay stubs")}
              {[...(data.paystubSources ?? [])].sort((x, y) => byName(x.employer, y.employer)).map((p) => (
                <tr key={`stub-${p.employer}`}>
                  {rowLabel(p.employer, `${p.stubCount} stubs · last ${p.lastPayDate}`)}
                  {cells(p.months, (i, cell) => `${data.months[i]}: ${cell === "FULL" ? "Pay stub on file" : CELL[cell].label.replace("statement", "pay stub")}`)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-2.5 text-xs">
          <span className={open ? "font-medium text-fg" : "text-muted"}>
            {open
              ? `${failing.length ? `${failing.length} failing` : ""}${failing.length && missing.length ? " · " : ""}${missing.length ? `${missing.length} missing` : ""} — gaps, breaks and overdue statements are listed one by one on Issues.`
              : "No gaps, breaks or overdue statements inside the data edge."}
          </span>
          {open > 0 && (
            <button type="button" className={btn.link} onClick={() => onGo("issues")}>
              Open Issues →
            </button>
          )}
          {awaiting > 0 && (
            <>
              <span className="text-muted">
                Past {formatDisplayDateFromYmd(r.horizon.netWorth)}, {awaiting} item{awaiting === 1 ? "" : "s"} await newer statements.
              </span>
              <button type="button" className={btn.link} onClick={() => onGo("plan")}>
                What to download →
              </button>
            </>
          )}
        </div>
      </Card>

      <Timeline t={r.timeline} />
    </div>
  );
}
