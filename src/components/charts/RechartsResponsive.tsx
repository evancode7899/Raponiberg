"use client";

import { Drawer, NotFigure, table as tableCls } from "@/components/ui/kit";
import { ProofValue, type FigureProps } from "@/components/ui/proof/ProofValue";
import { unswept, type ProofRef } from "@/components/ui/proof/context";
import { chartTable } from "@/lib/chartSeries";
import { Children, Fragment, isValidElement, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Area, Bar, Line, ResponsiveContainer, Scatter, Tooltip, XAxis, type ResponsiveContainerProps } from "recharts";

/**
 * Recharts throttles ResizeObserver when debounce > 0 (`leading: false`), which can
 * leave charts at 0×0 or let a late zero-size callback win. Default matches Recharts (0).
 * Pass a positive debounce only if you need to throttle very chatty resizes.
 */
const DEFAULT_DEBOUNCE_MS = 0;

/**
 * Size used before the container is first measured. Recharts' own default (-1 × -1)
 * logs a "width(-1) and height(-1) of chart should be greater than 0" warning on every
 * chart's first render; the real size replaces this one as soon as it is measured.
 */
const INITIAL_DIMENSION = { width: 1, height: 1 };

type Props = Record<string, unknown>;
const SERIES = new Set<unknown>([Line, Bar, Area, Scatter]);

/** Every element under the chart, through arrays and fragments. */
function flatten(children: ReactNode): ReactElement<Props>[] {
  return Children.toArray(children).flatMap((c) => (isValidElement<Props>(c) ? (c.type === Fragment ? flatten(c.props.children as ReactNode) : [c]) : []));
}

/**
 * What the chart draws, read off the chart itself: its points, the x axis's key, each series
 * by its name, and the chart's own tooltip formatter, so the table says each value exactly as
 * hovering the chart does. Null for a chart it can't read (no points, no series).
 */
export function readChart(chart: ReactNode): { rows: Record<string, unknown>[]; x: string; series: { key: string; name: string }[]; format: (v: number, name: string, row: Record<string, unknown>) => string } | null {
  if (!isValidElement<Props>(chart)) return null;
  const rows = chart.props.data;
  if (!Array.isArray(rows) || !rows.length) return null;
  const parts = flatten(chart.props.children as ReactNode);
  const xKey = parts.find((p) => p.type === XAxis)?.props.dataKey;
  const series = parts
    .filter((p) => SERIES.has(p.type) && typeof p.props.dataKey === "string" && p.props.legendType !== "none")
    .map((p) => ({ key: p.props.dataKey as string, name: typeof p.props.name === "string" ? p.props.name : (p.props.dataKey as string) }))
    .filter((s, i, all) => all.findIndex((o) => o.key === s.key) === i);
  if (!series.length || typeof xKey !== "string") return null;
  const formatter = parts.find((p) => p.type === Tooltip)?.props.formatter as ((v: unknown, n: unknown, item: unknown, i: number, payload: unknown) => unknown) | undefined;
  const format = (v: number, name: string, row: Record<string, unknown>) => {
    if (!formatter) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
    try {
      const out = formatter(v, name, { payload: row, value: v, name, dataKey: name }, 0, []);
      return String(Array.isArray(out) ? out[0] : out);
    } catch {
      return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
    }
  };
  return { rows: rows as Record<string, unknown>[], x: xKey, series, format };
}

/**
 * The container every chart sits in. Besides sizing it, it offers the chart as a table: a
 * small Table button (by pointer or Tab) opens the same points, each value in the chart's own
 * tooltip words, for a screen reader or anyone who'd rather read numbers. The table is drawn
 * only when asked for, as the tooltip is.
 *
 * Each value in the table is a figure (owner's rule, 2026-11-26): it opens its proof like any
 * other, through `cellProof`, which names the proof of one point of one series. A point with
 * no proof named draws n.a. (withheld, saying why), so a chart can't show a number in its table
 * that nothing proves. A series that isn't money or a rate (miles, a count, miles per gallon)
 * isn't a figure: `plainSeries` names it with why, and its values draw plain (kit NotFigure). A chart inside a what-if region (kit WhatIf) draws its points plain:
 * they are a scenario's, and the table is marked as part of that what-if. The render audit
 * opens every chart's table (data-chart-table) and holds what it draws like any view.
 */
/** The proof a chart names for one point of one series: the figure the page shows for it. */
export type CellProof = (row: Record<string, unknown>, series: string) => ProofRef | null | undefined;
/** What a table cell says when its chart names no proof for that point. */
export const NO_CELL_PROOF = unswept("This chart doesn't name a proof for this point: the figure on the page beside it has one.");
/** How a series draws its values when not as the number itself (an index of 100 drawn for a ratio of 1): ProofValue's drawn. */
export type CellDrawn = Readonly<Record<string, FigureProps["drawn"]>>;

export function RechartsResponsive({
  debounce = DEFAULT_DEBOUNCE_MS,
  children,
  tableTitle = "The chart as a table",
  cellProof,
  cellDrawn,
  cellText,
  plainSeries,
  pendingProof,
  ...rest
}: Omit<ResponsiveContainerProps, "width" | "height"> & {
  debounce?: number;
  /** What the chart shows, as the table's title. */
  tableTitle?: string;
  /** The proof of each point, for the table (above). */
  cellProof?: CellProof;
  /** How a series draws its values, by data key, when not as the number itself. */
  cellDrawn?: CellDrawn;
  /** A cell's words when the tooltip's say more than its one figure (a share and the count behind it): the figure alone. */
  cellText?: (value: number, series: string, row: Record<string, unknown>) => string | null | undefined;
  /** Series that aren't money or a rate, by data key: why each is no figure. */
  plainSeries?: Readonly<Record<string, string>>;
  /**
   * A chart whose points have no proof yet and wait on the owner's choice of how to prove
   * them (per-day series): each value draws n.a. saying this, and the render audit lists
   * the table under CHART_TABLE_PENDING instead of failing it (renderAudit.ts).
   */
  pendingProof?: string;
}) {
  const [open, setOpen] = useState<false | { whatIf: string | null }>(false);
  const box = useRef<HTMLDivElement>(null);
  const readable = readChart(children as ReactNode) != null;
  return (
    <div ref={box} className="group/chart relative h-full w-full">
      <ResponsiveContainer width="100%" height="100%" debounce={debounce} initialDimension={INITIAL_DIMENSION} {...rest}>
        {children}
      </ResponsiveContainer>
      {readable && (
        <button
          type="button"
          data-chart-table={tableTitle}
          onClick={() => setOpen({ whatIf: box.current?.closest<HTMLElement>("[data-what-if]")?.dataset.whatIf ?? null })}
          title="Show the chart's points as a table"
          className="absolute right-0 top-0 z-[2] rounded border border-line bg-surface px-1.5 py-0.5 text-2xs text-muted opacity-0 outline-none hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-focus group-hover/chart:opacity-100"
        >
          Table
        </button>
      )}
      {open && <ChartTableDrawer chart={children as ReactNode} title={tableTitle} whatIf={open.whatIf} cellProof={pendingProof ? () => unswept(pendingProof) : cellProof} cellDrawn={cellDrawn} cellText={cellText} plainSeries={plainSeries} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ChartTableDrawer({ chart, title, whatIf, cellProof, cellDrawn, cellText, plainSeries, onClose }: { chart: ReactNode; title: string; whatIf: string | null; cellProof?: CellProof; cellDrawn?: CellDrawn; cellText?: (value: number, series: string, row: Record<string, unknown>) => string | null | undefined; plainSeries?: Readonly<Record<string, string>>; onClose: () => void }) {
  const read = readChart(chart);
  if (!read) return null;
  const t = chartTable(read.rows, read.x, read.series, () => "");
  const body = read.rows.map((r, i) => [
    t.body[i]![0]!,
    ...read.series.map((s) => {
      if (typeof r[s.key] !== "number") return "";
      const text = cellText?.(r[s.key] as number, s.key, r) ?? read.format(r[s.key] as number, s.name, r);
      // A what-if's points are a scenario's: plain, inside the region the table is marked as.
      if (whatIf != null) return text;
      const plain = plainSeries?.[s.key];
      if (plain) return <NotFigure why={plain}>{text}</NotFigure>;
      return (
        <ProofValue proof={cellProof?.(r, s.key) ?? NO_CELL_PROOF} drawn={cellDrawn?.[s.key]}>
          {text}
        </ProofValue>
      );
    }),
  ]);
  return (
    <Drawer open onClose={onClose} title={title} subtitle={whatIf != null ? "Each value as the chart's tooltip says it: a what-if's, not a proven figure." : "Each value as the chart's tooltip says it; each opens its proof."} width="40rem">
      <div className={tableCls.wrap} {...(whatIf != null ? { "data-what-if": whatIf || "a what-if chart" } : {})}>
        <table className={tableCls.table}>
          <caption className="sr-only">{title}</caption>
          <thead className={tableCls.head}>
            <tr>
              {t.head.map((h, i) => (
                <th key={i} scope="col" className={i ? tableCls.thR : tableCls.th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, i) => (
              <tr key={i} className={tableCls.tr}>
                {r.map((c, j) => (
                  <td key={j} className={j ? tableCls.tdR : tableCls.td}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Drawer>
  );
}
