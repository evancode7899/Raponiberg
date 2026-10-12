"use client";

import { BlockedNote, BlockedValue } from "@/components/ledger/Blocked";
import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { Badge, btn, Callout, Card, Drawer, EmptyState, ErrorNote, Field, inputCls, Loading, MoneyInput, PageBody, selectCls, StatCell, StatGrid, type Tone } from "@/components/ui/kit";
import type { FundingRow, GoalProgress, GoalsReport } from "@/lib/book/reports/goals";
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
  { label: "Emergency fund", goal: { name: "Emergency fund", kind: "EMERGENCY_FUND", targetCents: null, months: 6, targetDate: null, groups: ["Cash"], accountIds: [], funding: "SET_ASIDE", shares: {} } },
  { label: "Home down payment", goal: { name: "Home down payment", kind: "AMOUNT", targetCents: 20_000_000, months: null, targetDate: null, groups: ["Cash", "Taxable investments"], accountIds: [], funding: "SET_ASIDE", shares: {} } },
  {
    label: "Milestone",
    goal: {
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
  { label: "Custom goal", goal: { name: "New goal", kind: "AMOUNT", targetCents: 1_000_000, months: null, targetDate: null, groups: [], accountIds: [], funding: "SET_ASIDE", shares: {} } },
];

/** Each goal's colour on the funding map and its card, by its place in the list. */
const goalColor = (i: number) => `var(--chart-series-${i % 8})`;

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
              Balances as of {r.asOf}, the last day every account has a statement. A <span className="text-fg">set-aside</span> goal claims money, so no two of them count the same dollar:
              when two draw on the same account, the higher one claims first (up to its share of the account). A <span className="text-fg">milestone</span> counts whole balances and claims
              nothing.
            </p>
            <div className="flex gap-2">
              {PRESETS.map((p) => (
                <button key={p.label} type="button" className={btn.secondary} onClick={() => setEditing({ ...p.goal, id: crypto.randomUUID().slice(0, 12) })}>
                  + {p.label}
                </button>
              ))}
            </div>
          </div>
          <Starved r={r} onTrack={(g) => upsert({ ...g, funding: "TRACK" })} />
          {r.funding.length > 0 && <FundingMap r={r} />}
          {r.goals.length === 0 ? (
            <EmptyState title="No goals yet">Add an emergency fund, a down payment or any target above; progress comes straight from the accounts you pick.</EmptyState>
          ) : (
            r.goals.map((g, i) => (
              <GoalCard key={g.goal.id} g={g} r={r} color={goalColor(i)} first={i === 0} last={i === r.goals.length - 1} onEdit={() => setEditing(g.goal)} onMove={(by) => move(g.goal.id, by)} />
            ))
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

function GoalCard({ g, r, color, first, last, onEdit, onMove }: { g: GoalProgress; r: GoalsReport; color: string; first: boolean; last: boolean; onEdit: () => void; onMove: (by: number) => void }) {
  const track = g.goal.funding === "TRACK";
  /** Not getting there in time, or getting nothing at all: worth changing something. */
  const short = g.currentCents === 0 || g.status === "BEHIND" || g.status === "NO_PACE";
  const s = STATUS[g.status];
  const share = g.targetCents ? Math.min(1, g.currentCents / g.targetCents) : 0;
  const blocked = g.blockers.length > 0;
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} aria-hidden />
          {g.goal.name}
          <Badge tone={s.tone}>{s.label}</Badge>
          {track && (
            <Badge tone="neutral" title="Counts the whole balances of its accounts and claims nothing, so set-aside goals can use the same money.">
              milestone
            </Badge>
          )}
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
      <details className="mt-3 text-xs" open={g.accounts.length <= 4}>
        <summary className="cursor-pointer text-muted">
          {track ? "Counts" : "Claims from"} {g.accounts.length} account{g.accounts.length === 1 ? "" : "s"}: {usd0(g.currentCents)} of {usd0(g.fundingCents)}
          {g.sharedWith.length > 0 && ` · shares accounts with ${g.sharedWith.join(", ")}`}
        </summary>
        {!track && g.claimedFirstBy.length > 0 && g.status !== "REACHED" && (
          <p className={`mt-1 ${short ? "text-warn" : "text-muted"}`}>
            {g.claimedFirstBy.join(" and ")} {g.claimedFirstBy.length === 1 ? "is" : "are"} listed higher and claimed {usd0(g.accounts.reduce((s, a) => s + a.claimedBeforeCents, 0))} of
            these accounts first.
            {short &&
              ` To give this goal more, move it up, give ${g.claimedFirstBy.length === 1 ? "that goal" : "those goals"} a share of the account instead of all of it, or make ${g.claimedFirstBy.length === 1 ? "it" : "them"} a milestone.`}
          </p>
        )}
        <table className="mt-1 w-full">
          <thead className="text-[11px] text-muted">
            <tr>
              <th className="py-0.5 text-left font-medium">Account</th>
              <th className="py-0.5 text-right font-medium">Balance</th>
              {!track && <th className="py-0.5 text-right font-medium">Claimed by goals above</th>}
              {!track && <th className="py-0.5 text-right font-medium">Share</th>}
              <th className="py-0.5 text-right font-medium">Counts here</th>
            </tr>
          </thead>
          <tbody>
            {g.accounts.map((a) => (
              <tr key={a.id} className="border-t border-line">
                <td className="py-0.5">{a.name}</td>
                <td className="num py-0.5 text-right text-muted">{usd0(a.cents)}</td>
                {!track && <td className="num py-0.5 text-right text-muted">{a.claimedBeforeCents ? usd0(a.claimedBeforeCents) : "—"}</td>}
                {!track && <td className="num py-0.5 text-right text-muted">{a.share == null ? "all" : formatPercentRatio(a.share, 0)}</td>}
                <td className="num py-0.5 text-right text-fg">{usd0(a.earmarkedCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
  const funders = accounts.filter((a) => g.groups.includes(a.group) || g.accountIds.includes(a.id));
  const setShare = (id: string, pct: number | null) => {
    const shares = { ...g.shares };
    if (pct == null || pct >= 100) delete shares[id];
    else shares[id] = Math.max(0, pct) / 100;
    setG({ ...g, shares });
  };
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
        <Field
          label="How it uses its accounts"
          hint={
            g.funding === "TRACK"
              ? "Counts the whole balances and claims nothing: right for a net-worth or savings milestone that overlaps other goals."
              : "Claims money so no other set-aside goal counts the same dollars: right for an emergency fund or a down payment."
          }
        >
          <select className={selectCls} value={g.funding} onChange={(e) => setG({ ...g, funding: e.target.value as Goal["funding"] })}>
            <option value="SET_ASIDE">Set money aside</option>
            <option value="TRACK">Milestone (count balances)</option>
          </select>
        </Field>
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
        {g.funding === "SET_ASIDE" && funders.length > 0 && (
          <Field label="Share of each account" hint="How much of an account's balance this goal may claim. Under 100% leaves the rest for the goals below it.">
            <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
              {funders.map((a) => (
                <label key={a.id} className="flex items-center justify-between gap-3 text-xs text-fg">
                  <span>{a.name}</span>
                  <span className="flex items-center gap-1">
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
              ))}
            </div>
          </Field>
        )}
        {g.funding === "SET_ASIDE" && g.groups.some((x) => x === "Retirement" || x === "Health savings") && (
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

/**
 * A set-aside goal that claims every dollar of accounts a later goal needs, leaving that
 * goal nothing: usually a milestone ("$1M net worth") entered as a bucket. Offers to make it one.
 */
function Starved({ r, onTrack }: { r: GoalsReport; onTrack: (g: Goal) => void }) {
  const starved = r.goals.filter((g) => g.goal.funding === "SET_ASIDE" && g.currentCents === 0 && g.claimedFirstBy.length > 0 && g.status !== "REACHED");
  if (!starved.length) return null;
  const culprits = r.goals.filter((g) => g.goal.funding === "SET_ASIDE" && starved.some((x) => x.claimedFirstBy.includes(g.goal.name)));
  return (
    <Callout
      tone="warn"
      title={`${starved.map((g) => g.goal.name).join(", ")} ${starved.length === 1 ? "gets" : "get"} nothing: ${culprits.map((g) => g.goal.name).join(" and ")} claimed ${starved.length === 1 ? "its" : "their"} accounts first`}
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
      A set-aside goal claims every dollar it can from its accounts before the goals below it see any. If {culprits.length === 1 ? "it's" : "they're"} really a milestone (net worth, a savings
      total) rather than money to spend, a milestone counts the same balances without claiming them. Otherwise move the goals around, or give the higher goal a share of each account.
    </Callout>
  );
}

/** Where the money comes from: each account the goals draw on, split into what each set-aside goal claimed and what's left. */
function FundingMap({ r }: { r: GoalsReport }) {
  const color = new Map(r.goals.map((g, i) => [g.goal.id, goalColor(i)]));
  const total = (row: FundingRow) => Math.max(1, row.cents);
  return (
    <Card title="Where the money comes from" subtitle="Each account your goals draw on, and which goal claimed which part of it. Milestones count the whole bar without claiming any of it.">
      <div className="flex flex-col gap-2">
        {r.funding.map((row) => (
          <div key={row.id} className="text-xs">
            <div className="mb-0.5 flex items-baseline justify-between gap-3">
              <span className="text-fg">
                {row.name} <span className="text-muted">· {row.group}</span>
              </span>
              <span className="num text-muted">{usd0(row.cents)}</span>
            </div>
            <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-3" role="img" aria-label={`${row.name}: ${row.claims.map((c) => `${c.name} ${usd0(c.cents)}`).join(", ") || "nothing claimed"}`}>
              {row.claims.map((c) => (
                <div key={c.goalId} className="h-full" style={{ width: `${(c.cents / total(row)) * 100}%`, background: color.get(c.goalId) }} title={`${c.name}: ${usd0(c.cents)}`} />
              ))}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted">
              {row.claims.map((c) => (
                <span key={c.goalId}>
                  <span className="mr-1 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: color.get(c.goalId) }} aria-hidden />
                  {c.name} {usd0(c.cents)}
                </span>
              ))}
              {row.freeCents > 0 ? <span>unclaimed {usd0(row.freeCents)}</span> : row.claims.length > 0 && <span>fully claimed</span>}
              {row.trackedBy.length > 0 && <span>· counted by {row.trackedBy.join(", ")}</span>}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
