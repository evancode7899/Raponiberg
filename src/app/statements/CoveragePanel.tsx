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
              {data.accounts.map((a) => (
                <tr key={a.accountId}>
                  {rowLabel(a.name, `${a.statementCount} · ${a.cadenceDays >= 80 ? "quarterly" : "monthly"}${a.closed ? " · closed" : ""}`)}
                  {cells(a.months, (i, c) => `${data.months[i]}: ${CELL[c].label}`)}
                </tr>
              ))}
              {data.untrackedCards.map((c) => (
                <tr key={c.name}>
                  {rowLabel(c.name, <span className="text-neg">0 statements · closed after {c.lastPayment}</span>)}
                  {cells(c.months, (i, cell) => `${data.months[i]}: ${CELL[cell].label}`)}
                </tr>
              ))}
              {(data.paystubSources ?? []).length > 0 && (
                <tr>
                  <td colSpan={data.months.length + 1} className="sticky left-0 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-muted">
                    Pay stubs
                  </td>
                </tr>
              )}
              {(data.paystubSources ?? []).map((p) => (
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
