"use client";

import type { ChartPalette } from "@/components/shell/chartPalette";
import { btn, table as tableCls } from "@/components/ui/kit";
import { chartTable, lastIndexWith, zoomWindow } from "@/lib/chartSeries";
import { useId, useState, type ReactElement, type ReactNode } from "react";
import { ReferenceLine } from "recharts";

/**
 * The pieces every chart shares beyond the Dashboard: a crosshair that follows the pointer, a
 * brush to zoom into a stretch of time, a dashed "the same time before" overlay
 * (lib/chartSeries.ts withCompare), flags on the dates things happened, names written at the
 * ends of the lines, and a series lit up while its legend entry is pointed at. Nothing moves
 * by itself: no animation, no transition.
 */

/** A thin dashed line under the pointer, for line and area charts (bar charts keep their band). */
export function crosshair(p: ChartPalette) {
  return { stroke: p.axis, strokeWidth: 1, strokeDasharray: "3 3", fill: "transparent" };
}

/**
 * Lights one series while its legend entry is pointed at, dimming the rest. Spread `legend`
 * on the chart's <Legend>, and `fade(key)` on each series.
 */
export function useLegendHighlight() {
  const [on, setOn] = useState<string | null>(null);
  return {
    on,
    legend: {
      onMouseEnter: (o: { dataKey?: unknown }) => setOn(o?.dataKey == null ? null : String(o.dataKey)),
      onMouseLeave: () => setOn(null),
    },
    fade: (key: string) => (on && on !== key ? { strokeOpacity: 0.22, fillOpacity: 0.06, opacity: 0.35 } : {}),
  };
}

/**
 * Zoom into a stretch: the brush's window, held inside the data. Spread `brush` on a
 * <Brush>; `reset` shows everything again; `zoomed` says whether it's narrowed.
 */
export function useZoom(count: number, p: ChartPalette) {
  const [win, setWin] = useState<{ start: number; end: number } | null>(null);
  const shown = win ? zoomWindow(count, win.start, win.end) : { start: 0, end: Math.max(0, count - 1) };
  return {
    zoomed: !!win && (shown.start > 0 || shown.end < count - 1),
    reset: () => setWin(null),
    brush: {
      height: 16,
      travellerWidth: 7,
      stroke: p.axisLine,
      fill: p.tooltipBg,
      startIndex: shown.start,
      endIndex: shown.end,
      onChange: (r: { startIndex?: number; endIndex?: number }) => {
        if (r.startIndex != null && r.endIndex != null) setWin({ start: r.startIndex, end: r.endIndex });
      },
      tickFormatter: () => "",
    },
  };
}

/** Flags on the dates things happened (a raise, a move, a market fall): a dashed rule with its name at the top. */
export function eventFlags(events: readonly { x: string | number; label: string }[], p: ChartPalette, yAxisId?: string | number): ReactElement[] {
  return events.map((e) => (
    <ReferenceLine
      key={`flag-${e.x}-${e.label}`}
      x={e.x}
      {...(yAxisId != null ? { yAxisId } : {})}
      stroke={p.axis}
      strokeDasharray="2 3"
      ifOverflow="hidden"
      label={{ value: e.label, position: "insideTopLeft", fill: p.legend, fontSize: 10 }}
    />
  ));
}

/**
 * A line's name written at its last point, in its own color, so the eye needn't go to the
 * legend. Pass as a <Line>'s `label`; `rows` are the chart's points.
 */
export function endLabel(name: string, color: string, rows: readonly Record<string, unknown>[], key: string) {
  const last = lastIndexWith(rows, key);
  function EndLabel(props: { x?: number | string; y?: number | string; index?: number }) {
    if (props.index !== last || props.x == null || props.y == null) return null;
    return (
      <text x={Number(props.x) + 6} y={Number(props.y)} dy={4} fill={color} fontSize={11} fontWeight={600}>
        {name}
      </text>
    );
  }
  return EndLabel;
}

/**
 * Under a chart: the same points as a table, for a screen reader or anyone who wants the
 * numbers, and Reset zoom when it's zoomed. The table is drawn only once asked for, as the
 * chart's own tooltip is: it shows what the chart shows, in the chart's own words.
 */
export function ChartFoot({
  rows,
  x,
  series,
  format,
  zoom,
  label,
  children,
}: {
  rows: readonly Record<string, unknown>[];
  x: string;
  series: readonly { key: string; name: string }[];
  format: (v: number) => string;
  zoom?: { zoomed: boolean; reset: () => void };
  /** What the chart shows, for the table's caption. */
  label: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const t = open ? chartTable(rows, x, series, format) : null;
  return (
    <div className="mt-1 flex flex-col gap-1">
      <div className="flex items-center gap-2 text-2xs">
        <button type="button" className={btn.link} aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide the table" : "Show as a table"}
        </button>
        {zoom?.zoomed && (
          <button type="button" className={btn.link} onClick={zoom.reset}>
            Reset zoom
          </button>
        )}
        {children}
      </div>
      {t && (
        <div id={id} className={`${tableCls.wrap} max-h-72 overflow-y-auto rounded border border-line`}>
          <table className={tableCls.table}>
            <caption className="sr-only">{label}</caption>
            <thead className={`${tableCls.head} sticky top-0 bg-[var(--card-bg,var(--surface))]`}>
              <tr>
                {t.head.map((h, i) => (
                  <th key={i} scope="col" className={i ? tableCls.thR : tableCls.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.body.map((r, i) => (
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
      )}
    </div>
  );
}
