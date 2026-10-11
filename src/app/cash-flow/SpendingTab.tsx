"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome } from "@/components/shell/chartPalette";
import { Badge, btn, Card, ErrorNote, Segmented, table } from "@/components/ui/kit";
import type { OneOffExpense } from "@/lib/book/reports/spending";
import type { FinancialProfileSettings } from "@/lib/profile/settings";
import { axisUsd, formatPercentRatio, formatUsd, usd0, usdCompact } from "@/lib/formatMoney";
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from "recharts";
import type { Ctx } from "./CashFlowClient";
import { categoryCents, categorySlot, median, mergeCategories, SPEND_CATEGORIES, totals } from "./model";
import { categoryColor, Delta, Dot, Sparkline } from "./parts";

export function SpendingTab({ ctx }: { ctx: Ctx }) {
  const { slice, chart, focus, setFocus, open } = ctx;
  const ui = chartChrome(chart);
  const t = totals(slice.months);
  const p = slice.prior.length ? totals(slice.prior) : null;
  const cats = useMemo(() => mergeCategories(slice.months, (m) => m.spendingByCategory), [slice]);
  const prevCats = useMemo(() => mergeCategories(slice.prior, (m) => m.spendingByCategory), [slice]);

  // An insight can point at a category: open it once.
  useEffect(() => {
    if (focus) {
      open({ kind: "category", category: focus });
      setFocus(null);
    }
  }, [focus, open, setFocus]);

  // Stacked bars: categories with their own color, the rest as "Other".
  const colored = SPEND_CATEGORIES.filter((c) => categorySlot(c) != null);
  const stack = slice.months.map((m) => {
    const row: Record<string, number | string> = { label: m.label };
    let other = 0;
    for (const c of m.spendingByCategory) {
      if (categorySlot(c.category) != null) row[c.category] = c.cents / 100;
      else other += c.cents / 100;
    }
    row.Other = other;
    return row;
  });

  return (
    <>
      <Card
        title="Categories"
        subtitle={`Per month over ${slice.label}${p ? `, against the ${p.n} months before` : ""}. Typical = median month. Click a row for its merchants and transactions.`}
      >
        <div className={table.wrap}>
          <table className={`${table.table} min-w-[52rem]`}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Category</th>
                <th className={table.th}>Trend</th>
                <th className={table.thR}>Average / mo</th>
                <th className={table.thR}>Typical / mo</th>
                <th className={table.thR}>Total</th>
                <th className={table.thR}>Share</th>
                <th className={table.thR}>{p ? "vs before" : ""}</th>
              </tr>
            </thead>
            <tbody>
              {cats.map((c) => {
                const before = prevCats.find((x) => x.category === c.category);
                const series = slice.months.map((m) => categoryCents(m, c.category));
                return (
                  <tr key={c.category} className={`${table.trHover} cursor-pointer`} onClick={() => open({ kind: "category", category: c.category })}>
                    <td className={`${table.td} font-medium`}>
                      <span className="flex items-center gap-2">
                        <Dot color={categoryColor(chart, c.category)} />
                        {c.category}
                      </span>
                    </td>
                    <td className={table.td}>
                      <Sparkline values={series} color={categoryColor(chart, c.category)} />
                    </td>
                    <td className={`${table.tdR} font-medium`}>{usd0(c.cents / t.n)}</td>
                    <td className={`${table.tdR} text-muted`}>{usd0(median(series))}</td>
                    <td className={table.tdR}>{usd0(c.cents)}</td>
                    <td className={`${table.tdR} text-muted`}>{c.cents > 0 && t.spending > 0 ? formatPercentRatio(c.cents / t.spending, 0) : "—"}</td>
                    <td className={table.tdR}>{p && <Delta now={c.cents / t.n} before={(before?.cents ?? 0) / p.n} goodWhenDown />}</td>
                  </tr>
                );
              })}
              <tr className={`${table.tr} font-semibold`}>
                <td className={table.td}>All spending</td>
                <td className={table.td}>
                  <Sparkline values={slice.months.map((m) => m.spendingCents)} color={chart.spending} />
                </td>
                <td className={table.tdR}>{usd0(t.avgSpending)}</td>
                <td className={`${table.tdR} text-muted`}>{usd0(t.typicalSpending)}</td>
                <td className={table.tdR}>{usd0(t.spending)}</td>
                <td className={table.tdR} />
                <td className={table.tdR}>{p && <Delta now={t.avgSpending} before={p.avgSpending} goodWhenDown />}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Spending by category, month by month" subtitle="Taxes & fees, untracked card payments and other spending are grouped as Other.">
        <div className="h-[320px] w-full min-w-0">
          <RechartsResponsive>
            <BarChart data={stack} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid {...ui.grid} />
              <XAxis dataKey="label" {...ui.xAxis} minTickGap={12} />
              <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
              <Tooltip {...ui.tooltip} formatter={(v, n) => [formatUsd(Math.round(Number(v))), String(n)]} />
              <Legend {...ui.legend} />
              {colored.map((c) => (
                <Bar key={c} dataKey={c} stackId="s" fill={categoryColor(chart, c)} stroke={chart.tooltipBg} strokeWidth={1} maxBarSize={36} isAnimationActive={false} />
              ))}
              <Bar dataKey="Other" stackId="s" fill={chart.neutral} stroke={chart.tooltipBg} strokeWidth={1} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
            </BarChart>
          </RechartsResponsive>
        </div>
      </Card>

      <Heatmap ctx={ctx} categories={cats.filter((c) => c.cents > 0).map((c) => c.category)} />
      <OneOffs ctx={ctx} />
    </>
  );
}

/** Category × month grid, each row shaded against its own busiest month. */
function Heatmap({ ctx, categories }: { ctx: Ctx; categories: string[] }) {
  const { slice, chart } = ctx;
  const [scale, setScale] = useState<"row" | "all">("row");
  const months = slice.months.slice(-18);
  const max = Math.max(1, ...categories.flatMap((c) => months.map((m) => categoryCents(m, c))));
  return (
    <Card
      title="Heatmap"
      subtitle={`Darker = more spent. ${scale === "row" ? "Each row is shaded against its own busiest month, so you can see when each category spikes." : "One scale for every cell, so big categories stand out."}${slice.months.length > 18 ? " Showing the latest 18 months." : ""}`}
      actions={
        <Segmented
          size="xs"
          ariaLabel="Shading"
          options={[
            { value: "row", label: "By row" },
            { value: "all", label: "One scale" },
          ]}
          value={scale}
          onChange={setScale}
        />
      }
    >
      <div className={table.wrap}>
        <table className="w-full border-separate border-spacing-[2px] text-[11px]">
          <thead>
            <tr>
              <th className="sticky left-0 bg-surface px-1 text-left font-medium text-muted" />
              {months.map((m) => (
                <th key={m.start} className="whitespace-nowrap px-1 text-center font-medium text-muted">
                  {m.label.slice(0, 3)}
                  <div className="text-[10px] font-normal text-faint">{m.label.slice(-2)}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => {
              const rowMax = Math.max(1, ...months.map((m) => categoryCents(m, c)));
              return (
                <tr key={c}>
                  <th className="sticky left-0 whitespace-nowrap bg-surface pr-2 text-left text-xs font-medium text-fg-2">{c}</th>
                  {months.map((m) => {
                    const v = categoryCents(m, c);
                    const a = v <= 0 ? 0 : v / (scale === "row" ? rowMax : max);
                    return (
                      <td
                        key={m.start}
                        title={`${c}, ${m.label}: ${usd0(v)}`}
                        className="num h-8 min-w-[3.25rem] cursor-pointer rounded-[3px] px-1 text-center hover:ring-2 hover:ring-focus"
                        style={{ background: `color-mix(in oklab, ${chart.spending} ${Math.round(8 + a * 82)}%, transparent)`, color: a > 0.55 ? "#fff" : undefined }}
                        onClick={() => ctx.open({ kind: "category", category: c })}
                      >
                        {v ? usdCompact(v).replace(".0k", "k") : "—"}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * Big expenses, and whether each counts as a one-off. The tag lives on the financial
 * Annual report, so FIRE's living cost and this page agree on what's typical.
 */
function OneOffs({ ctx }: { ctx: Ctx }) {
  const { slice, report, api } = ctx;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const from = slice.months[0]!.start;
  const to = slice.months.at(-1)!.end;
  const list = report.oneOffs.filter((o) => o.date >= from && o.date <= to);
  const shown = showAll ? list : list.slice(0, 12);
  const toggle = async (o: OneOffExpense) => {
    setBusy(o.fingerprint);
    try {
      const s = await api.call<FinancialProfileSettings>("/api/profile/settings");
      const oneOffs = { ...s.oneOffs };
      if (o.tagged) delete oneOffs[o.fingerprint];
      else oneOffs[o.fingerprint] = `${o.merchant} (${o.category})`;
      await api.call("/api/profile/settings", { method: "PUT", json: { ...s, oneOffs } });
      setError(null);
      ctx.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const tagged = list.filter((o) => o.tagged);
  return (
    <Card
      title="Big one-off expenses"
      subtitle={`Single charges of $1,500 or more that aren't a regular bill. Marking one as one-off keeps it in your totals but out of "excluding one-offs" — and out of the living cost your FIRE plan starts from.${
        tagged.length ? ` ${tagged.length} marked: ${usd0(tagged.reduce((s, o) => s + o.cents, 0))}.` : ""
      }`}
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      {list.length === 0 ? (
        <p className="text-sm text-muted">No single charge over $1,500 in this range.</p>
      ) : (
        <div className={table.wrap}>
          <table className={`${table.table} min-w-[44rem]`}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Date</th>
                <th className={table.th}>Merchant</th>
                <th className={table.th}>Category</th>
                <th className={table.th}>Account</th>
                <th className={table.thR}>Amount</th>
                <th className={table.thR}>One-off?</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => (
                <tr key={o.fingerprint} className={table.trHover}>
                  <td className={`${table.td} num whitespace-nowrap text-muted`}>{o.date}</td>
                  <td className={table.td} title={o.payee}>
                    {o.merchant}
                  </td>
                  <td className={`${table.td} text-fg-2`}>{o.category}</td>
                  <td className={`${table.td} text-xs text-muted`}>{o.account}</td>
                  <td className={`${table.tdR} font-medium`}>{usd0(o.cents)}</td>
                  <td className={table.tdR}>
                    {o.viaCategory ? (
                      <Badge title="Its whole category counts as non-recurring (Profile settings)">category</Badge>
                    ) : (
                      <button type="button" className={o.tagged ? btn.secondary : btn.ghost} disabled={busy != null} onClick={() => toggle(o)} aria-pressed={o.tagged}>
                        {busy === o.fingerprint ? "Saving…" : o.tagged ? "✓ One-off" : "Mark one-off"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length > 12 && (
            <button type="button" className={`${btn.link} mt-2`} onClick={() => setShowAll(!showAll)}>
              {showAll ? "Show fewer" : `Show all ${list.length}`}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
