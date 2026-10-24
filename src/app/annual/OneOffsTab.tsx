"use client";

import { Badge, btn, Card, Callout, StatCell, StatGrid, table } from "@/components/ui/kit";
import { sortRows, SortTh, useSort } from "@/components/ui/sort";
import { fireNumber } from "@/lib/fire/fire";
import { resolveBasePay } from "@/lib/profile/basePay";
import { TAX_YEARS } from "@/lib/tax/params";
import type { AnnualProfileReport } from "@/lib/profile/buildAnnualProfile";
import type { FinancialProfileSettings } from "@/lib/profile/settings";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { pct, usd } from "./profileUi";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import type { ProofTarget } from "@/components/ui/proof/context";
import type { AnnualCashLine } from "@/lib/book/proof/annualProof";

/**
 * One-off expenses: the big charges that aren't part of a normal year (a wedding, a move,
 * furniture for a new place). Tagging one never changes a total — it moves the expense
 * from "living" to "one-off" so the living-cost trend, and the FIRE plan built on it,
 * reflect a normal year. Each tick saves straight away; the figures recalculate after.
 */
/** An Annual cash line's proof (book/proof/annualProof), as the Annual statement opens it. */
const cashP = (year: number, line: AnnualCashLine, shown: number): ProofTarget => ({ descriptor: { report: "annual", figure: "cash", year, line }, shownCents: shown });

export function OneOffsTab({
  r,
  onSave,
  recalculating,
}: {
  r: AnnualProfileReport;
  onSave: (patch: Partial<FinancialProfileSettings>) => Promise<void>;
  recalculating: boolean;
}) {
  const [oneOffs, setOneOffs] = useState(r.settings.oneOffs);
  const [cats, setCats] = useState(r.settings.nonRecurringCategories);
  const [status, setStatus] = useState<{ tone: "pos" | "neg" | "muted"; text: string } | null>(null);
  const queue = useRef(Promise.resolve());
  // Marked ones first, then biggest, until a header is clicked.
  const { sort, toggle } = useSort(null);
  // New settings from the server reset the lists (adjusted during render, not in an effect).
  const [seen, setSeen] = useState(r.settings);
  if (r.settings !== seen) {
    setSeen(r.settings);
    setOneOffs(r.settings.oneOffs);
    setCats(r.settings.nonRecurringCategories);
  }

  /** Saves in order, so quick clicks can't land out of sequence. */
  const persist = (patch: Partial<FinancialProfileSettings>) => {
    setStatus({ tone: "muted", text: "Saving…" });
    queue.current = queue.current.then(() =>
      onSave(patch)
        .then(() => setStatus({ tone: "pos", text: "Saved — every page now uses it." }))
        .catch((e: Error) => setStatus({ tone: "neg", text: e.message })),
    );
  };
  const setTag = (fingerprint: string, label: string | null) => {
    const next = { ...oneOffs };
    if (label == null) delete next[fingerprint];
    else next[fingerprint] = label;
    setOneOffs(next);
    persist({ oneOffs: next });
  };
  const setCategory = (c: string, on: boolean) => {
    const next = on ? [...cats, c] : cats.filter((x) => x !== c);
    setCats(next);
    persist({ nonRecurringCategories: next });
  };

  const full = useMemo(() => [...r.years].reverse().find((y) => !y.isCurrent), [r.years]);
  const [year, setYear] = useState(() => full?.year ?? r.currentYear);
  const y = r.years.find((x) => x.year === year);
  const fire = useMemo(() => {
    if (!r.seeds) return null;
    const s = r.seeds;
    const a = r.settings.outlook;
    const pay = resolveBasePay(s, a, TAX_YEARS[s.taxYear]!);
    const number = fireNumber({ tax: s.tax, inflation: a.inflation, stateTaxRate: a.stateTaxRate, withdrawalRate: a.withdrawalRate }, s.start.year, pay.living.cents);
    return { number, wr: a.withdrawalRate, typed: pay.living.typed, basis: pay.living.seed?.label ?? null };
  }, [r.seeds, r.settings.outlook]);

  return (
    <div className={`flex flex-col gap-4 ${recalculating ? "transition-opacity" : ""}`}>
      <Explainer basis={fire?.basis ?? null} wr={fire?.wr ?? r.settings.outlook.withdrawalRate} />

      <StatGrid cols={4}>
        <StatCell
          label={`Marked one-off in ${full?.year ?? "—"}`}
          value={full?.cash ? usd(full.cash.waterfall.nonRecurring) : "—"}
          proof={full?.cash ? cashP(full.year, "one-offs", full.cash.waterfall.nonRecurring) : undefined}
          sub={full?.cash ? `${full.oneOffTagged.count} expenses` : undefined}
        />
        <StatCell
          label={`Living expenses ${full?.year ?? ""}`}
          value={full?.cash ? usd(full.cash.waterfall.living) : "—"}
          proof={full?.cash ? cashP(full.year, "living", full.cash.waterfall.living) : undefined}
          sub={full?.cash ? "one-offs left out" : undefined}
        />
        <StatCell
          label="Your FIRE number"
          value={fire ? usd(fire.number) : "—"}
          sub={fire ? (fire.typed ? "uses the living cost typed on FIRE, so tags here don't move it" : `at a ${pct(fire.wr)} withdrawal rate, after tax`) : "needs a proven full year"}
        />
        <StatCell label="Status" value={recalculating ? "Recalculating…" : status?.tone === "neg" ? "Not saved" : "Up to date"} sub={status ? <span className={status.tone === "neg" ? "text-neg" : status.tone === "pos" ? "text-pos" : ""}>{status.text}</span> : "ticks save instantly"} />
      </StatGrid>

      <Card
        title="Big expenses, by year"
        subtitle="Single charges of $1,500 or more (rent left out), plus anything already marked. Tick the ones that won't happen in a normal year."
      >
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {r.years.map((x) => {
            const tagged = x.cash?.waterfall.nonRecurring ?? 0;
            return (
              <button
                key={x.year}
                type="button"
                onClick={() => setYear(x.year)}
                className={`rounded-md px-2.5 py-1 text-xs ${x.year === year ? "bg-accent text-accent-fg" : "border border-line-strong text-fg-2 hover:bg-surface-2"}`}
              >
                {x.label}
                {tagged > 0 && <span className="ml-1 opacity-80">· {usd(tagged)}</span>}
              </button>
            );
          })}
        </div>
        {y?.cash && (
          <p className="mb-2 text-xs text-muted">
            {y.label}: living expenses <ProofValue proof={cashP(y.year, "living", y.cash.waterfall.living)}>{usd(y.cash.waterfall.living)}</ProofValue> · one-offs{" "}
            <ProofValue proof={cashP(y.year, "one-offs", y.cash.waterfall.nonRecurring)}>{usd(y.cash.waterfall.nonRecurring)}</ProofValue> · saved incl. retirement{" "}
            <ProofValue proof={cashP(y.year, "saved", y.cash.waterfall.saved)}>{usd(y.cash.waterfall.saved)}</ProofValue> (unchanged by tags)
          </p>
        )}
        {!y || y.oneOffCandidates.length === 0 ? (
          <p className="text-xs text-muted">No expenses of $1,500 or more in {y?.label ?? year}.</p>
        ) : (
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.head}>
                <tr>
                  <th className={table.th}>One-off?</th>
                  <SortTh k="date" label="Date" sort={sort} toggle={toggle} />
                  <SortTh k="name" label="Payee" sort={sort} toggle={toggle} />
                  <th className={table.th}>Category</th>
                  <SortTh k="amount" label="Amount" sort={sort} toggle={toggle} right />
                  <th className={table.th}>What it was</th>
                </tr>
              </thead>
              <tbody>
                {sortRows(y.oneOffCandidates, sort, { date: (c) => c.date, amount: (c) => c.cents, name: (c) => c.payee }).map((c) => {
                  const viaCategory = cats.includes(c.category);
                  const tagged = c.fingerprint in oneOffs;
                  const on = tagged || viaCategory;
                  return (
                    <tr key={c.fingerprint} className={`${table.trHover} ${on ? "bg-info-soft" : ""}`}>
                      <td className={table.td}>
                        <button
                          type="button"
                          disabled={viaCategory}
                          aria-pressed={on}
                          title={viaCategory ? `Every ${c.category} expense counts as one-off (see "Whole categories" below)` : undefined}
                          onClick={() => setTag(c.fingerprint, tagged ? null : "")}
                          className={on ? btn.secondary : btn.ghost}
                        >
                          {on ? "✓ One-off" : "Mark one-off"}
                        </button>
                      </td>
                      <td className={`${table.td} num whitespace-nowrap text-fg-2`}>{c.date}</td>
                      <td className={`${table.td} max-w-[22rem] truncate`} title={`${c.payee} · ${c.account}`}>
                        {c.payee}
                      </td>
                      <td className={`${table.td} whitespace-nowrap text-muted`}>{c.category}</td>
                      <td className={`${table.tdR} whitespace-nowrap`}>
                        <ProofValue proof={{ descriptor: { report: "row", rowId: c.rowId }, shownCents: -c.cents }}>{usd(c.cents)}</ProofValue>
                      </td>
                      <td className={table.td}>
                        {tagged ? (
                          <input
                            className="w-48 rounded border border-line-strong bg-surface px-1.5 py-0.5 text-xs"
                            placeholder="e.g. wedding"
                            defaultValue={oneOffs[c.fingerprint]}
                            onBlur={(e) => e.target.value !== oneOffs[c.fingerprint] && setTag(c.fingerprint, e.target.value)}
                          />
                        ) : viaCategory ? (
                          <Badge tone="info">whole category</Badge>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <details className="rounded-lg border border-line bg-surface p-4">
        <summary className="cursor-pointer text-sm font-semibold text-fg">
          Whole categories {cats.length > 0 && <Badge tone="info">{cats.length} on</Badge>}
        </summary>
        <p className="mt-2 text-xs text-muted">
          Counts <strong>every</strong> expense in the category, in every year and of any size, as one-off. Use it only for categories that are never part of a normal
          year; for single charges, tick them above instead.
        </p>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
          {r.expenseCategories.map((c) => (
            <label key={c} className="flex items-center gap-1.5">
              <input type="checkbox" checked={cats.includes(c)} onChange={(e) => setCategory(c, e.target.checked)} />
              {c}
            </label>
          ))}
        </div>
      </details>
    </div>
  );
}

function Explainer({ basis, wr }: { basis: string | null; wr: number }) {
  const rows: [React.ReactNode, React.ReactNode][] = [
    [
      "Annual report › Statement",
      <>Moves the expense from <em>Living expenses</em> to <em>One-off expenses</em>. What you saved and the net worth bridge are unchanged.</>,
    ],
    [
      <Link key="f" href="/fire" className={btn.link}>
        FIRE
      </Link>,
      <>
        The plan&apos;s spending starts from living expenses over {basis ? <em>{basis.toLowerCase()}</em> : "the window chosen on FIRE"} (last 12 months by default), one-offs
        left out. A one-off tagged inside that window lowers it — and lowers your FIRE number by roughly {Math.round(1 / wr)}× the amount (1 ÷ {pct(wr)} withdrawal rate, a
        bit more after tax). Tags outside the window don&apos;t move FIRE.
      </>,
    ],
    [
      <Link key="c" href="/cash-flow" className={btn.link}>
        Cash flow
      </Link>,
      <>
        The <em>Excluding one-offs</em> monthly average on Overview leaves it out, and the month table shows it in the <em>One-offs</em> column. In the Trends,
        Patterns and year-over-year views it counts as <em>Big &amp; one-off</em> instead of <em>Everyday</em>, even under $1,500. <em>Mark one-off</em> on Cash flow › Spending is the same switch as here.
      </>,
    ],
  ];
  return (
    <Card title="What marking an expense one-off does" subtitle="A one-off is a big expense that won't recur in a normal year — a wedding, a move, a car, furniture for a new place.">
      <div className={table.wrap}>
        <table className={table.table}>
          <tbody>
            {rows.map(([where, what], i) => (
              <tr key={i} className="border-t border-line first:border-t-0">
                <td className={`${table.td} w-44 whitespace-nowrap align-top font-medium text-fg`}>{where}</td>
                <td className={`${table.td} text-fg-2`}>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3">
        <Callout tone="good" title="It never changes a total">
          Total spending, what was saved, savings rates, net worth, taxes, budgets, goals and the integrity checks are exactly the same either way — the expense is only
          relabeled, so averages and the FIRE plan reflect a normal year.
        </Callout>
      </div>
    </Card>
  );
}
