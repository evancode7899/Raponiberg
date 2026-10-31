"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { chartChrome } from "@/components/shell/chartPalette";
import { Badge, Card, StatementTable, table, type TableRow } from "@/components/ui/kit";
import { COST_LINES, LINE_INFO, type CostLine } from "@/lib/car/report";
import { KIND_INFO, type CarKind } from "@/lib/car/settings";
import { formatPercentRatio, usd0 } from "@/lib/formatMoney";
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import type { CarCtx } from "./CarClient";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { carProof, fmtDate, miles, perMile, throughText, usd2 } from "./parts";
import { unswept } from "@/lib/book/proof/clearance";

export function CostsTab({ ctx }: { ctx: CarCtx }) {
  const { report: r, car: s, chart } = ctx;
  const ui = chartChrome(chart);

  const years = useMemo(() => {
    const by = new Map<string, { lines: Record<CostLine, number>; miles: number; months: number }>();
    for (const m of r.months) {
      const y = m.month.slice(0, 4);
      const cur = by.get(y) ?? { lines: Object.fromEntries(COST_LINES.map((l) => [l, 0])) as Record<CostLine, number>, miles: 0, months: 0 };
      for (const l of COST_LINES) cur.lines[l] += m.lines[l];
      cur.miles += m.miles;
      cur.months++;
      by.set(y, cur);
    }
    return [...by.entries()];
  }, [r.months]);

  const used = COST_LINES.filter((l) => years.some(([, y]) => y.lines[l] !== 0));
  const rows: TableRow[] = [
    ...(["DEPRECIATION", "OPERATING", "FIXED"] as const).flatMap((g): TableRow[] => {
      const ls = used.filter((l) => LINE_INFO[l].group === g);
      if (!ls.length) return [];
      return [
        { kind: "heading", label: g === "OPERATING" ? "Driving (per mile)" : g === "FIXED" ? "Owning (fixed)" : "Depreciation", sub: g === "DEPRECIATION" ? (r.depreciation.method === "MARKET" ? "market value" : r.depreciation.method === "SOLD" ? "price less what it sold for" : "planned, per mile") : undefined },
        ...ls.map((l): TableRow => ({ label: LINE_INFO[l].label, indent: true, cells: [...years.map(([yr, y]) => ({ text: usd0(y.lines[l]), proof: carProof(s.id, { span: yr, line: l }, y.lines[l]) })), { text: usd0(r.accrued[l]), proof: carProof(s.id, { span: "toDate", line: l }, r.accrued[l]) }] })),
      ];
    }),
    { label: "Total", total: true, cells: [...years.map(([yr, y]) => ({ text: usd0(Object.values(y.lines).reduce((a, b) => a + b, 0)), proof: carProof(s.id, { span: yr }, Object.values(y.lines).reduce((a, b) => a + b, 0)) })), { text: usd0(r.totals.tco), proof: carProof(s.id, { span: "toDate" }, r.totals.tco) }] },
    { label: "Miles", muted: true, cells: [...years.map(([, y]) => ({ text: miles(y.miles), proof: unswept("miles driven") })), { text: miles(r.odometer.driven), proof: unswept("miles driven") }] },
    {
      label: "Per mile",
      strong: true,
      cells: [...years.map(([yr, y]) => ({ text: y.miles ? perMile(Object.values(y.lines).reduce((a, b) => a + b, 0) / y.miles) : "—", proof: y.miles ? carProof(s.id, { span: yr, per: "mile" }, null) : unswept("no miles to divide by") })), { text: perMile(r.totals.perMile), proof: r.totals.perMile != null ? carProof(s.id, { span: "toDate", per: "mile" }, null) : unswept("no miles to divide by") }],
    },
    { label: "Per month", muted: true, cells: [...years.map(([yr, y]) => ({ text: usd0(Object.values(y.lines).reduce((a, b) => a + b, 0) / y.months), proof: carProof(s.id, { span: yr, per: "month" }, null) })), { text: usd0(r.totals.perMonth), proof: r.totals.perMonth != null ? carProof(s.id, { span: "toDate", per: "month" }, null) : unswept("no months to divide by") }] },
  ];

  const kinds = (Object.keys(KIND_INFO) as CarKind[]).filter((k) => r.cash[k] !== 0);
  const p = s.purchase;
  const a = r.acquisition;
  const premiumChart = r.insurance.premiums.map((x) => ({ label: fmtDate(x.date, "short"), monthly: x.monthlyCents }));

  return (
    <>
      <Card title="By calendar year" subtitle={`Accrued costs in each year you've owned the car (partial years included), through ${throughText(r, s.sale?.date ?? null)}.`}>
        <StatementTable columns={[...years.map(([y]) => y), "To date"]} rows={rows} highlight={[years.length]} minWidth="30rem" />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Paid vs used" subtitle="Cash paid so far against what's been used up. The difference is prepaid (the rest of an insurance term, an annual tax bill).">
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr className={table.head}>
                  <th className={table.th}>Kind</th>
                  <th className={table.thR}>Paid</th>
                  <th className={table.thR}>Used</th>
                  <th className={table.thR}>Prepaid</th>
                </tr>
              </thead>
              <tbody>
                {kinds.map((k) => {
                  const usedC = k === "PAYMENT" ? null : r.accrued[k as CostLine];
                  return (
                    <tr key={k} className={table.tr}>
                      <td className={table.td}>
                        {KIND_INFO[k].label} {k === "PAYMENT" && <Badge tone="neutral">not a cost</Badge>}
                      </td>
                      <td className={table.tdR}>
                        <ProofValue proof={carProof(s.id, { span: "toDate", basis: "cash", line: k }, r.cash[k])}>{usd0(r.cash[k])}</ProofValue>
                      </td>
                      <td className={table.tdR}>{usedC == null ? "—" : <ProofValue proof={carProof(s.id, { span: "toDate", line: k as CostLine }, usedC)}>{usd0(usedC)}</ProofValue>}</td>
                      <td className={`${table.tdR} text-muted`}>{usedC == null ? "—" : usd0(r.cash[k] - usedC)}</td>
                    </tr>
                  );
                })}
                {r.cash.INTEREST > 0 && (
                  <tr className={table.tr}>
                    <td className={table.td}>Financing interest</td>
                    <td className={table.tdR}>
                      <ProofValue proof={carProof(s.id, { span: "toDate", basis: "cash", line: "INTEREST" }, r.cash.INTEREST)}>{usd0(r.cash.INTEREST)}</ProofValue>
                    </td>
                    <td className={table.tdR}>
                      <ProofValue proof={carProof(s.id, { span: "toDate", line: "INTEREST" }, r.accrued.INTEREST)}>{usd0(r.accrued.INTEREST)}</ProofValue>
                    </td>
                    <td className={`${table.tdR} text-muted`}>—</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">Car payments (down payment, loan payments) are how the purchase was paid for; the purchase itself is counted through depreciation and interest.</p>
        </Card>

        <Card title="Purchase" subtitle={s.vehicle.purchaseDate ? `Bought ${fmtDate(s.vehicle.purchaseDate)} at ${miles(s.vehicle.purchaseOdometer)} miles.` : undefined}>
          <div className={table.wrap}>
            <table className={table.table}>
              <tbody>
                {(
                  [
                    ["Vehicle", p.priceCents],
                    ["Dealer fees", p.feesCents],
                    ["Extended warranty", p.warrantyCents],
                    ["Registration", p.registrationCents],
                    ["Sales tax", p.salesTaxCents],
                  ] as const
                ).map(([l, c]) => (
                  <tr key={l} className={table.tr}>
                    <td className={table.td}>{l}</td>
                    <td className={table.tdR}>{usd2(c)}</td>
                  </tr>
                ))}
                <tr className="border-t border-line-strong font-semibold">
                  <td className={table.td}>All-in purchase</td>
                  <td className={table.tdR}>{usd2(a.cents)}</td>
                </tr>
                <tr className={table.tr}>
                  <td className={table.td}>Recoverable (vehicle + warranty)</td>
                  <td className={table.tdR}>{usd2(a.recoverableCents)}</td>
                </tr>
                <tr className={table.tr}>
                  <td className={table.td}>Dead loss on day one (fees, tax, registration)</td>
                  <td className={table.tdR}>
                    {usd2(a.sunkCents)} <span className="text-muted">({a.deadLossShare == null ? "—" : formatPercentRatio(a.deadLossShare, 1)})</span>
                  </td>
                </tr>
                <tr className={table.tr}>
                  <td className={table.td}>Down payment · financed</td>
                  <td className={table.tdR}>
                    {usd0(p.downPaymentCents)} · {usd0(a.financedCents)}
                  </td>
                </tr>
                <tr className={table.tr}>
                  <td className={table.td}>Interest paid{p.loanPaidOffDate ? ` (paid off ${fmtDate(p.loanPaidOffDate)})` : ""}</td>
                  <td className={table.tdR}>{usd2(a.interestCents)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card
        title="Insurance premiums"
        subtitle={`${r.insurance.renewsOn ? `Current term ends ${fmtDate(r.insurance.renewsOn)}; expect about ${usd0(r.insurance.expectedCents)} then.` : "Each premium and what it works out to a month."}${r.insurance.premiums.length > 12 ? " The latest 12 are listed." : ""}`}
      >
        {r.insurance.premiums.length === 0 ? (
          <p className="text-xs text-muted">No insurance yet: log a premium, or it&apos;s picked up from your statements (auto insurers are recognized by name).</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr className={table.head}>
                    <th className={table.th}>Paid</th>
                    <th className={table.thR}>Premium</th>
                    <th className={table.thR}>Term</th>
                    <th className={table.thR}>Per month</th>
                    <th className={table.thR}>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {[...r.insurance.premiums].reverse().slice(0, 12).map((x, i) => (
                    <tr key={i} className={table.tr}>
                      <td className={table.td}>
                        {fmtDate(x.date)} {x.source === "STATEMENT" && <Badge tone="info">statement</Badge>}
                      </td>
                      <td className={table.tdR}>{usd2(x.cents)}</td>
                      <td className={table.tdR}>{x.months} mo</td>
                      <td className={table.tdR}>{usd0(x.monthlyCents)}</td>
                      <td className={`${table.tdR} ${x.changeShare == null ? "" : x.changeShare > 0.005 ? "text-neg" : x.changeShare < -0.005 ? "text-pos" : "text-muted"}`}>
                        {x.changeShare == null ? "—" : `${x.changeShare > 0 ? "+" : ""}${(x.changeShare * 100).toFixed(1)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="h-48">
              <RechartsResponsive>
                <BarChart data={premiumChart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid {...ui.grid} />
                  <XAxis dataKey="label" {...ui.xAxis} />
                  <YAxis {...ui.yAxis} tickFormatter={(v: number) => `$${Math.round(v / 100)}`} />
                  <Tooltip {...ui.tooltip} formatter={(v) => [`${usd0(Number(v))}/mo`, "Premium per month"]} />
                  <Bar dataKey="monthly" name="Per month" fill={chart.series[0]} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
                </BarChart>
              </RechartsResponsive>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
