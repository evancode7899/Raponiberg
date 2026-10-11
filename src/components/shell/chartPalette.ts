"use client";

import { useEffect, useState, type CSSProperties } from "react";

/**
 * Chart colors read from the active theme's CSS variables (see globals.css), so every
 * chart restyles itself when the theme changes. Categorical slots are the validated
 * reference palette and are assigned in fixed order — a series keeps its color.
 */
export type ChartPalette = {
  grid: string;
  axis: string;
  axisLine: string;
  tooltipBg: string;
  tooltipFg: string;
  tooltipBorder: string;
  legend: string;
  /** Eight categorical slots, fixed order. */
  series: string[];
  neutral: string;
  /** The net / total line drawn over bars and areas. */
  lineBalance: string;
  // Roles used across the app (each maps to a fixed categorical slot).
  income: string;
  spending: string;
  principal: string;
  growth: string;
  debt: string;
};

const FALLBACK_SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];

function read(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function fromDom(): ChartPalette {
  const series = FALLBACK_SERIES.map((f, i) => read(`--chart-series-${i}`, f));
  return {
    grid: read("--chart-grid", "#e4e4e0"),
    axis: read("--chart-axis", "#6b6a66"),
    axisLine: read("--chart-axis-line", "#c9c9c3"),
    tooltipBg: read("--chart-tooltip-bg", "#ffffff"),
    tooltipFg: read("--chart-tooltip-fg", "#111110"),
    tooltipBorder: read("--chart-tooltip-border", "#c9c9c3"),
    legend: read("--chart-legend", "#3a3a37"),
    series,
    neutral: read("--chart-neutral", "#b5b4ae"),
    lineBalance: read("--chart-line-balance", "#111110"),
    income: series[0]!,
    spending: series[1]!,
    principal: series[0]!,
    growth: series[2]!,
    debt: series[7]!,
  };
}

const INITIAL: ChartPalette = {
  grid: "#e4e4e0",
  axis: "#6b6a66",
  axisLine: "#c9c9c3",
  tooltipBg: "#ffffff",
  tooltipFg: "#111110",
  tooltipBorder: "#c9c9c3",
  legend: "#3a3a37",
  series: FALLBACK_SERIES,
  neutral: "#b5b4ae",
  lineBalance: "#111110",
  income: FALLBACK_SERIES[0]!,
  spending: FALLBACK_SERIES[1]!,
  principal: FALLBACK_SERIES[0]!,
  growth: FALLBACK_SERIES[2]!,
  debt: FALLBACK_SERIES[7]!,
};

export function useChartPalette(): ChartPalette {
  const [p, setP] = useState<ChartPalette>(INITIAL);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial read of the theme's CSS colors from the DOM; the MutationObserver below keeps them in sync
    setP(fromDom());
    const obs = new MutationObserver(() => setP(fromDom()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return p;
}

/** Shared Recharts props so every chart has the same recessive axes, grid and tooltip. */
export function chartChrome(p: ChartPalette) {
  const tick = { fill: p.axis, fontSize: 11 };
  return {
    grid: { stroke: p.grid, vertical: false } as const,
    xAxis: { tick, stroke: p.axisLine, tickLine: false } as const,
    yAxis: { tick, stroke: "transparent", tickLine: false, width: 60 } as const,
    tooltip: {
      contentStyle: {
        background: p.tooltipBg,
        border: `1px solid ${p.tooltipBorder}`,
        borderRadius: 6,
        color: p.tooltipFg,
        fontSize: 12,
        padding: "6px 10px",
      } as CSSProperties,
      itemStyle: { color: p.tooltipFg, padding: 0 } as CSSProperties,
      labelStyle: { color: p.tooltipFg, fontWeight: 600, marginBottom: 2 } as CSSProperties,
      cursor: { fill: p.grid, fillOpacity: 0.5 },
    },
    legend: { wrapperStyle: { color: p.legend, fontSize: 12, paddingTop: 4 } as CSSProperties, iconSize: 10 },
  };
}

/**
 * Account groups keep one color everywhere (dashboard, net worth, outlook), assigned by
 * the group's fixed place in the list — never by rank — with debt in the red slot.
 */
const GROUP_SLOTS: Record<string, number> = {
  Cash: 0,
  "Taxable investments": 1,
  Retirement: 2,
  "Education (529)": 3,
  "Health savings": 4,
  Other: 6,
  "Credit cards": 7,
};

export function groupColor(p: ChartPalette, group: string): string {
  const slot = GROUP_SLOTS[group];
  return slot == null ? p.neutral : p.series[slot]!;
}

/** Sort key for account groups: assets in their usual order, debt last. */
export function groupRank(group: string): number {
  return GROUP_SLOTS[group] ?? 5;
}
