"use client";

import { useChartPalette } from "@/components/shell/chartPalette";
import { Callout, Card, PageBody, StatCell, StatGrid, table, useSavedState } from "@/components/ui/kit";
import { formatPercentRatio, formatUsd } from "@/lib/formatMoney";
import { comparePrepayVsInvest, loanMonthToCalendar, monteCarlo, type PathSeries } from "@/lib/mortgage/prepayVsInvest";
import { apiSecretHeaders } from "@/components/ledger/useApi";
import { withLinks, type LinkedKey } from "@/lib/mortgage/inputs";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { BalancesChart, GapChart, INVEST, NetWorthChart, OpportunityChart, PREPAY, SensitivityChart, type YearPoint } from "./MortgageCharts";
import { MortgageInputsPanel } from "./MortgageInputsPanel";
import { defaultInputs, lumpLabel, migrateLegacy, MONTHS, RETIRED_KEYS, STORAGE_KEY, toPlan, type MortgageInputs } from "./inputs";

/** The linked figures (api/mortgage/links): each with where it comes from. */
export type MortgageLinks = Partial<Record<LinkedKey, { value: number; from: string } | null>>;

/** A chance of investing winning inside this range is a coin flip, not a verdict. */
const TOSS_UP = [0.45, 0.55] as const;

const signed = (v: number) => (v > 0 ? `+${formatUsd(v)}` : formatUsd(v));
const span = (months: number) => {
  const y = Math.floor(months / 12);
  const m = months % 12;
  return y && m ? `${y}y ${m}m` : y ? `${y} yr` : `${m} mo`;
};

export function MortgageClient() {
  const chart = useChartPalette();
  const [ins, setIns] = useSavedState<MortgageInputs>(STORAGE_KEY, defaultInputs);
  useEffect(() => {
    const legacy = migrateLegacy();
    if (legacy) setIns((x) => ({ ...x, ...legacy }));
  }, [setIns]);
  useEffect(() => {
    if (!RETIRED_KEYS.some((k) => k in ins)) return;
    setIns((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !(RETIRED_KEYS as readonly string[]).includes(k))) as MortgageInputs);
  }, [ins, setIns]);
  const set = (p: Partial<MortgageInputs>) => setIns((x) => ({ ...x, ...p }));
  // The forecast's and the tax engine's figures, used wherever nothing is typed over them.
  const [links, setLinks] = useState<MortgageLinks>({});
  useEffect(() => {
    fetch("/api/mortgage/links", { headers: apiSecretHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { links?: MortgageLinks } | null) => j?.links && setLinks(j.links))
      .catch(() => {});
  }, []);
  const saved = ins;
  // What the model and every figure run on: the saved inputs with the links put in.
  const eff = useMemo(() => withLinks(saved, links), [saved, links]);

  const plan = useMemo(() => toPlan(eff), [eff]);
  const labels = useMemo(() => Object.fromEntries(ins.lumps.map((r) => [r.id, lumpLabel(r)])), [ins.lumps]);
  const cmp = useMemo(() => comparePrepayVsInvest(plan, labels), [plan, labels]);
  // The simulation is the heavy part: let it trail slider drags.
  const mcPlan = useDeferredValue(plan);
  const mcVol = useDeferredValue(ins.volatility);
  const mc = useMemo(() => monteCarlo(mcPlan, mcVol), [mcPlan, mcVol]);

  const H = cmp.horizonMonths;
  const { invest, prepay } = cmp;
  const defl = (m: number) => (ins.realDollars ? Math.pow(1 + eff.inflation, m / 12) : 1);
  /** A value at month m (a balance), in the display unit. */
  const at = (a: Float64Array, m = H) => a[m]! / defl(m);
  /** A running total through the horizon: each month's amount deflated by its own month. */
  const flow = (a: Float64Array) => {
    let t = 0;
    for (let m = 1; m <= H; m++) t += (a[m]! - a[m - 1]!) / defl(m);
    return t;
  };
  const advantage = cmp.advantage / defl(H);
  const hasChoice = plan.extraMonthly > 0 || plan.lumps.some((l) => l.month <= H);
  const unit = ins.realDollars ? "today's dollars" : "future dollars";

  const label = (y: number) => {
    const m = Math.round(y * 12);
    if (m === 0) return "Start";
    const c = loanMonthToCalendar(m, ins.startYear, ins.startMonth);
    return `Year ${+y.toFixed(1)} · ${MONTHS[c.month - 1]} ${c.year}`;
  };

  const rows: YearPoint[] = useMemo(() => {
    const months: number[] = [];
    for (let m = 0; m < H; m += 12) months.push(m);
    months.push(H);
    const band = new Map(mc.bands.map((b) => [b.month, b]));
    return months.map((m) => {
      const d = ins.realDollars ? Math.pow(1 + eff.inflation, m / 12) : 1;
      const b = m === 0 ? { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 } : band.get(m);
      return {
        year: m / 12,
        investNW: invest.netWorth[m]! / d,
        prepayNW: prepay.netWorth[m]! / d,
        gap: (invest.netWorth[m]! - prepay.netWorth[m]!) / d,
        investBal: invest.balance[m]! / d,
        prepayBal: prepay.balance[m]! / d,
        investInv: invest.investedNet[m]! / d,
        prepayInv: prepay.investedNet[m]! / d,
        ...(b ? { band90: [b.p10 / d, b.p90 / d] as [number, number], band50: [b.p25 / d, b.p75 / d] as [number, number], p50: b.p50 / d } : {}),
      };
    });
  }, [H, invest, prepay, mc, ins.realDollars, eff.inflation]);

  const sens = cmp.sensitivity.map((p) => ({ rate: p.rate, advantage: p.advantage / defl(H) }));
  const opp = cmp.opportunityCost.map((o) => ({ key: o.key, label: o.label, cost: o.cost / defl(H) }));
  const hMc = mc.bands[mc.bands.length - 1];
  const mcFresh = hMc?.month === H;
  const sooner = prepay.payoffMonth !== null ? (invest.payoffMonth ?? Math.round(plan.termMonths)) - prepay.payoffMonth : null;
  const interestSaved = flow(invest.interest) - flow(prepay.interest);
  const deductionLost = flow(invest.deduction) - flow(prepay.deduction);
  const hasLumps = plan.lumps.some((l) => l.month <= H);
  const winner = advantage >= 0 ? INVEST : PREPAY;
  const tossUp = mcFresh && mc.chanceInvestWins >= TOSS_UP[0] && mc.chanceInvestWins <= TOSS_UP[1];

  return (
    <PageBody>
      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <MortgageInputsPanel ins={eff} typed={ins.typed ?? {}} links={links} set={set} payment={cmp.monthlyPayment} onReset={() => setIns(defaultInputs())} />

        <div className="flex min-w-0 flex-col gap-4">
          {!hasChoice ? (
            <Callout tone="info" title="Nothing to compare yet">
              Add an extra monthly amount or a lump sum: the page compares sending that money to the loan against investing it.
            </Callout>
          ) : (
            <Callout
              tone={advantage >= 0 && !tossUp ? "good" : "info"}
              title={
                tossUp
                  ? `Too close to call: ${advantage >= 0 ? "investing" : "paying down"} leads by just ${formatUsd(Math.abs(advantage))} after ${ins.horizonYears} years`
                  : `${winner} comes out ${formatUsd(Math.abs(advantage))} ahead after ${ins.horizonYears} years`
              }
            >
              {cmp.breakEvenReturn !== null
                ? `Investing has to earn more than ${formatPercentRatio(cmp.breakEvenReturn, 2)} a year to beat paying down a ${formatPercentRatio(ins.rate, 3)} loan with these taxes; you assumed ${formatPercentRatio(eff.investReturn, 2)}. `
                : ""}
              {mcFresh && `In ${Math.round(mc.chanceInvestWins * 100)}% of ${mc.paths} simulated markets investing ended ahead. `}
              {tossUp
                ? `Anything from ${formatPercentRatio(TOSS_UP[0], 0)} to ${formatPercentRatio(TOSS_UP[1], 0)} is a coin flip: decide on liquidity and risk, not this gap.`
                : "Paying down is a guaranteed return; investing is not — weigh the range below, not just the expected line."}
            </Callout>
          )}

          <StatGrid cols={4}>
            <StatCell
              label="Invest − pay down"
              value={hasChoice ? signed(advantage) : "—"}
              tone={advantage > 0 ? "pos" : advantage < 0 ? "warn" : "neutral"}
              sub={`net worth after ${ins.horizonYears} yr, ${unit}`}
            />
            <StatCell
              label="Break-even return"
              value={cmp.breakEvenReturn !== null && hasChoice ? formatPercentRatio(cmp.breakEvenReturn, 2) : "—"}
              sub="investing wins above this"
            />
            <StatCell
              label="Chance investing wins"
              value={hasChoice && mcFresh ? `${Math.round(mc.chanceInvestWins * 100)}%` : "—"}
              tone={tossUp ? "neutral" : mc.chanceInvestWins > 0.5 ? "pos" : "warn"}
              sub={`${formatPercentRatio(ins.volatility, 0)} volatility · ${mc.paths} markets`}
            />
            <StatCell
              label="Paying down saves"
              value={formatUsd(interestSaved)}
              sub={sooner !== null && sooner > 0 ? `interest · loan gone ${span(sooner)} sooner` : "interest by the horizon"}
            />
          </StatGrid>

          <Card
            title="How far ahead investing is — and how sure"
            subtitle="The solid line is the gap at your expected return. Shaded: where the gap lands in the middle 50% and 80% of simulated markets. Below zero, paying down would have been better."
          >
            <GapChart rows={rows} chart={chart} label={label} />
            {mcFresh && hMc && hasChoice && (
              <p className="mt-2 text-xs text-muted">
                After {ins.horizonYears} years: a bad market (10th percentile) leaves investing <span className="num font-medium text-fg">{signed(hMc.p10 / defl(H))}</span>, a typical one{" "}
                <span className="num font-medium text-fg">{signed(hMc.p50 / defl(H))}</span>, a good one (90th) <span className="num font-medium text-fg">{signed(hMc.p90 / defl(H))}</span>.
              </p>
            )}
          </Card>

          <div className="grid min-w-0 gap-4 xl:grid-cols-2">
            <Card title="Where the money sits" subtitle={`Solid: investments, net of the tax due if sold. Dashed: what's left on the loan. ${unit[0]!.toUpperCase()}${unit.slice(1)}.`}>
              <BalancesChart rows={rows} chart={chart} label={label} />
            </Card>
            <Card title="Net worth on each path" subtitle="Investments minus the loan. The home is the same on both paths, so it's left out.">
              <NetWorthChart rows={rows} chart={chart} payoffYear={prepay.payoffMonth !== null && prepay.payoffMonth < plan.termMonths ? prepay.payoffMonth / 12 : null} label={label} />
            </Card>
          </div>

          <Card
            title="How much the return matters"
            subtitle={`Invest − pay down after ${ins.horizonYears} years at each steady return. Right of the break-even, investing wins; left of it, paying down does.`}
          >
            <SensitivityChart rows={sens} chart={chart} assumed={eff.investReturn} breakEven={cmp.breakEvenReturn} mortgageRate={ins.rate} />
          </Card>

          {opp.length > 0 && (
            <Card
              title="Opportunity cost of each prepayment"
              subtitle={`What sending each source of cash to the loan instead of investing it changes your net worth by after ${ins.horizonYears} years (each on its own; everything else invested). Blue: investing it wins. Orange: the loan wins.`}
            >
              <OpportunityChart rows={opp} chart={chart} />
              {hasLumps && plan.extraMonthly > 0 && (
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  {(
                    [
                      ["Invest everything", cmp.matrix.investAll],
                      ["Extra to the loan, lumps invested", cmp.matrix.prepayExtraOnly],
                      ["Lumps to the loan, extra invested", cmp.matrix.prepayLumpsOnly],
                      ["Everything to the loan", cmp.matrix.prepayAll],
                    ] as const
                  ).map(([name, v]) => {
                    const best = Math.max(...Object.values(cmp.matrix));
                    const isBest = Math.abs(v - best) < 0.5;
                    return (
                      <div key={name} className={`rounded-md border px-3 py-2 ${isBest ? "border-pos/40 bg-pos-soft" : "border-line bg-surface-2"}`}>
                        <div className="text-fg-2">{name}</div>
                        <div className="num mt-0.5 text-sm font-semibold text-fg">{formatUsd(v / defl(H))}</div>
                        <div className="num text-[11px] text-muted">{isBest ? "best" : `${formatUsd((v - best) / defl(H))} vs best`}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          )}

          <Ledger invest={invest} prepay={prepay} H={H} at={at} flow={flow} unit={unit} deductionLost={deductionLost} />
          <YearTable invest={invest} prepay={prepay} H={H} defl={defl} label={label} />
          <Method />
        </div>
      </div>
    </PageBody>
  );
}

/** Every dollar on both paths at the horizon — the audit trail behind the headline. */
function Ledger({
  invest,
  prepay,
  H,
  at,
  flow,
  unit,
  deductionLost,
}: {
  invest: PathSeries;
  prepay: PathSeries;
  H: number;
  at: (a: Float64Array, m?: number) => number;
  flow: (a: Float64Array) => number;
  unit: string;
  deductionLost: number;
}) {
  const taxOnSale = (s: PathSeries) => at(s.invested) - at(s.investedNet);
  const lines: { label: string; get: (s: PathSeries) => number; strong?: boolean; hint?: string }[] = [
    { label: "Cash sent to the loan", get: (s) => flow(s.toLoan) },
    { label: "Cash invested", get: (s) => flow(s.toInvest) },
    { label: "Total cash out of pocket", get: (s) => flow(s.toLoan) + flow(s.toInvest), strong: true, hint: "Identical on both paths by construction." },
    { label: "Interest paid", get: (s) => flow(s.interest) },
    { label: "Tax saved by the deduction (invested)", get: (s) => flow(s.deduction) },
    { label: "Tax on dividends", get: (s) => flow(s.dividendTax) },
    { label: "Investments", get: (s) => at(s.invested) },
    { label: "Tax due if sold", get: (s) => -taxOnSale(s) },
    { label: "Loan left", get: (s) => -at(s.balance) },
    { label: "Net worth", get: (s) => at(s.netWorth), strong: true },
  ];
  return (
    <Card title="The ledger" subtitle={`Totals by the horizon, ${unit} (in today's dollars each month counts at its own date). Cash out of pocket matches on both paths, so the net-worth gap is purely where the dollars went.`}>
      <div className="overflow-x-auto">
        <table className={`${table.table} min-w-[520px]`}>
          <thead className={table.head}>
            <tr>
              <th className={table.th} />
              <th className={table.thR}>{INVEST}</th>
              <th className={table.thR}>{PREPAY}</th>
              <th className={table.thR}>Difference</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const a = l.get(invest);
              const b = l.get(prepay);
              return (
                <tr key={l.label} className={`${table.tr} ${l.strong ? "font-semibold" : ""}`} title={l.hint}>
                  <td className={table.td}>{l.label}</td>
                  <td className={table.tdR}>{formatUsd(a)}</td>
                  <td className={table.tdR}>{formatUsd(b)}</td>
                  <td className={`${table.tdR} ${Math.abs(a - b) < 0.5 ? "text-faint" : ""}`}>{Math.abs(a - b) < 0.5 ? "same" : signed(a - b)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {deductionLost > 0.5 && <p className="mt-2 text-[11px] text-muted">Paying down forgoes {formatUsd(deductionLost)} of deduction value — part of why its interest saving overstates its real benefit.</p>}
      <p className="mt-1 text-[11px] text-faint">Month {H}: figures include everything through that payment.</p>
    </Card>
  );
}

function YearTable({ invest, prepay, H, defl, label }: { invest: PathSeries; prepay: PathSeries; H: number; defl: (m: number) => number; label: (y: number) => string }) {
  const months: number[] = [];
  for (let m = 12; m < H; m += 12) if (m <= 60 || m % 60 === 0) months.push(m);
  months.push(H);
  return (
    <Card title="Year by year">
      <div className="max-h-[360px] overflow-auto">
        <table className={`${table.table} min-w-[720px]`}>
          <thead className={table.head}>
            <tr>
              <th className={table.th}>When</th>
              <th className={table.thR}>Loan · invest</th>
              <th className={table.thR}>Investments · invest</th>
              <th className={table.thR}>Loan · pay down</th>
              <th className={table.thR}>Investments · pay down</th>
              <th className={table.thR}>Invest − pay down</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => {
              const d = defl(m);
              const gap = (invest.netWorth[m]! - prepay.netWorth[m]!) / d;
              return (
                <tr key={m} className={table.tr}>
                  <td className={table.td}>{label(m / 12)}</td>
                  <td className={table.tdR}>{formatUsd(invest.balance[m]! / d)}</td>
                  <td className={table.tdR}>{formatUsd(invest.investedNet[m]! / d)}</td>
                  <td className={table.tdR}>{formatUsd(prepay.balance[m]! / d)}</td>
                  <td className={table.tdR}>{formatUsd(prepay.investedNet[m]! / d)}</td>
                  <td className={`${table.tdR} font-semibold ${gap >= 0 ? "text-pos" : "text-neg"}`}>{signed(gap)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Method() {
  return (
    <Card title="How the math works">
      <ul className="list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-fg-2">
        <li>
          <b>Same cash, different destination.</b> Both paths pay the scheduled payment, the extra and every lump sum. Paying down sends the extra and the lumps to the
          principal; investing puts them in a brokerage account. When a loan is gone, its whole payment is invested from then on — so the paths can be compared at any month.
        </li>
        <li>
          <b>Net worth</b> = investments − the capital-gains tax due if they were sold − the loan balance. The house is identical on both paths and cancels out.
        </li>
        <li>
          <b>Timing.</b> A lump lands at the start of its month (it saves that month&apos;s interest, or earns that month&apos;s return); the monthly extra lands at the end.
          The rate is applied monthly (rate ÷ 12); the investment return compounds to the stated annual figure. Lumps don&apos;t re-amortize the loan: the payment stays and
          the loan ends sooner.
        </li>
        <li>
          <b>Investment taxes.</b> In a taxable account the dividend yield is taxed each year as it&apos;s paid; the rest of the return is unrealized and taxed only when sold.
          The rate is federal (long-term gains + NIIT) plus Connecticut, which taxes gains as ordinary income. A tax-free account pays neither.
        </li>
        <li>
          <b>The deduction.</b> Each calendar year the interest on up to the debt cap is added to your other itemized deductions (state income and property tax up to the
          SALT cap, plus charity); the tax saved is only what that pushes you above the standard deduction, times your federal marginal rate — Connecticut has no
          itemized deductions — and it&apos;s invested at year end. As the balance falls the deduction often stops being worth anything — and
          paying down hastens that.
        </li>
        <li>
          <b>The range of outcomes</b> comes from 400 simulated markets with lognormal monthly returns: the median compounds at your expected return, with the volatility you set.
          Both strategies see the same market each run.
        </li>
        <li>
          <b>Left out:</b> PMI (prepaying can end it sooner — a point for paying down), refinancing, liquidity (money in the house is hard to get back out), and the 0%
          long-term gains bracket. Guidance only, not tax or investment advice.
        </li>
      </ul>
    </Card>
  );
}
