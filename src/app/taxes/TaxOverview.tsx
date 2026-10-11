"use client";

import { buttonSecondary, Card } from "@/components/ledger/LedgerBits";
import { ShareBar, ShareLegend, type ShareSegment } from "@/components/charts/ShareBar";
import type { ReturnResult, SafeHarbor } from "@/lib/tax/computeReturn";
import type { TruePlan } from "@/lib/tax/buildTaxReport";
import type { ReactNode } from "react";
import type { ProvenTaxResponse as TaxResponse } from "./TaxClient";
import { BalanceBadge, Callout, formatDate, NumberTable, pct, usd } from "./taxUi";

type Tab = "compare" | "inputs" | "income" | "payments" | "filed" | "worksheet";

/** Every tax the joint return owes, by who collects it. PFML is payroll, so it sits with Social Security and Medicare. */
export function taxBuckets(x: ReturnResult) {
  const federal = x.federal.totalTax - x.federal.refundableChildCredit;
  const payroll = x.fica.socialSecurity + x.fica.medicare + x.fica.ctPfml;
  const ny = x.ny?.totalTax ?? 0;
  const gross =
    x.grossPay + x.federal.interest + x.federal.ordinaryDividends + Math.max(0, x.federal.capitalGainAllowed) + x.federal.retirementTaxable + x.federal.otherIncome;
  const total = federal + x.ct.totalTax + ny + x.otherStateTax + payroll;
  return { federal, ct: x.ct.totalTax, ny, other: x.otherStateTax, payroll, total, gross, kept: gross - total };
}

const daysUntil = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

export function TaxOverview({ r, onGo }: { r: TaxResponse; onGo: (tab: Tab) => void }) {
  const mfj = r.scenarios.mfj;
  const b = taxBuckets(mfj);
  const separate = r.scenarios.mfs.totalTax + Object.values(r.scenarios.mfs.returns).reduce((s, x) => s + x.fica.ctPfml, 0);
  const joint = b.total;
  const depFed = r.scenarios.mfjNoDependents.federal.totalTax - r.scenarios.mfjNoDependents.federal.refundableChildCredit - b.federal;
  const depCt = r.scenarios.mfjNoDependents.ct.totalTax - mfj.ct.totalTax;
  const depNy = (r.scenarios.mfjNoDependents.ny?.totalTax ?? 0) - b.ny;
  const past = !r.isCurrentYear && Number(r.today.slice(0, 4)) > r.year;

  return (
    <div className="flex flex-col gap-4">
      <Hero r={r} onGo={onGo} />

      {r.warnings.length > 0 && (
        <Callout tone="warn" title={`${r.warnings.length} thing${r.warnings.length === 1 ? "" : "s"} to check`}>
          <ul className="list-disc space-y-1 pl-4">
            {r.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
          <button type="button" className={`${buttonSecondary} mt-2`} onClick={() => onGo("inputs")}>
            Open inputs
          </button>
        </Callout>
      )}

      <AtFiling r={r} />

      <div className="grid gap-4 lg:grid-cols-2">
        <NextThousand r={r} />
        {r.isCurrentYear ? <Calendar r={r} /> : <FiledVerdict r={r} onGo={onGo} />}
      </div>

      {r.isCurrentYear && <ForecastBasis r={r} onGo={onGo} />}

      <Card
        title={r.isCurrentYear ? "Do we need a true-up payment this year?" : "Underpayment check"}
        subtitle={`Penalty-free if withholding plus estimated payments reach the safe harbor: the smaller of 90% of ${r.year} tax or 100%/110% of ${r.year - 1} tax. Withholding counts as paid evenly through the year, so extra withholding in the last paychecks still fixes a shortfall; an estimated payment is due ${formatDate(r.plan.q4DueDate)}.`}
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <TrueUp
            name="Federal"
            sh={r.safeHarbor.federal}
            plan={r.plan.federal}
            remaining={r.plan.remainingPaychecks}
            who={r.plan.paycheckPerson}
            form="W-4 line 4(c)"
            dueDate={r.plan.q4DueDate}
            priorEstimated={r.priorYearSource === "ESTIMATED"}
          />
          <TrueUp name="Connecticut" sh={r.safeHarbor.ct} plan={r.plan.ct} remaining={r.plan.remainingPaychecks} who={r.plan.paycheckPerson} form="CT-W4 line 3" dueDate={r.plan.q4DueDate} />
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Joint vs separate"
          actions={
            <button type="button" className={buttonSecondary} onClick={() => onGo("compare")}>
              Details
            </button>
          }
        >
          <p className="text-sm text-fg">
            {Math.abs(separate - joint) < 100 ? (
              <>Filing jointly and separately come out about the same.</>
            ) : separate > joint ? (
              <>
                Filing <b>jointly</b> saves about <b>{usd(separate - joint)}</b> compared with filing separately ({usd(joint)} vs {usd(separate)} in total
                tax).
              </>
            ) : (
              <>
                Filing <b>separately</b> saves about <b>{usd(joint - separate)}</b> ({usd(separate)} vs {usd(joint)} jointly).
              </>
            )}
          </p>
          <VersusBar a={{ label: "Joint", cents: joint }} b={{ label: "Separate", cents: separate }} />
          <p className="mt-2 text-xs text-muted">
            Married couples can only file jointly or separately (not single). Separate figures assume{" "}
            {r.dependents.length ? `${r.profile.persons.find((p) => p.id === r.scenarios.mfs.claimant)?.name ?? "one spouse"} claims ${r.dependents.map((d) => d.name).join(", ")} and ` : ""}
            both {r.scenarios.mfs.itemize ? "itemize" : "take the standard deduction"}, whichever is cheapest.
          </p>
        </Card>
        <Card title={r.dependents.length ? `Effect of ${r.dependents.map((d) => d.name).join(", ")} as dependent` : "Dependents"}>
          {r.dependents.length ? (
            <>
              <p className="text-sm text-fg">
                {depFed + depCt + depNy < 100 ? (
                  <>
                    Claiming {r.dependents.map((d) => d.name).join(", ")} doesn&apos;t change your joint tax this year: the child credits phase out completely at your
                    income.
                  </>
                ) : (
                  <>
                    Claiming {r.dependents.map((d) => d.name).join(", ")} lowers your joint tax by <b>{usd(depFed + depCt + depNy)}</b>.
                  </>
                )}
              </p>
              <NumberTable
                className="mt-2"
                columns={["Joint return"]}
                rows={[
                  { label: "Federal child tax credit", values: [usd(mfj.federal.childTaxCredit + mfj.federal.refundableChildCredit)], help: "$2,200 per child under 17, reduced $50 per $1,000 of AGI over $400,000 (joint)." },
                  { label: "Other dependent / care credits", values: [usd(mfj.federal.otherDependentCredit + mfj.federal.dependentCareCredit)] },
                  { label: "CT child tax credit", values: [usd(mfj.ct.childTaxCredit)], help: "$600 per child 16 or under; phases out between $200k and $209k federal AGI (joint)." },
                  ...(mfj.ny ? [{ label: "New York dependent exemption", values: [usd(depNy)], help: "$1,000 of income per dependent, at your New York (and City) rate." }] : []),
                  { label: "Total savings", values: [usd(depFed + depCt + depNy)], strong: true },
                ]}
              />
            </>
          ) : (
            <p className="text-sm text-muted">No dependents {past ? `in ${r.year}` : "entered"}.</p>
          )}
        </Card>
      </div>

      <Card
        title={r.isCurrentYear ? `Projected ${r.year} W-2s` : `${r.year} W-2s`}
        subtitle={r.isCurrentYear ? "What each employer's W-2 should show in January: the latest stub's year-to-date totals plus the paychecks still to come." : "The W-2s on file, else each employer's last stub of the year."}
        actions={
          <button type="button" className={buttonSecondary} onClick={() => onGo("income")}>
            Details
          </button>
        }
      >
        <ProjectedW2s r={r} />
      </Card>

      <Card title={past ? `Taxes paid for ${r.year}` : `Taxes paid so far in ${r.year}`} subtitle="Withholding from the pay stubs, plus estimated payments found in the bank ledger.">
        <PaidToDate r={r} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- hero

/** The year in one picture: total tax, and where every dollar of income goes. */
function Hero({ r, onGo }: { r: TaxResponse; onGo: (tab: Tab) => void }) {
  const mfj = r.scenarios.mfj;
  const b = taxBuckets(mfj);
  const past = !r.isCurrentYear && Number(r.today.slice(0, 4)) > r.year;
  const segments: (ShareSegment & { short: string })[] = [
    { id: "kept", label: "Take-home + savings", short: "you keep", cents: b.kept, color: "var(--chart-series-2)" },
    { id: "federal", label: "Federal income tax", short: "federal", cents: b.federal, color: "var(--chart-series-0)" },
    ...(b.ct ? [{ id: "ct", label: "Connecticut income tax", short: "Connecticut", cents: b.ct, color: "var(--chart-series-1)" }] : []),
    ...(b.ny ? [{ id: "ny", label: mfj.ny?.city ? "New York State + City" : "New York State", short: mfj.ny?.city ? "New York + NYC" : "New York", cents: b.ny, color: "var(--chart-series-4)" }] : []),
    ...(b.other ? [{ id: "other", label: "Other states", short: "other states", cents: b.other, color: "var(--chart-series-6)" }] : []),
    { id: "payroll", label: "Social Security, Medicare, paid leave", short: "payroll", cents: b.payroll, color: "var(--chart-series-3)" },
  ];
  const per100 = (c: number) => (b.gross > 0 ? Math.round((c / b.gross) * 100) : 0);
  const word = r.isCurrentYear ? "projected" : past ? (r.documents?.filed.federal ? "as filed" : "full year") : "estimated";
  const check = r.documents?.check;
  const reproduced = check && [check.summary.federal, check.summary.ct, check.summary.ny].every((s) => s == null || s === "MATCH" || s === "ROUNDING");

  return (
    <section className="relative overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow)]">
      {/* A soft wash of the palette behind the headline. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{ background: "radial-gradient(60rem 18rem at 0% 0%, var(--chart-series-0), transparent 60%), radial-gradient(40rem 16rem at 100% 0%, var(--chart-series-2), transparent 60%)" }}
      />
      <div className="relative grid gap-6 p-5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:p-6">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
            <span>{r.year} taxes</span>
            <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[10px] tracking-wide text-fg-2">{word}</span>
          </div>
          <div className="num mt-1 text-4xl font-semibold tracking-tight text-fg">{usd(b.total)}</div>
          <div className="text-sm text-fg-2">
            on {usd(b.gross)} of income — <b className="text-fg">{pct(b.gross > 0 ? b.total / b.gross : 0)}</b> all in
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs">
            <Mini label="You keep" value={usd(b.kept)} />
            <Mini label="Federal of AGI" value={pct(mfj.effective.federalOfAgi)} />
            <Mini label="Next $1,000" value={pct(r.marginal.federal + r.marginal.ct + r.marginal.ny + r.marginal.payroll)} />
          </div>
          {reproduced && (
            <button type="button" onClick={() => onGo("filed")} className="mt-3 inline-flex w-fit items-center gap-1.5 rounded-full bg-pos-soft px-2.5 py-1 text-xs font-medium text-pos hover:opacity-90">
              <span aria-hidden>✓</span> Matches the filed {[check.summary.federal && "federal", check.summary.ct && "CT", check.summary.ny && "NY"].filter(Boolean).join(", ")} returns
            </button>
          )}
        </div>
        <div className="flex min-w-0 flex-col justify-center gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-[13px] font-semibold text-fg">Where every $100 goes</h2>
            <span className="hidden text-xs text-muted sm:inline">hover a band for dollars</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {segments.map((s) => (
              <span key={s.id} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2 py-0.5 text-xs text-fg-2">
                <span className="h-2 w-2 rounded-full" style={{ background: s.color }} aria-hidden />
                <b className="num text-fg">${per100(s.cents)}</b> {s.short}
              </span>
            ))}
          </div>
          <ShareBar segments={segments} height={22} label={`Where ${r.year}'s income goes`} />
          <ShareLegend segments={segments} />
        </div>
      </div>
    </section>
  );
}

function Mini({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="num text-base font-semibold text-fg">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------- at filing

/** One card per return: refund or balance due, and how much of the tax is already paid. */
function AtFiling({ r }: { r: TaxResponse }) {
  const mfj = r.scenarios.mfj;
  const rows: { name: string; sub: string; tax: number; paid: number; balance: number }[] = [
    { name: "Federal", sub: "Form 1040", tax: mfj.federal.totalTax, paid: mfj.federal.totalPayments, balance: mfj.federal.balanceDue },
  ];
  if (mfj.ct.totalTax || mfj.ct.totalPayments || r.residency.ct !== "NONRESIDENT")
    rows.push({ name: "Connecticut", sub: mfj.ct.sourceIncome != null ? "CT-1040NR/PY" : "CT-1040", tax: mfj.ct.totalTax, paid: mfj.ct.totalPayments, balance: mfj.ct.balanceDue });
  if (mfj.ny)
    rows.push({ name: mfj.ny.city ? "New York + NYC" : "New York", sub: mfj.ny.filing.state === "RESIDENT" ? "IT-201" : "IT-203", tax: mfj.ny.totalTax, paid: mfj.ny.totalPayments, balance: mfj.ny.balanceDue });
  const net = rows.reduce((s, x) => s + x.balance, 0);
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
        <h2 className="text-[13px] font-semibold text-fg">At filing · {formatDate(r.plan.filingDate)}</h2>
        <span className="text-xs text-muted">
          All returns together: <BalanceBadge cents={net} />
        </span>
      </div>
      <div className={`grid gap-3 ${rows.length === 3 ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
        {rows.map((x) => (
          <BalanceCard key={x.name} {...x} />
        ))}
      </div>
    </section>
  );
}

function BalanceCard({ name, sub, tax, paid, balance }: { name: string; sub: string; tax: number; paid: number; balance: number }) {
  const even = Math.abs(balance) < 100;
  const refund = balance < 0 && !even;
  const covered = tax > 0 ? paid / tax : paid > 0 ? 1 : 0;
  const tone = even ? "text-fg" : refund ? "text-pos" : "text-warn";
  const fill = even || refund ? "var(--pos)" : "var(--warn)";
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface p-4 shadow-[var(--shadow)]">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold text-fg">{name}</span>
        <span className="text-[10px] uppercase tracking-wide text-muted">{sub}</span>
      </div>
      <div className={`num mt-2 text-2xl font-semibold tracking-tight ${tone}`}>
        {even ? "About even" : `${refund ? "Refund" : "Owe"} ${usd(Math.abs(balance))}`}
      </div>
      {/* Paid against the tax: the track is the tax; past 100% the overflow is the refund. */}
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-surface-3" role="img" aria-label={`${pct(covered, 0)} of the tax paid`}>
        <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${Math.min(100, covered * 100)}%`, background: fill }} />
      </div>
      <div className="mt-1.5 flex justify-between text-xs text-muted">
        <span>
          Paid <span className="num text-fg-2">{usd(paid)}</span>
        </span>
        <span>
          of <span className="num text-fg-2">{usd(tax)}</span> tax · {pct(covered, 0)}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- next $1,000

function NextThousand({ r }: { r: TaxResponse }) {
  const m = r.marginal;
  const parts: ShareSegment[] = [
    { id: "keep", label: "You keep", cents: Math.round((1 - m.federal - m.ct - m.ny - m.payroll) * 100_000), color: "var(--chart-series-2)" },
    { id: "federal", label: "Federal", cents: Math.round(m.federal * 100_000), color: "var(--chart-series-0)" },
    ...(m.ct ? [{ id: "ct", label: "Connecticut", cents: Math.round(m.ct * 100_000), color: "var(--chart-series-1)" }] : []),
    ...(m.ny ? [{ id: "ny", label: "New York", cents: Math.round(m.ny * 100_000), color: "var(--chart-series-4)" }] : []),
    ...(m.payroll ? [{ id: "payroll", label: "Payroll", cents: Math.round(m.payroll * 100_000), color: "var(--chart-series-3)" }] : []),
  ];
  const mfj = r.scenarios.mfj;
  return (
    <Card title="The next $1,000 of pay" subtitle={`Marginal rate ${pct(m.federal + m.ct + m.ny + m.payroll)}, against ${pct(mfj.effective.allInOfGross)} on average. A pre-tax 401(k) or HSA dollar skips the income-tax part.`}>
      <div className="flex items-baseline gap-3">
        <span className="num text-3xl font-semibold tracking-tight text-fg">{usd(parts[0]!.cents)}</span>
        <span className="text-sm text-muted">of every extra $1,000 reaches you</span>
      </div>
      <div className="mt-3">
        <ShareBar segments={parts} height={14} label="Where the next $1,000 of pay goes" />
        <ShareLegend segments={parts} />
      </div>
      <p className="mt-2 text-xs text-muted">Federal bracket {pct(mfj.federal.marginalBracket, 0)}{mfj.federal.niit ? " plus the 3.8% investment-income surtax on investment dollars" : ""}.</p>
    </Card>
  );
}

// ---------------------------------------------------------------- calendar / verdict

function Calendar({ r }: { r: TaxResponse }) {
  const y = r.year;
  const events = [
    { date: `${y}-09-15`, label: "Q3 estimate due" },
    { date: `${y}-12-31`, label: "Last day for this year's 401(k), HSA payroll and gifts" },
    { date: r.plan.q4DueDate, label: "Q4 estimate due" },
    { date: `${y + 1}-01-31`, label: "W-2s and most 1099s arrive" },
    { date: `${y + 1}-03-15`, label: "Corrected / late 1099s and K-1s" },
    { date: r.plan.filingDate, label: "File, or extend and pay" },
  ];
  const first = Date.parse(events[0]!.date);
  const span = Date.parse(events.at(-1)!.date) - first;
  const at = (d: string) => Math.min(100, Math.max(0, ((Date.parse(d) - first) / span) * 100));
  const next = events.find((e) => e.date >= r.today);
  return (
    <Card title="The road to April" subtitle={next ? `Next up: ${next.label} — ${formatDate(next.date)}, in ${daysUntil(r.today, next.date)} days.` : undefined}>
      <div className="relative mx-2 mb-1 mt-6 h-1 rounded-full bg-surface-3">
        <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${at(r.today)}%` }} />
        {events.map((e) => (
          <span
            key={e.date}
            title={`${formatDate(e.date)} · ${e.label}`}
            className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface ${e.date < r.today ? "bg-accent" : "bg-line-strong"}`}
            style={{ left: `${at(e.date)}%` }}
          />
        ))}
        <span className="absolute -top-6 -translate-x-1/2 whitespace-nowrap rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-accent-fg" style={{ left: `${at(r.today)}%` }}>
          Today
        </span>
      </div>
      <ol className="mt-4 grid gap-1.5 text-xs">
        {events.map((e) => {
          const d = daysUntil(r.today, e.date);
          return (
            <li key={e.date} className={`flex items-baseline gap-3 ${d < 0 ? "text-faint" : "text-fg-2"}`}>
              <span className="num w-24 shrink-0 text-fg">{formatDate(e.date).replace(/, \d{4}$/, "")}</span>
              <span className="min-w-0 flex-1">{e.label}</span>
              <span className="num shrink-0 text-muted">{d < 0 ? "done" : d === 0 ? "today" : `${d}d`}</span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function FiledVerdict({ r, onGo }: { r: TaxResponse; onGo: (tab: Tab) => void }) {
  const c = r.documents?.check;
  const filed = r.documents?.filed;
  if (!c || !filed) {
    return (
      <Card title="Filed return">
        <p className="text-sm text-muted">No filed {r.year} return is in the tax documents folder, so these figures come from the stubs and statements alone.</p>
      </Card>
    );
  }
  const items = [
    { name: "Federal", form: filed.federal?.form, s: c.summary.federal, n: c.federal },
    { name: "Connecticut", form: filed.ct?.form, s: c.summary.ct, n: c.ct },
    { name: "New York", form: filed.ny?.form, s: c.summary.ny, n: c.ny },
  ].filter((x) => x.s != null);
  return (
    <Card
      title={`The app vs your filed ${r.year} returns`}
      subtitle="Every line of each return, recomputed from the W-2s, 1099s and K-1s."
      actions={
        <button type="button" className={buttonSecondary} onClick={() => onGo("filed")}>
          Line by line
        </button>
      }
    >
      <ul className="grid gap-2">
        {items.map((x) => {
          const same = x.n.filter((l) => l.status === "MATCH" || l.status === "ROUNDING").length;
          const ok = x.s === "MATCH" || x.s === "ROUNDING";
          return (
            <li key={x.name} className="flex items-center gap-3">
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold ${ok ? "bg-pos-soft text-pos" : "bg-warn-soft text-warn"}`} aria-hidden>
                {ok ? "✓" : "!"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-fg">
                  {x.name} <span className="text-xs font-normal text-muted">{x.form}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <div className="h-full rounded-full" style={{ width: `${(same / Math.max(1, x.n.length)) * 100}%`, background: ok ? "var(--pos)" : "var(--warn)" }} />
                </div>
              </div>
              <span className="num w-20 shrink-0 text-right text-xs text-muted">
                {same}/{x.n.length} lines
              </span>
            </li>
          );
        })}
      </ul>
      {c.suggestions.length > 0 && <p className="mt-3 text-xs text-muted">{c.suggestions.length} suggested input{c.suggestions.length === 1 ? "" : "s"} would close the gaps — apply them on the Filed return tab.</p>}
    </Card>
  );
}

/** Two totals as bars on one scale (the shorter is the cheaper filing). */
function VersusBar({ a, b }: { a: { label: string; cents: number }; b: { label: string; cents: number } }) {
  const max = Math.max(a.cents, b.cents, 1);
  return (
    <div className="mt-3 grid gap-1.5 text-xs">
      {[a, b].map((x) => (
        <div key={x.label} className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-fg-2">{x.label}</span>
          <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full" style={{ width: `${(x.cents / max) * 100}%`, background: x.cents === Math.min(a.cents, b.cents) ? "var(--chart-series-2)" : "var(--chart-neutral)" }} />
          </div>
          <span className="num w-20 shrink-0 text-right text-fg">{usd(x.cents)}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- true-up

function TrueUp({
  name,
  sh,
  plan,
  remaining,
  who,
  form,
  dueDate,
  priorEstimated = false,
}: {
  name: string;
  sh: SafeHarbor;
  plan: TruePlan;
  remaining: number;
  who: string | null;
  form: string;
  dueDate: string;
  priorEstimated?: boolean;
}) {
  const shortfall = plan.safeHarborShortfall;
  return (
    <div className="rounded-md border border-line p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg">{name}</h3>
        <BalanceBadge cents={plan.projectedBalanceDue} />
      </div>
      <NumberTable
        columns={[""]}
        rows={[
          { label: "Projected tax for the year", values: [usd(sh.currentYearTax)] },
          {
            label:
              sh.basis === "PRIOR_YEAR"
                ? `Safe harbor: ${Math.round(sh.priorYearPct * 100)}% of last year's tax${priorEstimated ? " (estimated)" : ""}`
                : "Safe harbor: 90% of this year's tax",
            values: [usd(sh.requiredAnnualPayment)],
            help:
              sh.priorYearTax != null
                ? `90% of this year: ${usd(Math.round(sh.currentYearTax * 0.9))}. ${Math.round(sh.priorYearPct * 100)}% of last year${priorEstimated ? " (this app's estimate — enter the filed figure under Inputs)" : ""}: ${usd(Math.round(sh.priorYearTax * sh.priorYearPct))}. The smaller applies.`
                : undefined,
          },
          { label: "Withholding through year end", values: [usd(sh.withholding)], indent: true },
          { label: "Estimated payments", values: [usd(sh.estimatesPaid)], indent: true },
          { label: "Short of safe harbor", values: [usd(shortfall)], strong: true },
        ]}
      />
      <div className="mt-2 text-sm">
        {shortfall > 0 ? (
          <Callout tone="warn">
            To avoid an underpayment penalty, add about <b>{usd(plan.perPaycheckForSafeHarbor ?? shortfall)}</b> of extra withholding
            {remaining > 0 ? ` to each of ${who ? `${who}'s` : "the"} remaining ${remaining} paychecks (${form})` : ""}, or pay <b>{usd(shortfall)}</b>{" "}
            as an estimated payment by {formatDate(dueDate)} (an estimated payment may still leave a small penalty for earlier quarters).
          </Callout>
        ) : sh.underDeMinimis && plan.projectedBalanceDue < 100_000 ? (
          <Callout tone="good">
            No true-up needed: {plan.projectedBalanceDue < 0 ? "you're projected to get a refund" : "you're projected to owe less than $1,000 at filing"}, so no penalty
            applies.
          </Callout>
        ) : (
          <Callout tone="good">No true-up needed for the penalty: projected withholding covers the safe harbor.</Callout>
        )}
        {plan.projectedBalanceDue >= 100 && plan.perPaycheckToBreakEven != null && (
          <p className="mt-2 text-xs text-muted">
            To owe nothing in April instead, withhold about {usd(plan.perPaycheckToBreakEven)} more per paycheck ({usd(plan.projectedBalanceDue)} in total).
          </p>
        )}
        {plan.projectedBalanceDue <= -100 && (
          <p className="mt-2 text-xs text-muted">
            Projected refund of {usd(-plan.projectedBalanceDue)}: you&apos;re over-withholding by about {remaining ? `${usd(-plan.projectedBalanceDue / remaining)} per remaining paycheck` : "that much"}.
          </p>
        )}
      </div>
    </div>
  );
}

function PaidToDate({ r }: { r: TaxResponse }) {
  const people = r.people;
  const cols = [...people.map((p) => p.name), "Total"];
  const row = (label: string, f: (p: TaxResponse["people"][number]) => number, help?: string) => {
    const vals = people.map(f);
    return { label, values: [...vals.map(usd), usd(vals.reduce((a, b) => a + b, 0))], help };
  };
  const totalOf = (p: TaxResponse["people"][number]) => {
    const t = p.paidToDate;
    return t.federal + t.socialSecurity + t.medicare + t.ct + t.ctPfml + t.otherState + t.estimatesFederal + t.estimatesCt;
  };
  const latest = people.flatMap((p) => p.payroll.filter((x) => x.active).map((x) => `${p.name}: ${formatDate(x.latestPayDate)}`));
  return (
    <>
      <NumberTable
        columns={cols}
        rows={[
          row("Federal income tax withheld", (p) => p.paidToDate.federal),
          row("Social Security", (p) => p.paidToDate.socialSecurity),
          row("Medicare (incl. 0.9% additional)", (p) => p.paidToDate.medicare),
          row("CT income tax withheld", (p) => p.paidToDate.ct),
          row("CT Paid Leave (PFML)", (p) => p.paidToDate.ctPfml, "0.5% payroll contribution, not income tax."),
          row("NY / other state & city withheld", (p) => p.paidToDate.otherState),
          row("Federal estimated payments", (p) => p.paidToDate.estimatesFederal, "Joint payments are split evenly."),
          row("CT estimated payments", (p) => p.paidToDate.estimatesCt),
          { ...row("Total paid", totalOf), strong: true },
        ]}
      />
      {latest.length > 0 && <p className="mt-2 text-xs text-muted">Latest pay stubs — {latest.join(" · ")}</p>}
    </>
  );
}

const FREQ_WORD: Record<string, string> = { WEEKLY: "weekly", BIWEEKLY: "biweekly", SEMIMONTHLY: "semimonthly", MONTHLY: "monthly" };

/** Shortens a payroll employer name for table headers ("Acme Operations Inc · payroll ABC" → "Acme Operations"). */
const shortEmployer = (s: string) =>
  s
    .split(" · ")[0]!
    .replace(/\b(INC|LLC|LP|CORP|CO|LTD)\.?$/i, "")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());

/** What the forecast stands on: each source's latest document, and what fills in the rest of the year. */
function ForecastBasis({ r, onGo }: { r: TaxResponse; onGo: (tab: "inputs") => void }) {
  const pay = r.people.flatMap((p) =>
    p.payroll
      .filter((e) => e.active)
      .map((e) => {
        const ahead = e.remainingPayDates.filter((d) => d > r.today).length;
        const check = e.regularPaycheck ? usd(e.regularPaycheck.gross) : null;
        return (
          <li key={`${p.id}-${e.employer}`}>
            <b className="text-fg">{p.name}</b> — {shortEmployer(e.employer)} stubs through {formatDate(e.latestPayDate)}
            {e.remainingPayDates.length > 0 && check ? (
              <>
                ; {e.remainingPayDates.length} more {FREQ_WORD[e.frequency]} paychecks ({ahead} after today) at {check} gross, the{" "}
                {e.basis === "TYPICAL" ? "typical recent" : "latest"} paycheck
                {e.payThrough ? `, ending ${formatDate(e.payThrough)}` : ""}
              </>
            ) : (
              "; no more paychecks expected this year"
            )}
            {e.extraBonus ? `, plus a ${usd(e.extraBonus)} bonus` : ""}.
          </li>
        );
      }),
  );
  return (
    <Card
      title={`${r.year} forecast to December 31`}
      subtitle="Everything after each source's latest document is projected. Change the assumptions on the Inputs tab."
      actions={
        <button type="button" className={buttonSecondary} onClick={() => onGo("inputs")}>
          Adjust assumptions
        </button>
      }
    >
      <ul className="list-disc space-y-1 pl-4 text-xs text-fg-2">
        {pay.length ? pay : <li>No pay stubs this year.</li>}
        <li>
          Investments — statements through {r.dataThrough.statements ? formatDate(r.dataThrough.statements) : "—"}; dividends and interest run-rated to year end.{" "}
          <b className="text-fg">Sales after that aren&apos;t predicted</b>: enter expected gains or losses under Inputs.
        </li>
        <li>Bank interest and estimated tax payments — bank statements through {formatDate(r.dataThrough.bank)}.</li>
      </ul>
    </Card>
  );
}

/** Each employer's W-2 boxes: to date (latest stub) and projected to year end. */
function ProjectedW2s({ r }: { r: TaxResponse }) {
  const cols = r.people.flatMap((p) => p.payroll.map((e) => ({ who: p.name, e })));
  if (!cols.length) return <p className="text-sm text-muted">No pay stubs this year.</p>;
  const proj = r.isCurrentYear;
  const row = (label: string, f: (w: (typeof cols)[number]["e"]["w2Ytd"]) => number, help?: string) => ({
    label,
    help,
    values: cols.flatMap(({ e }) => (proj ? [usd(f(e.w2Ytd)), usd(f(e.w2Projected))] : [usd(f(e.w2Ytd))])),
  });
  return (
    <NumberTable
      columns={cols.flatMap(({ who, e }) => {
        const name = `${who} · ${shortEmployer(e.employer)}`;
        return proj ? [`${name} — to date`, "Year end"] : [name];
      })}
      rows={[
        row("Box 1 · Wages", (w) => w.box1Wages, "Gross less pre-tax 401(k), HSA and §125 benefits."),
        row("Box 2 · Federal tax withheld", (w) => w.federalWithheld),
        row("Box 3 · Social Security wages", (w) => w.box3SsWages),
        row("Box 5 · Medicare wages", (w) => w.box5MedicareWages),
        row("Box 12 D · 401(k) deferrals", (w) => w.box12.D),
        row("Box 16 · CT wages", (w) => w.box16StateWages),
        row("Box 17 · CT tax withheld", (w) => w.stateWithheld),
        ...(cols.some(({ e }) => (e.w2Projected.nyWithheld ?? 0) + (e.w2Projected.nycWithheld ?? 0) > 0)
          ? [
              row("Box 16 · NY wages", (w) => w.nyStateWages ?? 0),
              row("Box 17 · NY tax withheld", (w) => w.nyWithheld ?? 0),
              row("Box 19 · NYC tax withheld", (w) => w.nycWithheld ?? 0),
            ]
          : []),
      ]}
    />
  );
}
