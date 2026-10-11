"use client";

import { BlockedNote, BlockedValue } from "@/components/ledger/Blocked";
import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { Badge, btn, Callout, Card, Drawer, EmptyState, ErrorNote, Field, inputCls, Loading, MoneyInput, PageBody, selectCls, StatCell, StatGrid, type Tone } from "@/components/ui/kit";
import type { GoalProgress, GoalsReport } from "@/lib/book/reports/goals";
import { formatPercentRatio, usd0, usdDelta } from "@/lib/formatMoney";
import type { Goal, GoalSettings } from "@/lib/goals/settings";
import type { AccountGroup } from "@/lib/ledger/loadLedger";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Data = { report: GoalsReport; settings: GoalSettings };

const STATUS: Record<GoalProgress["status"], { tone: Tone; label: string }> = {
  REACHED: { tone: "pos", label: "reached" },
  ON_TRACK: { tone: "pos", label: "on track" },
  BEHIND: { tone: "warn", label: "behind" },
  IN_PROGRESS: { tone: "info", label: "in progress" },
  NO_PACE: { tone: "neg", label: "not reached" },
  NO_TARGET: { tone: "neutral", label: "no target" },
};

const PRESETS: { label: string; goal: Omit<Goal, "id"> }[] = [
  { label: "Emergency fund", goal: { name: "Emergency fund", kind: "EMERGENCY_FUND", targetCents: null, months: 6, targetDate: null, groups: ["Cash"], accountIds: [] } },
  { label: "Home down payment", goal: { name: "Home down payment", kind: "AMOUNT", targetCents: 20_000_000, months: null, targetDate: null, groups: ["Cash", "Taxable investments"], accountIds: [] } },
  { label: "Custom goal", goal: { name: "New goal", kind: "AMOUNT", targetCents: 1_000_000, months: null, targetDate: null, groups: [], accountIds: [] } },
];

const fmtDate = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" }) : "—");

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

  const r = data?.report;
  return (
    <PageBody>
      <ApiSecretField api={api} />
      {error && <ErrorNote>{error}</ErrorNote>}
      {!data || !r ? (
        api.ready && !error && <Loading label="Valuing the accounts behind each goal…" />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-3xl text-xs text-muted">
              Balances as of {r.asOf}, the last day every account has a statement. Goals are funded in the order listed: when two draw on the same account, the higher one gets its money first.
            </p>
            <div className="flex gap-2">
              {PRESETS.map((p) => (
                <button key={p.label} type="button" className={btn.secondary} onClick={() => setEditing({ ...p.goal, id: crypto.randomUUID().slice(0, 12) })}>
                  + {p.label}
                </button>
              ))}
            </div>
          </div>
          {r.goals.length === 0 ? (
            <EmptyState title="No goals yet">Add an emergency fund, a down payment or any target above; progress comes straight from the accounts you pick.</EmptyState>
          ) : (
            r.goals.map((g, i) => <GoalCard key={g.goal.id} g={g} r={r} first={i === 0} last={i === r.goals.length - 1} onEdit={() => setEditing(g.goal)} onMove={(by) => move(g.goal.id, by)} />)
          )}
        </>
      )}
      {editing && data && (
        <GoalEditor
          goal={editing}
          accounts={data.report.accounts}
          groups={data.report.groups}
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

function GoalCard({ g, r, first, last, onEdit, onMove }: { g: GoalProgress; r: GoalsReport; first: boolean; last: boolean; onEdit: () => void; onMove: (by: number) => void }) {
  const s = STATUS[g.status];
  const share = g.targetCents ? Math.min(1, g.currentCents / g.targetCents) : 0;
  const blocked = g.blockers.length > 0;
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {g.goal.name}
          <Badge tone={s.tone}>{s.label}</Badge>
        </span>
      }
      subtitle={
        g.goal.kind === "EMERGENCY_FUND"
          ? r.monthlySpending
            ? `${g.goal.months} months of spending at ${usd0(r.monthlySpending.cents)}/month (average of the last ${r.monthlySpending.months} proven months)`
            : "Needs proven months of spending to size the target"
          : g.goal.targetDate
            ? `By ${fmtDate(g.goal.targetDate)}`
            : "No deadline"
      }
      actions={
        <>
          <button type="button" className={btn.ghost} disabled={first} onClick={() => onMove(-1)} aria-label="Move up">
            ↑
          </button>
          <button type="button" className={btn.ghost} disabled={last} onClick={() => onMove(1)} aria-label="Move down">
            ↓
          </button>
          <button type="button" className={btn.secondary} onClick={onEdit}>
            Edit
          </button>
        </>
      }
    >
      <BlockedNote what="this goal's balance" blockers={g.blockers} />
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="num text-fg">
          {blocked ? <BlockedValue blockers={g.blockers} /> : usd0(g.currentCents)} <span className="text-muted">of {g.targetCents == null ? "—" : usd0(g.targetCents)}</span>
        </span>
        <span className="num text-muted">{g.targetCents ? formatPercentRatio(share, 0) : ""}</span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-surface-3" role="meter" aria-valuenow={g.currentCents} aria-valuemax={g.targetCents ?? undefined} aria-label={`${g.goal.name} progress`}>
        <div className={`h-full rounded-full ${g.status === "REACHED" ? "bg-pos" : "bg-accent"}`} style={{ width: `${share * 100}%` }} />
      </div>
      <div className="mt-3">
        <StatGrid cols={4}>
          <StatCell label="Still needed" value={g.targetCents == null ? "—" : usd0(Math.max(0, g.targetCents - g.currentCents))} />
          <StatCell
            label="Actual pace"
            value={g.pace ? `${usdDelta(g.pace.monthlyCents)}/mo` : "—"}
            tone={g.pace && g.pace.monthlyCents < 0 ? "neg" : "neutral"}
            sub={g.pace ? `funding accounts, ${g.pace.from} → ${g.pace.to} (deposits + growth)` : "under two months of history"}
          />
          <StatCell label="Needed to hit the date" value={g.neededMonthlyCents == null ? "—" : `${usd0(g.neededMonthlyCents)}/mo`} sub={g.goal.targetDate ? `until ${fmtDate(g.goal.targetDate)}` : "no deadline set"} />
          <StatCell
            label={g.projectedFrom === "FORECAST" ? "Reached (forecast)" : "At this pace"}
            value={g.status === "REACHED" ? "done" : fmtDate(g.projectedDate)}
            sub={
              g.status === "REACHED" ? undefined : g.projectedFrom === "FORECAST" ? (
                <>
                  {g.projectedDate ? "new savings fill goals in priority order" : "the forecast never gets there"} ·{" "}
                  <Link href="/forecast" className="underline hover:text-fg">
                    Forecast
                  </Link>
                </>
              ) : g.projectedDate ? undefined : (
                "won't get there without more saving"
              )
            }
          />
        </StatGrid>
      </div>
      {g.pace && g.pace.blockers.length > 0 && (
        <p className="mt-2 text-xs text-warn">The pace window depends on data that isn&apos;t proven yet ({g.pace.blockers.length} finding{g.pace.blockers.length === 1 ? "" : "s"}); treat it as a guide.</p>
      )}
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-muted">
          Funded by {g.accounts.length} account{g.accounts.length === 1 ? "" : "s"} ({usd0(g.fundingCents)})
          {g.sharedWith.length > 0 && ` · shared with ${g.sharedWith.join(", ")}`}
        </summary>
        <ul className="mt-1 flex flex-col gap-0.5">
          {g.accounts.map((a) => (
            <li key={a.id} className="flex justify-between gap-4">
              <span>{a.name}</span>
              <span className="num text-muted">
                {usd0(a.earmarkedCents)} of {usd0(a.cents)}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

function GoalEditor({
  goal,
  accounts,
  groups,
  isNew,
  onClose,
  onSave,
  onDelete,
}: {
  goal: Goal;
  accounts: GoalsReport["accounts"];
  groups: AccountGroup[];
  isNew: boolean;
  onClose: () => void;
  onSave: (g: Goal) => void;
  onDelete: () => void;
}) {
  const [g, setG] = useState(goal);
  const toggleGroup = (x: AccountGroup) => setG({ ...g, groups: g.groups.includes(x) ? g.groups.filter((y) => y !== x) : [...g.groups, x] });
  const toggleAccount = (id: string) => setG({ ...g, accountIds: g.accountIds.includes(id) ? g.accountIds.filter((y) => y !== id) : [...g.accountIds, id] });
  return (
    <Drawer open onClose={onClose} title={isNew ? "New goal" : `Edit ${goal.name}`}>
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <input className={inputCls} value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} />
        </Field>
        <Field label="Target">
          <select className={selectCls} value={g.kind} onChange={(e) => setG({ ...g, kind: e.target.value as Goal["kind"], months: e.target.value === "EMERGENCY_FUND" ? (g.months ?? 6) : null })}>
            <option value="AMOUNT">A fixed amount</option>
            <option value="EMERGENCY_FUND">Months of spending (emergency fund)</option>
          </select>
        </Field>
        {g.kind === "AMOUNT" ? (
          <Field label="Amount">
            <MoneyInput cents={g.targetCents} onChange={(c) => setG({ ...g, targetCents: c })} allowNegative={false} />
          </Field>
        ) : (
          <Field label="Months of spending" hint="3–6 is the usual range; more if income is variable.">
            <input type="number" min={1} max={36} className={`${inputCls} w-24`} value={g.months ?? 6} onChange={(e) => setG({ ...g, months: Number(e.target.value) || null })} />
          </Field>
        )}
        <Field label="Target date" hint="Leave blank for no deadline.">
          <input type="date" className={`${inputCls} w-44`} value={g.targetDate ?? ""} onChange={(e) => setG({ ...g, targetDate: e.target.value || null })} />
        </Field>
        <Field label="Funded by account groups" hint="Every account in a checked group counts, including ones added later.">
          <div className="flex flex-wrap gap-3">
            {groups.map((x) => (
              <label key={x} className="flex items-center gap-1.5 text-xs text-fg">
                <input type="checkbox" checked={g.groups.includes(x)} onChange={() => toggleGroup(x)} /> {x}
              </label>
            ))}
          </div>
        </Field>
        <Field label="…and these accounts">
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            {accounts
              .filter((a) => !g.groups.includes(a.group))
              .map((a) => (
                <label key={a.id} className="flex items-center justify-between gap-3 text-xs text-fg">
                  <span className="flex items-center gap-1.5">
                    <input type="checkbox" checked={g.accountIds.includes(a.id)} onChange={() => toggleAccount(a.id)} /> {a.name}
                  </span>
                  <span className="num text-muted">{usd0(a.cents)}</span>
                </label>
              ))}
          </div>
        </Field>
        {g.groups.some((x) => x === "Retirement" || x === "Health savings") && (
          <Callout tone="warn">Retirement and HSA money is taxed and penalized if withdrawn early; it rarely belongs in a short-term goal.</Callout>
        )}
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
