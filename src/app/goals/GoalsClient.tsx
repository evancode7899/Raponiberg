"use client";

import { BlockedNote, BlockedValue } from "@/components/ledger/Blocked";
import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { Badge, btn, Callout, Card, Drawer, EmptyState, ErrorNote, Field, inputCls, Loading, MoneyInput, PageBody, type Tone } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import type { ProofTarget } from "@/components/ui/proof/context";
import type { GoalFigure } from "@/lib/book/proof/planningProof";
import type { GoalProgress, GoalsReport } from "@/lib/book/reports/goals";
import { formatPercentRatio, usd0, usdCompact, usdDelta } from "@/lib/formatMoney";
import type { Goal, GoalSettings } from "@/lib/goals/settings";
import type { AccountGroup } from "@/lib/ledger/loadLedger";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Data = { report: GoalsReport; settings: GoalSettings };

const STATUS: Record<GoalProgress["status"], { tone: Tone; label: string; ink: string; bg: string }> = {
  REACHED: { tone: "pos", label: "done", ink: "text-pos", bg: "bg-pos" },
  ON_TRACK: { tone: "pos", label: "on track", ink: "text-pos", bg: "bg-pos" },
  BEHIND: { tone: "warn", label: "behind", ink: "text-warn", bg: "bg-warn" },
  IN_PROGRESS: { tone: "info", label: "in progress", ink: "text-info", bg: "bg-info" },
  NO_PACE: { tone: "neg", label: "not reached", ink: "text-neg", bg: "bg-neg" },
  NO_TARGET: { tone: "neutral", label: "no target", ink: "text-muted", bg: "bg-line-strong" },
};

/** The three things a goal can be; each is a kind + funding pair with sensible defaults for a new one. */
type GoalType = "EMERGENCY" | "SAVE" | "MILESTONE";
const TYPES: { type: GoalType; label: string; blurb: string; preset: Omit<Goal, "id"> }[] = [
  {
    type: "EMERGENCY",
    label: "Emergency fund",
    blurb: "Months of spending kept in cash",
    preset: { name: "Emergency fund", kind: "EMERGENCY_FUND", targetCents: null, months: 6, targetDate: null, groups: ["Cash"], accountIds: [], funding: "SET_ASIDE", shares: {} },
  },
  {
    type: "SAVE",
    label: "Save for something",
    blurb: "Money set aside: a down payment, a car",
    preset: { name: "New goal", kind: "AMOUNT", targetCents: 5_000_000, months: null, targetDate: null, groups: ["Cash"], accountIds: [], funding: "SET_ASIDE", shares: {} },
  },
  {
    type: "MILESTONE",
    label: "Milestone",
    blurb: "A total to pass, like $1M net worth",
    preset: {
      name: "Net worth milestone",
      kind: "AMOUNT",
      targetCents: 100_000_000,
      months: null,
      targetDate: null,
      groups: ["Cash", "Taxable investments", "Retirement", "Health savings"],
      accountIds: [],
      funding: "TRACK",
      shares: {},
    },
  },
];
const typeOf = (g: Goal): GoalType => (g.funding === "TRACK" ? "MILESTONE" : g.kind === "EMERGENCY_FUND" ? "EMERGENCY" : "SAVE");

const fmtMonth = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" }) : "—");
const monthIndex = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A goal figure's proof ("planning" kind). */
const goalProof = (g: GoalProgress, figure: GoalFigure, shownCents: number | null): ProofTarget => ({
  descriptor: { report: "planning", page: "goals", figure, goalId: g.goal.id },
  shownCents,
});

/** One sentence on where the goal stands: when it lands against its date, or why it doesn't. */
function verdict(g: GoalProgress, r: GoalsReport): string {
  const pace = g.projectedFrom === "PACE" ? " at last year's pace" : "";
  switch (g.status) {
    case "REACHED":
      return g.goal.kind === "EMERGENCY_FUND" ? `Fully funded: ${g.goal.months} months of spending covered` : "Fully funded";
    case "ON_TRACK":
    case "BEHIND": {
      const gap = monthIndex(g.goal.targetDate!) - monthIndex(g.projectedDate!);
      if (gap === 0) return `Lands ${fmtMonth(g.projectedDate)}${pace}, right on time`;
      return gap > 0
        ? `Lands ${fmtMonth(g.projectedDate)}${pace}, ${plural(gap, "month")} early`
        : `Lands ${fmtMonth(g.projectedDate)}${pace}, ${plural(-gap, "month")} after ${fmtMonth(g.goal.targetDate)}`;
    }
    case "IN_PROGRESS":
      return `Lands around ${fmtMonth(g.projectedDate)}${pace}`;
    case "NO_PACE":
      return g.projectedFrom === "FORECAST" ? "The forecast never gets there" : "These accounts aren't growing, so it never gets there";
    case "NO_TARGET":
      return r.monthlySpending ? "No target set" : "Needs proven months of spending to size the target";
  }
}

/** "Cash + Taxable investments", plus any accounts picked one by one. */
function fundedBy(goal: Goal, r: GoalsReport): string {
  const names = goal.accountIds.map((id) => r.accounts.find((a) => a.id === id)?.name).filter((n): n is string => !!n);
  const parts = [...goal.groups, ...(names.length <= 2 ? names : [plural(names.length, "account")])];
  return parts.length ? parts.join(" + ") : "nothing yet";
}

export function GoalsClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [data, setData] = useState(() => cachedResponse<Data>("/api/goals"));
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Goal | null>(null);

  const load = useCallback(() => {
    api
      .call<Data>("/api/goals")
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [api]);
  useEffect(() => {
    if (api.ready) load();
  }, [api, load]);

  const saveGoals = async (goals: Goal[]) => {
    try {
      await api.call("/api/goals", { method: "PUT", json: { goals } });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const goals = data?.settings.goals ?? [];
  const upsert = (g: Goal) => saveGoals(goals.some((x) => x.id === g.id) ? goals.map((x) => (x.id === g.id ? g : x)) : [...goals, g]);
  const move = (id: string, by: number) => {
    const i = goals.findIndex((g) => g.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= goals.length) return;
    const next = [...goals];
    [next[i], next[j]] = [next[j]!, next[i]!];
    saveGoals(next);
  };
  const startNew = (type: GoalType = "SAVE") => setEditing({ ...TYPES.find((t) => t.type === type)!.preset, id: crypto.randomUUID().slice(0, 12) });

  const r = data?.report;
  return (
    <PageBody>
      <ApiSecretField api={api} />
      {error && <ErrorNote>{error}</ErrorNote>}
      {!data || !r ? (
        api.ready && !error && <Loading label="Valuing the accounts behind each goal…" />
      ) : r.goals.length === 0 ? (
        <EmptyState
          title="No goals yet"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {TYPES.map((t) => (
                <button key={t.type} type="button" className={btn.secondary} onClick={() => startNew(t.type)}>
                  + {t.label}
                </button>
              ))}
            </div>
          }
        >
          Pick what you&apos;re saving for and which kinds of account pay for it. Progress comes straight from those balances, and the forecast says when you&apos;ll get there.
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Summary r={r} />
            <button type="button" className={btn.primary} onClick={() => startNew()}>
              + New goal
            </button>
          </div>
          <Starved r={r} onTrack={(g) => upsert({ ...g, funding: "TRACK" })} />
          <Roadmap r={r} />
          <div className="grid gap-3 lg:grid-cols-2">
            {r.goals.map((g, i) => (
              <GoalCard key={g.goal.id} g={g} r={r} rank={i + 1} last={i === r.goals.length - 1} onEdit={() => setEditing(g.goal)} onMove={(by) => move(g.goal.id, by)} />
            ))}
          </div>
          <p
            className="cursor-help text-[11px] text-muted"
            title="Goals higher in the list claim money first, so two savings goals never count the same dollar. A milestone counts whole balances and claims nothing. When each goal lands comes from the shared forecast: new money fills unfinished goals in list order."
          >
            Balances as of {fmtMonth(r.asOf)}, the last month every account has a statement · order sets who gets money first
          </p>
        </>
      )}
      {editing && data && (
        <GoalEditor
          goal={editing}
          r={data.report}
          isNew={!goals.some((g) => g.id === editing.id)}
          onClose={() => setEditing(null)}
          onSave={(g) => {
            upsert(g);
            setEditing(null);
          }}
          onDelete={() => {
            saveGoals(goals.filter((g) => g.id !== editing.id));
            setEditing(null);
          }}
        />
      )}
    </PageBody>
  );
}

/** "3 goals: 1 done, 1 on track, 1 behind". */
function Summary({ r }: { r: GoalsReport }) {
  const counts = new Map<GoalProgress["status"], number>();
  for (const g of r.goals) counts.set(g.status, (counts.get(g.status) ?? 0) + 1);
  const order: GoalProgress["status"][] = ["REACHED", "ON_TRACK", "IN_PROGRESS", "BEHIND", "NO_PACE", "NO_TARGET"];
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <span className="text-sm font-semibold text-fg">{plural(r.goals.length, "goal")}</span>
      {order
        .filter((s) => counts.has(s))
        .map((s) => (
          <span key={s} className={`text-xs ${STATUS[s].ink}`}>
            <span className={`mr-1.5 inline-block h-2 w-2 rounded-full align-middle ${STATUS[s].bg}`} aria-hidden />
            {counts.get(s)} {STATUS[s].label}
          </span>
        ))}
    </div>
  );
}

/**
 * When every goal lands, on one time axis: a line from today to the month the forecast
 * fills it, and a tick at its target date, so early and late read at a glance.
 */
function Roadmap({ r }: { r: GoalsReport }) {
  const open = r.goals.filter((g) => g.status !== "REACHED");
  if (!open.length) return null;
  const start = new Date(`${r.asOf}T00:00:00`).getTime();
  const dates = open.flatMap((g) => [g.projectedDate, g.goal.targetDate]).filter((d): d is string => !!d && d > r.asOf);
  const minEnd = new Date(`${r.asOf}T00:00:00`);
  minEnd.setFullYear(minEnd.getFullYear() + 3);
  const lastYear = Math.max(minEnd.getFullYear(), ...dates.map((d) => Number(d.slice(0, 4))));
  const end = new Date(lastYear + 1, 0, 1).getTime();
  const pct = (iso: string) => Math.min(100, Math.max(0, ((new Date(`${iso}T00:00:00`).getTime() - start) / (end - start)) * 100));
  const years: number[] = [];
  for (let y = Number(r.asOf.slice(0, 4)) + 1; y <= lastYear; y++) years.push(y);

  return (
    <Card title="When each goal lands" subtitle="From the shared forecast. The line ends where the goal is filled; the tick is its target date.">
      <div className="grid grid-cols-1 items-center gap-x-3 gap-y-1 text-xs sm:grid-cols-[minmax(7rem,11rem)_1fr]">
        <span className="hidden sm:block" />
        <div className="relative h-5 text-[11px] text-muted">
          {(!years.length || pct(`${years[0]}-01-01`) > 12) && <span className="absolute left-0">now</span>}
          {years.map((y) => (
            <span key={y} className="num absolute -translate-x-1/2" style={{ left: `${pct(`${y}-01-01`)}%` }}>
              {y}
            </span>
          ))}
        </div>
        {r.goals.map((g) => {
          const s = STATUS[g.status];
          const done = g.status === "REACHED";
          const at = done ? 0 : g.projectedDate ? pct(g.projectedDate) : 100;
          // The month sits above its dot, kept inside the track at either end.
          const labelX = at < 6 ? { left: "0" } : at > 94 ? { right: "0" } : { left: `${at}%`, transform: "translateX(-50%)" };
          return (
            <div key={g.goal.id} className="contents">
              <span className="mt-2 truncate text-fg sm:mt-0" title={g.goal.name}>
                {g.goal.name}
              </span>
              <div className="relative h-10">
                {years.map((y) => (
                  <span key={y} className="absolute inset-y-0 w-px bg-line" style={{ left: `${pct(`${y}-01-01`)}%` }} aria-hidden />
                ))}
                {g.goal.targetDate && !done && (
                  <span
                    className="absolute bottom-1 top-4 w-0.5 -translate-x-1/2 rounded bg-fg-2"
                    style={{ left: `${pct(g.goal.targetDate)}%` }}
                    title={`Target: ${fmtMonth(g.goal.targetDate)}`}
                    aria-label={`Target ${fmtMonth(g.goal.targetDate)}`}
                  />
                )}
                {done ? (
                  <span className="absolute left-0 top-[1.4rem] -translate-y-1/2 text-[11px] font-medium text-pos">✓ done</span>
                ) : (
                  <>
                    <span
                      className={`absolute left-0 top-[1.6rem] h-1 -translate-y-1/2 rounded-full ${g.projectedDate ? s.bg : "bg-gradient-to-r from-neg to-transparent"}`}
                      style={{ width: `${at}%` }}
                      aria-hidden
                    />
                    {g.projectedDate ? (
                      <>
                        <span
                          className={`absolute top-[1.6rem] h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface ${s.bg}`}
                          style={{ left: `${at}%` }}
                          title={verdict(g, r)}
                        />
                        <span className={`num absolute top-0 whitespace-nowrap text-[11px] font-medium ${s.ink}`} style={labelX}>
                          <ProofValue proof={goalProof(g, "lands", null)}>{fmtMonth(g.projectedDate)}</ProofValue>
                        </span>
                      </>
                    ) : (
                      <span className="absolute right-0 top-0 text-[11px] text-neg">not in the forecast</span>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function GoalCard({ g, r, rank, last, onEdit, onMove }: { g: GoalProgress; r: GoalsReport; rank: number; last: boolean; onEdit: () => void; onMove: (by: number) => void }) {
  const track = g.goal.funding === "TRACK";
  const s = STATUS[g.status];
  const share = g.targetCents ? Math.min(1, g.currentCents / g.targetCents) : 0;
  const blocked = g.blockers.length > 0;
  const left = g.targetCents == null ? null : Math.max(0, g.targetCents - g.currentCents);
  /** Earlier goals took money this one needed. */
  const crowded = !track && g.claimedFirstBy.length > 0 && (g.currentCents === 0 || g.status === "BEHIND" || g.status === "NO_PACE");
  const takenFirst = g.claimedBeforeCents;

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="num flex h-5 w-5 items-center justify-center rounded bg-surface-3 text-[11px] text-muted" title="Order: goals higher in the list get money first">
            {rank}
          </span>
          {g.goal.name}
          <Badge tone={s.tone}>{s.label}</Badge>
          {track && (
            <Badge tone="neutral" title="Counts whole balances and claims nothing, so savings goals can use the same money.">
              milestone
            </Badge>
          )}
        </span>
      }
      actions={
        <>
          <button type="button" className={btn.ghost} disabled={rank === 1} onClick={() => onMove(-1)} aria-label="Move up" title="Move up">
            ↑
          </button>
          <button type="button" className={btn.ghost} disabled={last} onClick={() => onMove(1)} aria-label="Move down" title="Move down">
            ↓
          </button>
          <button type="button" className={btn.secondary} onClick={onEdit}>
            Edit
          </button>
        </>
      }
    >
      <BlockedNote what="this goal's balance" blockers={g.blockers} />
      <div className="flex items-baseline justify-between gap-3">
        <span className="num text-2xl font-semibold tracking-tight text-fg">
          {blocked ? <BlockedValue blockers={g.blockers} /> : <ProofValue proof={goalProof(g, "current", g.currentCents)}>{usd0(g.currentCents)}</ProofValue>}
          <span className="ml-1.5 text-sm font-normal text-muted">
            of {g.targetCents == null ? "—" : <ProofValue proof={goalProof(g, "target", g.targetCents)}>{usd0(g.targetCents)}</ProofValue>}
          </span>
        </span>
        {g.targetCents != null && <span className={`num text-sm font-semibold ${s.ink}`}>{formatPercentRatio(share, 0)}</span>}
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-3" role="meter" aria-valuenow={g.currentCents} aria-valuemax={g.targetCents ?? undefined} aria-label={`${g.goal.name} progress`}>
        <div className={`h-full rounded-full ${s.bg}`} style={{ width: `${share * 100}%` }} />
      </div>
      <p className={`mt-3 text-sm font-medium ${s.ink}`}>
        <ProofValue proof={goalProof(g, "lands", null)}>{verdict(g, r)}</ProofValue>
      </p>
      <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
        {left != null && left > 0 && (
          <div>
            <dt className="inline">To go </dt>
            <dd className="num inline text-fg-2">
              <ProofValue proof={goalProof(g, "to-go", left)}>{usd0(left)}</ProofValue>
            </dd>
          </div>
        )}
        {g.status === "BEHIND" && g.neededMonthlyCents != null && (
          <div title={`Saving this much a month from now fills it by ${fmtMonth(g.goal.targetDate)}`}>
            <dt className="inline">Needs </dt>
            <dd className="num inline text-fg-2">
              <ProofValue proof={goalProof(g, "needed", g.neededMonthlyCents)}>{usdCompact(g.neededMonthlyCents)}</ProofValue>/mo
            </dd>
          </div>
        )}
        {/* The forecast decides when a goal lands; last year's pace only stands in without one. */}
        {g.pace && g.projectedFrom === "PACE" && g.status !== "REACHED" && (
          <div title={`How much these accounts grew a month, ${g.pace.from} → ${g.pace.to}: deposits plus growth${g.pace.blockers.length ? ". Part of this window isn't proven yet." : ""}`}>
            <dt className="inline">Last year </dt>
            <dd className={`num inline ${g.pace.monthlyCents < 0 ? "text-neg" : "text-fg-2"}`}>{usdDelta(g.pace.monthlyCents)}/mo</dd>
          </div>
        )}
        <div>
          <dt className="inline">{track ? "Counts " : "From "}</dt>
          <dd className="inline text-fg-2">{fundedBy(g.goal, r)}</dd>
        </div>
        {g.goal.kind === "EMERGENCY_FUND" && r.monthlySpending && (
          <div title={`Average of the last ${r.monthlySpending.months} proven months`}>
            <dt className="inline">Spending </dt>
            <dd className="num inline text-fg-2">
              <ProofValue proof={{ descriptor: { report: "planning", page: "goals", figure: "spending" }, shownCents: r.monthlySpending.cents }}>{usdCompact(r.monthlySpending.cents)}</ProofValue>/mo
            </dd>
          </div>
        )}
      </dl>
      {crowded && (
        <p className="mt-2 text-xs text-warn">
          {g.claimedFirstBy.join(" and ")} {g.claimedFirstBy.length === 1 ? "gets" : "get"} {usd0(takenFirst)} of this money first. Move this goal up, or give{" "}
          {g.claimedFirstBy.length === 1 ? "that goal" : "those goals"} only a share of the accounts.
        </p>
      )}
      {g.projectedFrom === "FORECAST" && g.status !== "REACHED" && (
        <Link href="/forecast" className="mt-2 inline-block text-[11px] text-muted underline hover:text-fg">
          What the forecast assumes
        </Link>
      )}
    </Card>
  );
}

function GoalEditor({ goal, r, isNew, onClose, onSave, onDelete }: { goal: Goal; r: GoalsReport; isNew: boolean; onClose: () => void; onSave: (g: Goal) => void; onDelete: () => void }) {
  const [g, setG] = useState(goal);
  const type = typeOf(g);
  const track = g.funding === "TRACK";
  const pickType = (t: GoalType) => {
    const preset = TYPES.find((x) => x.type === t)!.preset;
    // A new goal takes the type's defaults wholesale; an existing one keeps its name, accounts and date.
    if (isNew) setG({ ...preset, id: g.id, targetDate: g.targetDate });
    else setG({ ...g, kind: preset.kind, funding: preset.funding, months: preset.kind === "EMERGENCY_FUND" ? (g.months ?? 6) : null, targetCents: preset.kind === "AMOUNT" ? (g.targetCents ?? preset.targetCents) : null });
  };
  const toggleGroup = (x: AccountGroup) => setG({ ...g, groups: g.groups.includes(x) ? g.groups.filter((y) => y !== x) : [...g.groups, x] });
  const toggleAccount = (id: string) => setG({ ...g, accountIds: g.accountIds.includes(id) ? g.accountIds.filter((y) => y !== id) : [...g.accountIds, id] });
  const funders = r.accounts.filter((a) => g.groups.includes(a.group) || g.accountIds.includes(a.id));
  const groupTotal = (x: AccountGroup) => r.accounts.filter((a) => a.group === x).reduce((s, a) => s + a.cents, 0);
  const setShare = (id: string, pct: number | null) => {
    const shares = { ...g.shares };
    if (pct == null || pct >= 100) delete shares[id];
    else shares[id] = Math.max(0, pct) / 100;
    setG({ ...g, shares });
  };
  /** What other savings goals already take from an account, from the last saved claims. */
  const otherClaims = (id: string) =>
    (r.funding.find((f) => f.id === id)?.claims ?? [])
      .filter((c) => c.goalId !== g.id)
      .map((c) => `${c.name} ${usdCompact(c.cents)}`)
      .join(", ");
  const tuned = g.accountIds.length > 0 || Object.keys(g.shares).length > 0;

  return (
    <Drawer open onClose={onClose} title={isNew ? "New goal" : `Edit ${goal.name}`}>
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Kind of goal">
          {TYPES.map((t) => {
            const on = type === t.type;
            return (
              <button
                key={t.type}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => pickType(t.type)}
                className={`rounded-md border px-2.5 py-2 text-left transition-colors ${on ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong"}`}
              >
                <div className={`text-xs font-semibold ${on ? "text-accent" : "text-fg"}`}>{t.label}</div>
                <div className="mt-0.5 text-[11px] leading-snug text-muted">{t.blurb}</div>
              </button>
            );
          })}
        </div>

        <Field label="Name">
          <input className={inputCls} value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} />
        </Field>

        <div className="flex flex-wrap gap-4">
          {g.kind === "AMOUNT" ? (
            <Field label="Target" className="w-48">
              <MoneyInput cents={g.targetCents} onChange={(c) => setG({ ...g, targetCents: c })} allowNegative={false} />
            </Field>
          ) : (
            <Field label="Months of spending" hint={r.monthlySpending ? `= ${usd0(Math.round(r.monthlySpending.cents * (g.months ?? 6)))} at ${usdCompact(r.monthlySpending.cents)}/mo` : "3–6 is usual"}>
              <input type="number" min={1} max={36} className={`${inputCls} w-24`} value={g.months ?? 6} onChange={(e) => setG({ ...g, months: Number(e.target.value) || null })} />
            </Field>
          )}
          <Field label="By" hint="Optional">
            <input type="date" className={`${inputCls} w-44`} value={g.targetDate ?? ""} onChange={(e) => setG({ ...g, targetDate: e.target.value || null })} />
          </Field>
        </div>

        <Field label={track ? "Counts" : "Paid from"} hint={track ? "Whole balances count; nothing is set aside." : "Every account of each kind counts, including ones added later."}>
          <div className="flex flex-wrap gap-2">
            {r.groups.map((x) => {
              const on = g.groups.includes(x);
              return (
                <button
                  key={x}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleGroup(x)}
                  className={`rounded-full border px-3 py-1 text-xs transition-colors ${on ? "border-accent bg-accent-soft text-accent" : "border-line text-fg-2 hover:border-line-strong"}`}
                >
                  {x} <span className="num text-muted">{usdCompact(groupTotal(x))}</span>
                </button>
              );
            })}
          </div>
        </Field>

        {!track && g.groups.some((x) => x === "Retirement" || x === "Health savings") && (
          <Callout tone="warn">Retirement and HSA money is taxed and penalized if withdrawn early; it rarely belongs in a savings goal.</Callout>
        )}

        <details className="rounded-md border border-line px-3 py-2 text-xs" open={tuned}>
          <summary className="cursor-pointer text-muted">Fine-tune: single accounts{track ? "" : " and shares"}</summary>
          <div className="mt-2 flex flex-col gap-3">
            {r.accounts.some((a) => !g.groups.includes(a.group)) && (
              <div>
                <div className="mb-1 text-[11px] font-medium text-muted">Add a single account</div>
                <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                  {r.accounts
                    .filter((a) => !g.groups.includes(a.group))
                    .map((a) => (
                      <label key={a.id} className="flex items-center justify-between gap-3 text-fg">
                        <span className="flex items-center gap-1.5">
                          <input type="checkbox" checked={g.accountIds.includes(a.id)} onChange={() => toggleAccount(a.id)} /> {a.name}
                        </span>
                        <span className="num text-muted">{usdCompact(a.cents)}</span>
                      </label>
                    ))}
                </div>
              </div>
            )}
            {!track && funders.length > 0 && (
              <div>
                <div className="mb-1 text-[11px] font-medium text-muted">Most this goal may take of each account (under 100% leaves the rest for goals below)</div>
                <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                  {funders.map((a) => {
                    const others = otherClaims(a.id);
                    return (
                      <label key={a.id} className="flex items-center justify-between gap-3 text-fg">
                        <span className="min-w-0">
                          <span className="block truncate">{a.name}</span>
                          {others && <span className="block truncate text-[11px] text-muted">also: {others}</span>}
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={5}
                            className={`${inputCls} w-20 py-1 text-right`}
                            value={g.shares[a.id] == null ? 100 : Math.round(g.shares[a.id]! * 100)}
                            onChange={(e) => setShare(a.id, e.target.value === "" ? null : Number(e.target.value))}
                            aria-label={`Share of ${a.name}`}
                          />
                          <span className="text-muted">%</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </details>

        <div className="flex justify-between gap-2 border-t border-line pt-3">
          {!isNew ? (
            <button type="button" className={btn.danger} onClick={onDelete}>
              Delete goal
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" className={btn.secondary} onClick={onClose}>
              Cancel
            </button>
            <button type="button" className={btn.primary} disabled={!g.name.trim() || (!g.groups.length && !g.accountIds.length)} onClick={() => onSave(g)}>
              Save goal
            </button>
          </div>
        </div>
      </div>
    </Drawer>
  );
}

/**
 * A savings goal that takes every dollar of accounts a later goal needs, leaving that goal
 * nothing: usually a milestone ("$1M net worth") entered as a savings goal. Offers to make it one.
 */
function Starved({ r, onTrack }: { r: GoalsReport; onTrack: (g: Goal) => void }) {
  const starved = r.goals.filter((g) => g.goal.funding === "SET_ASIDE" && g.currentCents === 0 && g.claimedFirstBy.length > 0 && g.status !== "REACHED");
  if (!starved.length) return null;
  const culprits = r.goals.filter((g) => g.goal.funding === "SET_ASIDE" && starved.some((x) => x.claimedFirstBy.includes(g.goal.name)));
  return (
    <Callout
      tone="warn"
      title={`${starved.map((g) => g.goal.name).join(", ")} ${starved.length === 1 ? "gets" : "get"} nothing: ${culprits.map((g) => g.goal.name).join(" and ")} took the money first`}
      action={
        <span className="flex flex-wrap gap-2">
          {culprits.map((g) => (
            <button key={g.goal.id} type="button" className={btn.secondary} onClick={() => onTrack(g.goal)}>
              Make {g.goal.name} a milestone
            </button>
          ))}
        </span>
      }
    >
      If {culprits.length === 1 ? "it's" : "they're"} really a total to pass rather than money to spend, a milestone counts the same balances without taking them.
    </Callout>
  );
}
