"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { BlockedNote, BlockedValue } from "@/components/ledger/Blocked";
import { Card, QualityBadge } from "@/components/ledger/LedgerBits";
import { chartChrome, useChartPalette } from "@/components/shell/chartPalette";
import { Badge, btn, Callout, StatCell, StatGrid } from "@/components/ui/kit";
import type { BlockerRef } from "@/lib/book/reports/blockerRef";
import { formatUsd } from "@/lib/formatMoney";
import type { AnnualProfileReport, PersonYear, YearCash, YearNetWorth, YearProfile } from "@/lib/profile/buildAnnualProfile";
import { useMemo } from "react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { axisUsd, blockedCell, pct, usd, YearTable, type Cell, type TableRow } from "./profileUi";

const m = (cents: number | null | undefined, title?: string): Cell => ({ text: usd(cents), title });

/** Cells from one section of each year: the figure when proven, else why not. */
const payCell = (y: YearProfile, fn: (people: PersonYear[]) => Cell) => (y.people ? fn(y.people) : blockedCell(y.blockers.pay));
const cashCell = (y: YearProfile, fn: (c: YearCash) => Cell) => (y.cash ? fn(y.cash) : blockedCell(y.blockers.cash));
const nwCell = (y: YearProfile, fn: (n: YearNetWorth) => Cell) => (y.netWorth ? fn(y.netWorth) : blockedCell(y.blockers.netWorth));
/** A pay figure, tagged partial when part of the year is known only from year-to-date totals. */
const payFig = (p: PersonYear, cents: number, title?: string): Cell =>
  p.partial.length
    ? {
        text: (
          <>
            {usd(cents)} <Badge tone="warn">partial</Badge>
          </>
        ),
        title: [title, ...p.partial].filter(Boolean).join("\n"),
      }
    : m(cents, title || undefined);

export function AnnualStatement({ r, onGo }: { r: AnnualProfileReport; onGo: () => void }) {
  const ys = r.years;
  const cols = ys.map((y) => y.label);
  const highlight = ys.map((y, i) => (y.isCurrent ? i : -1)).filter((i) => i >= 0);
  const full = [...ys].reverse().find((y) => !y.isCurrent);
  const cur = ys.find((y) => y.isCurrent);
  const rows = useMemo(() => statementRows(r), [r]);
  const latest = cur ?? full;
  const value = (v: number | null | undefined, blockers: BlockerRef[] | undefined, fmt: (n: number) => string = (n) => usd(n)) =>
    v != null ? fmt(v) : blockers?.length ? <BlockedValue blockers={blockers} /> : "—";
  const blockedYears = ys.filter((y) => Object.values(y.blockers).some((b) => b.length > 0));
  const untagged = full?.cash ? full.oneOffCandidates.filter((c) => !c.tagged) : [];
  const untaggedCents = untagged.reduce((s, c) => s + c.cents, 0);

  return (
    <div className="flex flex-col gap-4">
      {blockedYears.length > 0 && full && (
        <BlockedNote
          what={`every figure for ${full.year}`}
          blockers={[...new Map([...full.blockers.pay, ...full.blockers.cash, ...full.blockers.netWorth, ...full.blockers.change].map((b) => [b.id, b])).values()]}
        />
      )}
      <StatGrid cols={6}>
        <StatCell
          label="Net worth"
          value={value(latest?.netWorth?.netWorth, latest?.blockers.netWorth)}
          sub={
            <>
              {latest ? `as of ${latest.netWorthAsOf}` : ""}
              {latest?.netWorth && <QualityBadge quality={latest.netWorth.quality} />}
            </>
          }
        />
        <StatCell label="Liquid net worth" value={value(latest?.netWorth?.liquid, latest?.blockers.netWorth)} sub="cash + taxable investments − card debt" />
        <StatCell label={`Change ${cur ? `${cur.year} YTD` : ""}`} value={value(cur?.change?.cents, cur?.blockers.change)} sub={cur?.change?.pct != null ? `${pct(cur.change.pct)} since Dec 31` : undefined} />
        <StatCell label={`Cash saved ${full?.year ?? ""}`} value={value(full?.cash?.waterfall.saved, full?.blockers.cash)} sub={full?.cash ? `${pct(full.cash.waterfall.savingsOfGross)} of gross pay` : undefined} />
        <StatCell label={`Cash tax rate ${full?.year ?? ""}`} value={value(full?.cash?.waterfall.cashTaxRate, full?.blockers.cash, (n) => pct(n))} sub="withheld + paid − refunds, ÷ gross" />
        <StatCell
          label={`Living cost ${full?.year ?? ""}`}
          value={value(full?.cash?.waterfall.living, full?.blockers.cash)}
          sub={cur?.cash ? `${usd(cur.cash.waterfall.living)} so far in ${cur.year}` : undefined}
        />
      </StatGrid>

      {full?.cash && untagged.length > 0 && (
        <Callout
          tone="info"
          title={`${full.year} living expenses include ${usd(untaggedCents)} in single charges of $1,500 or more`}
          action={
            <button type="button" className={btn.secondary} onClick={onGo}>
              Review one-offs
            </button>
          }
        >
          {untagged.length} big charge{untagged.length === 1 ? "" : "s"} ({untagged.slice(0, 3).map((c) => c.payee).join(", ")}
          {untagged.length > 3 ? "…" : ""}) count as a normal year&apos;s living cost. If any were one-offs, marking them moves them to the one-off line here and
          lowers the spending your FIRE plan starts from.
        </Callout>
      )}

      <Card
        title="Financial profile by calendar year"
        subtitle="Cash paid and kept (tax basis) → year-end position → what moved net worth. Every figure comes from pay stubs and statements that pass the integrity checks; anything that can't be proven says why (hover it)."
      >
        <YearTable columns={cols} rows={rows} highlight={highlight} />
        {ys.some((y) => y.people?.some((p) => p.partial.length)) && (
          <ul className="mt-3 list-disc pl-5 text-[11px] text-muted">
            {ys.flatMap((y) => (y.people ?? []).flatMap((p) => p.partial.map((note) => <li key={`${y.year}-${note}`}>{y.label}: {note}</li>)))}
          </ul>
        )}
        {ys.some((y) => y.isCurrent) && (
          <p className="mt-3 text-[11px] text-muted">
            {cur!.label}: cash through {cur!.asOf} (the last day every bank and card statement covers); net worth as of {cur!.netWorthAsOf}.
          </p>
        )}
      </Card>

      <BridgeChart years={ys} />
      <LivingBreakdown years={ys} highlight={highlight} />
    </div>
  );
}

function statementRows(r: AnnualProfileReport): TableRow[] {
  const ys = r.years;
  const persons = r.persons;
  const per = (fn: (y: YearProfile) => Cell) => ys.map(fn);
  const person = (people: PersonYear[], id: string) => people.find((p) => p.personId === id)!;
  const rows: TableRow[] = [];

  const ages = persons.filter((p) => ys.some((y) => y.people && person(y.people, p.id).age != null));
  for (const p of ages) rows.push({ label: `Age — ${p.name}`, muted: true, cells: per((y) => ({ text: (y.people && person(y.people, p.id).age) ?? "" })) });

  // ------------------------------------------------------------ cash
  rows.push({ kind: "heading", label: "Cash flow (tax basis)", sub: "paid during the calendar year" });
  for (const p of persons) {
    rows.push({ label: `${p.name} — salary`, indent: true, cells: per((y) => payCell(y, (ps) => payFig(person(ps, p.id), person(ps, p.id).salary, person(ps, p.id).employers.join(" + ")))) });
    rows.push({ label: `${p.name} — bonus`, indent: true, cells: per((y) => payCell(y, (ps) => payFig(person(ps, p.id), person(ps, p.id).bonus))) });
  }
  rows.push({
    label: "Investment & other income",
    indent: true,
    cells: per((y) =>
      cashCell(y, (c) => ({
        text: usd(c.waterfall.otherIncome),
        title: `Bank interest ${usd(c.otherIncomeDetail.interest)} · brokerage dividends & distributions ${usd(c.otherIncomeDetail.dividends)} · other ${usd(c.otherIncomeDetail.other)}`,
      })),
    ),
  });
  rows.push({ label: "Total gross cash paid", strong: true, cells: per((y) => cashCell(y, (c) => m(c.waterfall.grossCash))) });
  rows.push({
    label: "Less: taxes withheld",
    indent: true,
    help: "Federal, Social Security, Medicare, state and local income tax and state payroll programs, from pay stubs.",
    cells: per((y) => cashCell(y, (c) => m(-c.waterfall.withholding))),
  });
  rows.push({ label: "Less: additional taxes paid", indent: true, help: "Estimated and balance-due payments in the bank ledger (IRS, CT DRS, NYS).", cells: per((y) => cashCell(y, (c) => m(-c.waterfall.additionalTaxes))) });
  rows.push({ label: "Plus: tax refunds", indent: true, cells: per((y) => cashCell(y, (c) => m(c.waterfall.refunds))) });
  rows.push({
    label: "Less: benefits & other deductions",
    indent: true,
    help: "Medical/dental/vision premiums, FSA and after-tax deductions on pay stubs. 401(k) and HSA deferrals are not subtracted: they're savings.",
    cells: per((y) => cashCell(y, (c) => m(-c.waterfall.otherDeductions))),
  });
  rows.push({ label: "Plus: employer retirement & HSA money", indent: true, help: "Employer 401(k) and HSA contributions on pay stubs.", cells: per((y) => cashCell(y, (c) => m(c.waterfall.employer))) });
  rows.push({ label: "Total net cash", strong: true, cells: per((y) => cashCell(y, (c) => m(c.waterfall.netCash))) });
  rows.push({
    label: "Less: living expenses",
    indent: true,
    help: "Every expense on bank and card statements except income-tax payments and one-offs, net of reimbursements received (Zelle/Venmo and on pay stubs). The FIRE plan starts from the latest full year of this line.",
    cells: per((y) => cashCell(y, (c) => m(-c.waterfall.living))),
  });
  rows.push({ label: "Less: one-off expenses", indent: true, help: "Expenses marked one-off (a wedding, a move, a car) on the One-off expenses tab or Cash flow › Spending. They still count toward cash saved; they're only kept out of living expenses.", cells: per((y) => cashCell(y, (c) => m(-c.waterfall.nonRecurring))) });
  rows.push({ label: "Total cash saved", total: true, cells: per((y) => cashCell(y, (c) => m(c.waterfall.saved))) });
  rows.push({ label: "Cash tax rate", muted: true, cells: per((y) => cashCell(y, (c) => ({ text: pct(c.waterfall.cashTaxRate) }))) });
  rows.push({ label: "Savings % of gross pay", muted: true, cells: per((y) => cashCell(y, (c) => ({ text: pct(c.waterfall.savingsOfGross) }))) });
  rows.push({ label: "Savings % of net pay", muted: true, cells: per((y) => cashCell(y, (c) => ({ text: pct(c.waterfall.savingsOfNet) }))) });

  // ------------------------------------------------------------ net worth
  rows.push({ kind: "heading", label: "Net worth", sub: "financial position at year end, from statements" });
  const b = (k: keyof YearNetWorth["buckets"], label: string, sign = 1, help?: string) => rows.push({ label, indent: true, help, cells: per((y) => nwCell(y, (n) => m(sign * n.buckets[k]))) });
  b("CASH", "Cash & cash equivalents");
  b("LIQUID", "Liquid investments", 1, "Taxable brokerage accounts.");
  b("ILLIQUID", "Illiquid investments", 1, "401(k)s, IRAs, 529, HSA, private funds.");
  rows.push({ label: "Gross assets", strong: true, cells: per((y) => nwCell(y, (n) => m(n.grossAssets))) });
  b("SHORT_DEBT", "Credit card balances", -1, "Card balances on statements.");
  rows.push({ label: "Gross debt", strong: true, cells: per((y) => nwCell(y, (n) => m(-n.grossDebt))) });
  rows.push({
    label: "Net worth",
    total: true,
    cells: per((y) =>
      nwCell(y, (n) => ({
        text: (
          <>
            {usd(n.netWorth)}
            <QualityBadge quality={n.quality} />
          </>
        ),
      })),
    ),
  });
  rows.push({ label: "Liquid net worth", muted: true, cells: per((y) => nwCell(y, (n) => m(n.liquid))) });
  rows.push({ label: "Illiquid net worth", muted: true, cells: per((y) => nwCell(y, (n) => m(n.illiquid))) });
  if (ys.some((y) => y.netWorth && y.netWorth.inTransit !== 0)) {
    rows.push({
      label: "Includes transfers in transit",
      muted: true,
      help: "Money between two of your accounts on Dec 31 (e.g. a rollover that left Dec 31 and landed in January), counted in the bucket it was headed for.",
      cells: per((y) => nwCell(y, (n) => m(n.inTransit))),
    });
  }
  rows.push({ label: "Change in net worth ($)", muted: true, cells: per((y) => (y.change ? m(y.change.cents) : blockedCell(y.blockers.change))) });
  rows.push({ label: "Change in net worth (%)", muted: true, cells: per((y) => (y.change ? { text: pct(y.change.pct, 0) } : blockedCell(y.blockers.change))) });

  // ------------------------------------------------------------ bridge
  rows.push({ kind: "heading", label: "What changed net worth", sub: "from the cash saved above to the change in net worth" });
  const bridgeBlockers = (y: YearProfile) => [...new Map([...y.blockers.cash, ...y.blockers.change].map((x) => [x.id, x])).values()];
  const br = (k: keyof NonNullable<YearProfile["bridge"]>, label: string, help: string) =>
    rows.push({ label, indent: true, help, cells: per((y) => (y.bridge ? m(y.bridge[k]) : blockedCell(bridgeBlockers(y)))) });
  br("cashSaved", "Cash saved", "Total cash saved, from the paycheck math above.");
  br("investmentGrowth", "Investment growth, net of fees", "Market change in every account (dividends already counted as income above are taken out).");
  br("outsideMoney", "Money from outside the tracked accounts", "Partner money before finances merged, international transfers.");
  br("newlyTracked", "Balances first on file", "What an account already held when its first statement begins.");
  br("inTransit", "Transfers in transit", "A transfer whose other leg lands in the next year (e.g. a rollover).");
  br(
    "unexplainedSavings",
    "Statements vs. paycheck math (timing)",
    "Saved according to statements (income − spending + retirement money) minus the cash saved above. With every check passing this is timing: a 401(k) or HSA contribution posted after the year's last paycheck.",
  );
  rows.push({ label: "Change in net worth", total: true, cells: per((y) => (y.bridge ? m(y.bridge.total) : blockedCell(bridgeBlockers(y)))) });
  return rows;
}

function BridgeChart({ years }: { years: YearProfile[] }) {
  const chart = useChartPalette();
  const keys = [
    ["cashSaved", "Cash saved"],
    ["investmentGrowth", "Investment growth"],
    ["outsideMoney", "Outside money"],
    ["newlyTracked", "First on file"],
    ["inTransit", "In transit"],
    ["unexplainedSavings", "Timing"],
  ] as const;
  const data = years
    .filter((y) => y.bridge)
    .map((y) => {
      const row: Record<string, number | string> = { label: y.label, total: y.bridge!.total / 100 };
      for (const [k] of keys) row[k] = y.bridge![k] / 100;
      return row;
    });
  const ui = chartChrome(chart);
  const colors = [chart.series[0], chart.series[2], chart.series[3], chart.series[4], chart.neutral, chart.series[1]];
  if (!data.length) return null;
  return (
    <Card title="Where each year's change in net worth came from" subtitle="Bars stack each source of change; the line is the total change. Only proven years appear.">
      <div className="h-[320px] w-full min-w-0">
        <RechartsResponsive>
          <ComposedChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 4 }} stackOffset="sign">
            <CartesianGrid {...ui.grid} />
            <XAxis dataKey="label" {...ui.xAxis} />
            <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
            <Tooltip {...ui.tooltip} formatter={(v, name) => [formatUsd(Math.round(Number(v))), String(name)]} />
            <Legend {...ui.legend} />
            <ReferenceLine y={0} stroke={chart.axisLine} />
            {keys.map(([k, label], i) => (
              <Bar key={k} dataKey={k} name={label} stackId="b" fill={colors[i]} isAnimationActive={false} />
            ))}
            <Line type="monotone" dataKey="total" name="Change in net worth" stroke={chart.lineBalance} strokeWidth={2} isAnimationActive={false} />
          </ComposedChart>
        </RechartsResponsive>
      </div>
    </Card>
  );
}

function LivingBreakdown({ years, highlight }: { years: YearProfile[]; highlight: number[] }) {
  const spendingOf = (y: YearProfile) => y.cash?.spending ?? [];
  const cats = [...new Set(years.flatMap((y) => spendingOf(y).map((s) => s.category)))];
  const total = (c: string) => years.reduce((s, y) => s + (spendingOf(y).find((x) => x.category === c)?.cents ?? 0), 0);
  cats.sort((a, b) => total(b) - total(a));
  const cell = (y: YearProfile, fn: (c: YearCash) => number): Cell => (y.cash ? { text: usd(fn(y.cash)) } : blockedCell(y.blockers.cash));
  const rows: TableRow[] = [
    ...cats.map((c) => ({ label: c, indent: true, cells: years.map((y) => cell(y, (x) => x.spending.find((s) => s.category === c)?.cents ?? 0)) })),
    { label: "Less: reimbursements received", indent: true, cells: years.map((y) => cell(y, (x) => -x.reimbursements)) },
    { label: "Living expenses (from statements)", total: true, cells: years.map((y) => cell(y, (x) => x.waterfall.living)) },
  ];
  return (
    <Card title="Living expenses by category" subtitle="What's behind the living-expense line (one-offs and income-tax payments excluded).">
      <details>
        <summary className="cursor-pointer text-xs font-medium text-fg-2">Show categories</summary>
        <div className="mt-2">
          <YearTable columns={years.map((y) => y.label)} rows={rows} highlight={highlight} />
        </div>
      </details>
    </Card>
  );
}
