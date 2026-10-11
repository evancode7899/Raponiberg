"use client";

import { Badge, btn, Callout, Card, ErrorNote, Loading, MoneyInput, StatCell, StatGrid, table } from "@/components/ui/kit";
import type { BudgetSettings } from "@/lib/budget/settings";
import { formatPercentRatio, usd0 } from "@/lib/formatMoney";
import { useEffect, useState } from "react";
import type { Ctx } from "./CashFlowClient";
import { categoryCents, median, SPEND_CATEGORIES, totals } from "./model";
import { Bar, categoryColor, Dot } from "./parts";

const round10 = (cents: number) => Math.round(cents / 1000) * 1000;

export function BudgetTab({ ctx }: { ctx: Ctx }) {
  const { api, slice, chart } = ctx;
  const [saved, setSaved] = useState<BudgetSettings | null>(null);
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .call<BudgetSettings>("/api/budget")
      .then((b) => {
        setSaved(b);
        setDraft(b.targets);
      })
      .catch((e: Error) => setError(e.message));
  }, [api]);

  if (error && !saved) return <ErrorNote>{error}</ErrorNote>;
  if (!saved) return <Loading />;

  const last = slice.months.at(-1)!;
  const t = totals(slice.months);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved.targets);
  const rows = SPEND_CATEGORIES.map((c) => {
    const series = slice.months.map((m) => categoryCents(m, c));
    const target = draft[c] ?? null;
    return {
      c,
      target,
      typical: median(series),
      avg: series.reduce((s, v) => s + v, 0) / Math.max(1, series.length),
      latest: categoryCents(last, c),
      over: target == null ? 0 : series.filter((v) => v > target).length,
    };
  }).filter((r) => r.target != null || r.avg > 0);
  const budgeted = rows.reduce((s, r) => s + (r.target ?? 0), 0);
  const hasTargets = Object.keys(draft).length > 0;
  const latestTotal = rows.filter((r) => r.target != null).reduce((s, r) => s + r.latest, 0);

  const save = async () => {
    setSaving(true);
    try {
      const b = await api.call<BudgetSettings>("/api/budget", { method: "PUT", json: { targets: draft } });
      setSaved(b);
      setDraft(b.targets);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <StatGrid cols={4}>
        <StatCell label="Monthly budget" value={hasTargets ? usd0(budgeted) : "—"} sub={hasTargets ? `${Object.keys(draft).length} categories with a target` : "no targets yet"} />
        <StatCell
          label={`${last.label} vs budget`}
          value={hasTargets ? usd0(latestTotal) : "—"}
          tone={hasTargets ? (latestTotal > budgeted ? "neg" : "pos") : "neutral"}
          sub={hasTargets ? `${latestTotal > budgeted ? "over" : "under"} by ${usd0(Math.abs(budgeted - latestTotal))}` : undefined}
        />
        <StatCell label="Typical income" value={usd0(t.typicalIncome)} sub="median month in range" />
        <StatCell
          label="Planned savings rate"
          value={hasTargets && t.typicalIncome > 0 ? formatPercentRatio((t.typicalIncome - budgeted) / t.typicalIncome, 0) : "—"}
          sub={hasTargets ? `${usd0(t.typicalIncome - budgeted)}/mo left of a typical month` : "set targets to see it"}
        />
      </StatGrid>

      {!hasTargets && (
        <Callout
          tone="info"
          title="Start from what you actually spend"
          action={
            <button type="button" className={btn.primary} onClick={() => setDraft(Object.fromEntries(rows.filter((r) => r.typical > 0).map((r) => [r.c, round10(r.typical)])))}>
              Fill with typical months
            </button>
          }
        >
          Targets are seeded from your median month in {slice.label}, rounded to $10. Trim the ones you want to bring down, then save.
        </Callout>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}

      <Card
        title="Targets by category"
        subtitle={`Bars show ${last.label}'s spending against the target (the black tick). "Months over" counts months in ${slice.label} above the target.`}
        actions={
          <>
            {hasTargets && (
              <button type="button" className={btn.ghost} onClick={() => setDraft(Object.fromEntries(rows.filter((r) => r.typical > 0).map((r) => [r.c, round10(r.typical)])))}>
                Reset to typical
              </button>
            )}
            <button type="button" className={btn.primary} disabled={!dirty || saving} onClick={save}>
              {saving ? "Saving…" : dirty ? "Save budget" : "Saved"}
            </button>
          </>
        }
      >
        <div className={table.wrap}>
          <table className={`${table.table} min-w-[56rem]`}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Category</th>
                <th className={`${table.thR} w-32`}>Target / mo</th>
                <th className={`${table.th} w-[22%]`}>{last.label}</th>
                <th className={table.thR}>Spent</th>
                <th className={table.thR}>Typical</th>
                <th className={table.thR}>Average</th>
                <th className={table.thR}>Months over</th>
                <th className={table.thR}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const ratio = r.target ? r.latest / r.target : 0;
                const scale = Math.max(r.latest, r.target ?? 0, 1);
                const status =
                  r.target == null ? null : ratio > 1 ? <Badge tone="neg">over</Badge> : ratio > 0.9 ? <Badge tone="warn">near</Badge> : <Badge tone="pos">on track</Badge>;
                return (
                  <tr key={r.c} className={table.tr}>
                    <td className={`${table.td} font-medium`}>
                      <button type="button" className="flex items-center gap-2 hover:underline" onClick={() => ctx.open({ kind: "category", category: r.c })}>
                        <Dot color={categoryColor(chart, r.c)} />
                        {r.c}
                      </button>
                    </td>
                    <td className={table.tdR}>
                      <MoneyInput
                        size="xs"
                        nullable
                        allowNegative={false}
                        cents={r.target}
                        placeholderCents={round10(r.typical)}
                        ariaLabel={`${r.c} monthly target`}
                        onChange={(v) =>
                          setDraft((d) => {
                            const n = { ...d };
                            if (v == null) delete n[r.c];
                            else n[r.c] = v;
                            return n;
                          })
                        }
                      />
                    </td>
                    <td className={table.td}>
                      <Bar ratio={r.latest / scale} color={r.target != null && ratio > 1 ? "var(--neg)" : categoryColor(chart, r.c)} marker={r.target != null ? r.target / scale : null} />
                    </td>
                    <td className={`${table.tdR} font-medium`}>{usd0(r.latest)}</td>
                    <td className={`${table.tdR} text-muted`}>{usd0(r.typical)}</td>
                    <td className={`${table.tdR} text-muted`}>{usd0(r.avg)}</td>
                    <td className={table.tdR}>{r.target == null ? <span className="text-faint">—</span> : `${r.over} of ${slice.months.length}`}</td>
                    <td className={table.tdR}>{status}</td>
                  </tr>
                );
              })}
              <tr className={`${table.tr} font-semibold`}>
                <td className={table.td}>Total</td>
                <td className={table.tdR}>{hasTargets ? usd0(budgeted) : "—"}</td>
                <td className={table.td} />
                <td className={table.tdR}>{usd0(last.spendingCents)}</td>
                <td className={`${table.tdR} text-muted`}>{usd0(t.typicalSpending)}</td>
                <td className={`${table.tdR} text-muted`}>{usd0(t.avgSpending)}</td>
                <td className={table.tdR} />
                <td className={table.tdR} />
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted">Targets are a plan, saved in the app (not in the browser). They never change any figure — spending always comes from your statements.</p>
      </Card>
    </>
  );
}
