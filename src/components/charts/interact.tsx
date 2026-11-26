"use client";

import type { ChartPalette } from "@/components/shell/chartPalette";
import { btn } from "@/components/ui/kit";
import { lastIndexWith, zoomWindow } from "@/lib/chartSeries";
import { useState, type ReactElement } from "react";
import { ReferenceLine } from "recharts";

/**
 * The pieces every chart shares beyond the Dashboard: a crosshair that follows the pointer, a
 * brush to zoom into a stretch of time, a dashed "the same time before" overlay
 * (lib/chartSeries.ts withCompare), flags on the dates things happened, names written at the
 * ends of the lines, and a series lit up while its legend entry is pointed at. Nothing moves
 * by itself: no animation, no transition. Every chart's points open as a table from its
 * container (RechartsResponsive).
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

/** Reset zoom, shown only while a chart is zoomed. */
export function ZoomReset({ zoom }: { zoom: { zoomed: boolean; reset: () => void } }) {
  if (!zoom.zoomed) return null;
  return (
    <button type="button" className={`${btn.link} mt-1 text-2xs`} onClick={zoom.reset}>
      Reset zoom
    </button>
  );
}
