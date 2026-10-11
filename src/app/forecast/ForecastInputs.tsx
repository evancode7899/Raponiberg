"use client";

import { btn, MoneyInput, PercentInput, Segmented, selectCls } from "@/components/ui/kit";
import type { Forecast } from "@/lib/forecast/forecast";
import type { OutlookSeeds, ResolvedPerson } from "@/lib/profile/basePay";
import { DEFAULT_PERSON_OUTLOOK, type BonusEstimates, type LivingBasis, type OutlookAssumptions, type PersonOutlook } from "@/lib/profile/settings";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { monthName, pct, usd, YearInput } from "./forecastUi";

export type SetAssumption = <K extends keyof OutlookAssumptions>(k: K, v: OutlookAssumptions[K]) => void;

const TYPED = "!border-info/60 !bg-info-soft";
const LIVING: LivingBasis[] = ["TRAILING_12", "LAST_YEAR", "THIS_YEAR"];

/**
 * Every driver of the forecast, one line each, in the order the money flows: pay, spending,
 * bonuses, markets. A blank money field uses the figure from the stubs and statements (shown
 * as its placeholder); a typed figure is highlighted and ↺ puts the computed one back. Hover
 * a label for where its default comes from.
 */
export function ForecastInputs({ s, a, set, f, header }: { s: OutlookSeeds; a: OutlookAssumptions; set: SetAssumption; f: Forecast; header: ReactNode }) {
  const setPerson = (id: string, patch: Partial<PersonOutlook>) => set("people", { ...a.people, [id]: { ...DEFAULT_PERSON_OUTLOOK, ...a.people[id], ...patch } });
  const { pay, nearTermThrough } = f;
  const t = pay.tax;
  const estimates: { value: BonusEstimates; label: string }[] = [
    { value: "NEXT_PAYOUT", label: "From the next payout" },
    { value: "AFTER_NEAR_TERM", label: `From ${nearTermThrough + 1} (after the near term)` },
    { value: "NONE", label: "Never (stubs + letters only)" },
  ];

  return (
    <aside className="app-scroll min-w-0 rounded-lg border border-line bg-surface shadow-[var(--shadow)] lg:sticky lg:top-14 lg:max-h-[calc(100dvh-4.5rem)] lg:overflow-y-auto">
      {header}
      <div className="px-3 pb-2 text-xs">
        <Group title="Start" />
        <Line label={`Proven · ${shortDate(s.start.asOf)}`} help={`${s.start.note}. Liquid ${usd(s.start.liquid)} (cash, brokerage, less card balances) · illiquid ${usd(s.start.illiquid)} (retirement, HSA, other).`}>
          <span className="num font-medium text-fg">{usd(s.start.liquid + s.start.illiquid)}</span>
        </Line>

        <Group title="Pay" note="regular paychecks; bonuses below" />
        {pay.people.map((p) => (
          <PersonSalary key={p.personId} p={p} seed={s.people.find((x) => x.personId === p.personId)!} onChange={(patch) => setPerson(p.personId, patch)} />
        ))}
        <Line label="Raise / yr" help="Applied to base salary (and the 401(k)/HSA money riding on it) each January.">
          <PercentInput size="xs" ariaLabel="Raise per year" value={a.salaryGrowth} onChange={(v) => set("salaryGrowth", v)} />
        </Line>
        <Line
          label="Kept after tax"
          help={[
            `Share of base salary left after tax and payroll deductions (${s.taxYear} law, filing jointly, standard deduction${s.dependents.length ? `, ${s.dependents.length} dependent(s)` : ""}). 401(k)/HSA deferrals stay in: they're savings.`,
            `Base salary ${usd(pay.salary)}`,
            `Federal ${usd(-t.federal)} · CT ${usd(-t.ct)} · Social Security ${usd(-t.socialSecurity)} · Medicare ${usd(-t.medicare)} · CT leave ${usd(-t.pfml)}`,
            `Health/FSA & after-tax deductions ${usd(-(pay.section125 + pay.afterTax))}`,
            `Take-home ${usd(pay.takeHome)} = ${pct(pay.computedRate)}`,
          ].join("\n")}
          reset={pay.rateTyped ? { label: `computed ${pct(pay.computedRate)}`, onClick: () => set("takeHomeRate", null) } : undefined}
        >
          <PercentInput size="xs" ariaLabel="Take-home rate" value={pay.takeHomeRate} onChange={(v) => set("takeHomeRate", v)} className={pay.rateTyped ? TYPED : ""} />
        </Line>
        <Line label="Your 401(k)/HSA" help={`This year's deferrals to Dec 31, from the stubs. Inside take-home, but they land in retirement accounts.`} reset={pay.deferralsTyped ? { label: "from stubs", onClick: () => set("deferrals", null) } : undefined}>
          <MoneyInput nullable size="xs" ariaLabel="Your 401(k)/HSA per year" cents={a.deferrals} placeholderCents={pay.people.reduce((x, p) => x + p.deferrals, 0)} onChange={(v) => set("deferrals", v)} />
        </Line>
        <Line label="Employer 401(k)/HSA" help="Employer money on base paychecks, from the stubs." reset={pay.employerTyped ? { label: "from stubs", onClick: () => set("employerMatch", null) } : undefined}>
          <MoneyInput nullable size="xs" ariaLabel="Employer 401(k)/HSA per year" cents={a.employerMatch} placeholderCents={pay.people.reduce((x, p) => x + p.employer, 0)} onChange={(v) => set("employerMatch", v)} />
        </Line>

        <Group title="Spending" />
        <Line label="Living cost from" help={pay.living.seed ? `${pay.living.seed.detail}.` : undefined}>
          <select
            className={`${selectCls} w-full !py-1`}
            aria-label="Living cost basis"
            value={a.livingBasis}
            onChange={(e) => {
              set("livingBasis", e.target.value as LivingBasis);
              set("livingCost", null);
            }}
          >
            {LIVING.filter((k) => s.living[k]).map((k) => (
              <option key={k} value={k}>
                {s.living[k]!.label} · {usd(s.living[k]!.cents)}
              </option>
            ))}
          </select>
        </Line>
        <Line
          label="Living cost / yr"
          help="Everything spent except tagged one-offs, in the first year. Type a figure to override the basis above."
          reset={pay.living.typed ? { label: "use the basis", onClick: () => set("livingCost", null) } : undefined}
        >
          <MoneyInput nullable size="xs" ariaLabel="Living cost per year" cents={a.livingCost} placeholderCents={pay.living.seed?.cents ?? null} onChange={(v) => set("livingCost", v)} />
        </Line>
        <Line label="Living growth / yr" help="Inflation plus lifestyle creep, applied each January.">
          <PercentInput size="xs" ariaLabel="Living cost growth per year" value={a.livingGrowth} onChange={(v) => set("livingGrowth", v)} />
        </Line>
        <OneOffs a={a} set={set} startYear={s.start.year} />

        <Group title="Bonuses" note="stub + letter payments always count" />
        <Line label="Estimate awards" help="Bonuses already on a stub after the start, and payments an award letter still schedules, always count on their dates. This sets when awards no letter shows yet are estimated.">
          <select className={`${selectCls} w-full !py-1`} aria-label="Estimated bonuses" value={a.bonus.estimates} onChange={(e) => set("bonus", { ...a.bonus, estimates: e.target.value as BonusEstimates })}>
            {estimates.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Line>
        {a.bonus.estimates === "AFTER_NEAR_TERM" && (
          <Line label="Near term through" help="No estimated bonus is paid through December of this year.">
            <select className={`${selectCls} w-full !py-1`} aria-label="Near term through" value={nearTermThrough} onChange={(e) => set("nearTermThrough", Number(e.target.value))}>
              {[0, 1, 2, 3, 4]
                .map((i) => s.start.year + i)
                .filter((y) => y >= s.currentYear)
                .map((y) => (
                  <option key={y} value={y}>
                    Dec {y}
                    {y === s.currentYear + 1 ? " (default)" : ""}
                  </option>
                ))}
            </select>
          </Line>
        )}
        {a.bonus.estimates !== "NONE" &&
          pay.people.map((p) => (
            <BonusPct key={p.personId} p={p} seed={s.people.find((x) => x.personId === p.personId)!} f={f} onChange={(v) => setPerson(p.personId, { bonusPct: v })} />
          ))}
        <Line
          label="Bonus kept after tax"
          help={[
            "What a bonus adds to the household's tax on top of base pay (today's salary):",
            `Bonus ${usd(pay.bonus.gross)}: federal ${usd(-pay.bonus.extraTax.federal)} · CT ${usd(-pay.bonus.extraTax.ct)} · FICA & CT leave ${usd(-(pay.bonus.extraTax.socialSecurity + pay.bonus.extraTax.medicare + pay.bonus.extraTax.pfml))}`,
            `Kept ${usd(pay.bonus.gross - pay.bonus.extraTax.total)} = ${pct(pay.bonus.computedKeep)}`,
          ].join("\n")}
          reset={pay.bonus.keepTyped ? { label: `computed ${pct(pay.bonus.computedKeep)}`, onClick: () => set("bonus", { ...a.bonus, keepRate: null }) } : undefined}
        >
          <PercentInput size="xs" ariaLabel="Bonus kept after tax" value={pay.bonus.keepRate} onChange={(v) => set("bonus", { ...a.bonus, keepRate: v })} className={pay.bonus.keepTyped ? TYPED : ""} />
        </Line>
        <Line label="Bonus saved" help="Share of the after-tax bonus that's saved; the rest is spent (shown as Bonus spent).">
          <PercentInput size="xs" ariaLabel="Share of bonus saved" value={a.bonus.savedShare} onChange={(v) => set("bonus", { ...a.bonus, savedShare: Math.min(1, Math.max(0, v)) })} />
        </Line>

        <Group title="Markets" />
        <Line label="Return / yr" help={`Nominal return on everything invested, compounded monthly.${s.realizedReturn != null ? ` Your realized return: ${pct(s.realizedReturn)}.` : ""}`}>
          <PercentInput size="xs" ariaLabel="Investment return per year" value={a.returnRate} onChange={(v) => set("returnRate", v)} />
        </Line>
        <Line label="Inflation / yr" help="Indexes tax brackets in retirement; FIRE's today's-dollar figures.">
          <PercentInput size="xs" ariaLabel="Inflation per year" value={a.inflation} onChange={(v) => set("inflation", v)} />
        </Line>
        <Line label="Run through" help="Last year projected. Milestones and FIRE look 60 years out regardless.">
          <YearInput value={a.horizonYear} min={s.start.year + 1} max={s.start.year + 60} onChange={(v) => v != null && set("horizonYear", v)} />
        </Line>
        <p className="mt-2 text-[11px] leading-snug text-muted">
          Always keeps working. Walk-away, withdrawal and Coast settings are{" "}
          <Link href="/fire" className="text-accent hover:underline">
            FIRE
          </Link>
          &apos;s scenarios on top.
        </p>
      </div>
    </aside>
  );
}

function PersonSalary({ p, seed, onChange }: { p: ResolvedPerson; seed: OutlookSeeds["people"][number]; onChange: (patch: Partial<PersonOutlook>) => void }) {
  const same = !seed.latest || !seed.typical || seed.latest.payDate === seed.typical.payDate;
  const drop = seed.latest && seed.typical && seed.typical.regular > 0 ? seed.latest.regular / seed.typical.regular - 1 : 0;
  const check = p.paycheck;
  const help = [
    seed.note,
    check ? `${usd(check.regular)} × ${p.perYear} checks = ${usd(check.regular * p.perYear)}${p.salaryTyped ? " (overridden)" : ""}` : "No regular check.",
    seed.typical ? `Typical: ${usd(seed.typical.regular)} on ${seed.typical.payDate} (median of the last six)` : "",
    seed.latest ? `Latest: ${usd(seed.latest.regular)} on ${seed.latest.payDate}` : "",
    "Taxes reads this paycheck choice too.",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <Line
      label={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{p.name}</span>
          {!same && (
            <Segmented
              size="xs"
              ariaLabel={`${p.name}'s paycheck`}
              value={p.basis}
              onChange={(v) => onChange({ paycheck: v, salary: null })}
              options={[
                { value: "TYPICAL", label: "typ", title: "Typical check" },
                { value: "LATEST", label: "last", title: "Latest check" },
              ]}
            />
          )}
          {Math.abs(drop) >= 0.1 && (
            <span className="text-warn" title={`Latest check is ${pct(Math.abs(drop), 0)} ${drop < 0 ? "below" : "above"} the typical one. Pick the one that reflects the year ahead.`}>
              ⚠
            </span>
          )}
        </span>
      }
      help={help}
      reset={p.salaryTyped ? { label: "from the check", onClick: () => onChange({ salary: null }) } : undefined}
    >
      <MoneyInput nullable size="xs" ariaLabel={`${p.name}'s annual base salary`} cents={p.salaryTyped ? p.salary : null} placeholderCents={check ? check.regular * p.perYear : 0} onChange={(v) => onChange({ salary: v })} />
    </Line>
  );
}

function BonusPct({ p, seed, f, onChange }: { p: ResolvedPerson; seed: OutlookSeeds["people"][number]; f: Forecast; onChange: (v: number | null) => void }) {
  const hist = seed.bonusHistory.filter((h) => h.pct != null).slice(-4);
  const first = f.schedule.find((b) => b.personId === p.personId && b.source === "ESTIMATE");
  const parts = first ? f.schedule.filter((b) => b.personId === p.personId && b.source === "ESTIMATE" && b.awardYear === first.awardYear) : [];
  const help = [
    `% of base salary. Default: ${p.bonusDefault.label} (${pct(p.bonusDefault.pct, 0)}).`,
    ...seed.bonusHistory.map((h) => `${h.year}${h.partial ? " so far" : ""}: ${usd(h.bonus)} on ${usd(h.salary)} = ${pct(h.pct, 0)}`),
    parts.length ? `First estimate paid: ${parts.map((b) => `${b.label.split(" · ")[1] ?? ""} ${monthName(Number(b.key.slice(5)))} ${b.key.slice(0, 4)}`).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <Line
      label={
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate">{p.name} bonus</span>
          <span className="num truncate text-[10px] text-faint">{hist.map((h) => `’${String(h.year).slice(2)} ${pct(h.pct, 0)}`).join(" ")}</span>
        </span>
      }
      help={help}
      reset={p.bonusPctTyped ? { label: `default ${pct(p.bonusDefault.pct, 0)}`, onClick: () => onChange(null) } : undefined}
    >
      <PercentInput size="xs" ariaLabel={`${p.name}'s bonus, % of base`} value={p.bonusPct} onChange={(v) => onChange(Math.max(0, v))} className={p.bonusPctTyped ? TYPED : ""} />
    </Line>
  );
}

function OneOffs({ a, set, startYear }: { a: OutlookAssumptions; set: SetAssumption; startYear: number }) {
  const [open, setOpen] = useState(false);
  const list = a.plannedExpenses;
  const total = list.reduce((t, e) => t + e.amount, 0);
  const update = (id: string, patch: Partial<(typeof list)[number]>) => set("plannedExpenses", list.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  return (
    <>
      <Line label="Planned one-offs" help="A down payment, tuition, a car… taken from liquid money in its month.">
        <button type="button" className="w-full rounded-md border border-line-strong px-2 py-1 text-right text-xs text-fg-2 hover:bg-surface-2" onClick={() => setOpen(!open)}>
          {list.length ? `${list.length} · ${usd(total)}` : "none"} {open ? "▴" : "▾"}
        </button>
      </Line>
      {open && (
        <div className="mb-1 flex flex-col gap-1 rounded-md bg-surface-2 p-1.5">
          {list.map((e) => (
            <div key={e.id} className="grid grid-cols-[1fr_3.25rem_3.5rem_5.5rem_auto] items-center gap-1">
              <input className="min-w-0 rounded border border-line-strong bg-surface px-1.5 py-1 text-xs text-fg" placeholder="What for" defaultValue={e.label} onBlur={(ev) => update(e.id, { label: ev.target.value })} />
              <select className={`${selectCls} !px-1 !py-1`} value={e.month ?? 6} onChange={(ev) => update(e.id, { month: Number(ev.target.value) })} aria-label="Month">
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>
                    {monthName(i + 1)}
                  </option>
                ))}
              </select>
              <YearInput value={e.year} min={startYear} onChange={(v) => v != null && update(e.id, { year: v })} />
              <MoneyInput size="xs" cents={e.amount} onChange={(v) => update(e.id, { amount: v ?? 0 })} />
              <button type="button" className="px-1 text-neg" title="Remove" onClick={() => set("plannedExpenses", list.filter((x) => x.id !== e.id))}>
                ×
              </button>
            </div>
          ))}
          <button type="button" className={`${btn.ghost} !py-0.5 text-[11px]`} onClick={() => set("plannedExpenses", [...list, { id: crypto.randomUUID(), year: startYear + 1, month: 6, label: "", amount: 0 }])}>
            + Add a one-off
          </button>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- bits

function Group({ title, note }: { title: string; note?: string }) {
  return (
    <div className="mt-2.5 flex items-baseline gap-2 border-b border-line pb-0.5 first:mt-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">{title}</span>
      {note && <span className="truncate text-[10px] text-faint">{note}</span>}
    </div>
  );
}

/** One driver: label (hover for where it comes from), its input, and ↺ when it's been typed over. */
function Line({ label, help, reset, children }: { label: ReactNode; help?: string; reset?: { label: string; onClick: () => void }; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_0.875rem_6.5rem] items-center gap-1 py-[3px]">
      <span className={`min-w-0 truncate text-fg-2 ${help ? "cursor-help decoration-line-strong decoration-dotted underline-offset-2 hover:underline" : ""}`} title={help}>
        {label}
      </span>
      {reset ? (
        <button type="button" className="text-center text-accent hover:text-fg" title={`Typed over — back to ${reset.label}`} onClick={reset.onClick}>
          ↺
        </button>
      ) : (
        <span />
      )}
      <div className="flex min-w-0 items-center justify-end [&>button]:w-full [&>div]:w-full [&>input]:w-full [&>select]:w-full">{children}</div>
    </div>
  );
}

const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
