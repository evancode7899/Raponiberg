"use client";

import { Badge, Card, Segmented } from "@/components/ui/kit";
import type { PlanAccount, PlanEmployer, PlanLane, PlanStatement, PlanStub, StatementPlan as Plan } from "@/lib/book/reports/statementPlan";
import { formatDisplayDateFromYmd } from "@/lib/displayTime";
import { useMemo, useState } from "react";

const LANES: { id: PlanLane; label: string }[] = [
  { id: "netWorth", label: "Net worth" },
  { id: "cashFlow", label: "Cash flow" },
  { id: "tax", label: "Taxes" },
];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const date = (iso: string) => formatDisplayDateFromYmd(iso);
const month = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
/** "Aug 22 – Sep 21, 2026". */
const span = (from: string, to: string) =>
  `${MONTHS[Number(from.slice(5, 7)) - 1]} ${Number(from.slice(8))}${from.slice(0, 4) === to.slice(0, 4) ? "" : `, ${from.slice(0, 4)}`} – ${
    MONTHS[Number(to.slice(5, 7)) - 1]
  } ${Number(to.slice(8))}, ${to.slice(0, 4)}`;

const isMonthEnd = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCMonth() !== new Date(Date.parse(`${iso}T12:00:00Z`) + 864e5).getUTCMonth();
const neededBy =(s: PlanStatement, end: string) => LANES.some((l) => (s.neededFrom[l.id] ?? "9999") <= end);
const lanesFor = (s: PlanStatement, lane: PlanLane, end: string) => (s.neededFrom[lane] ?? "9999") <= end;

/** "Net worth & cash flow from Jul 2026 · taxes from Aug 2026". */
function neededText(s: PlanStatement): string {
  const byMonth = new Map<string, string[]>();
  for (const l of LANES) {
    const from = s.neededFrom[l.id];
    if (from) byMonth.set(month(from), [...(byMonth.get(month(from)) ?? []), l.label]);
  }
  return [...byMonth]
    .map(([m, ls], i) => {
      const names = ls.map((x, j) => (i === 0 && j === 0 ? x : x.toLowerCase()));
      return `${names.length > 1 ? `${names.slice(0, -1).join(", ")} & ${names.at(-1)}` : names[0]} from ${m}`;
    })
    .join(" · ");
}

function StatusBadge({ s, today }: { s: PlanStatement; today: string }) {
  if (s.kind !== "next") return <Badge tone="neg">missing</Badge>;
  if (s.status === "ready") return <Badge tone="pos">ready to download</Badge>;
  if (s.status === "posting")
    return (
      <Badge tone="warn" title={`Closed ${date(s.end)}. Monthly statements usually post about a week after closing; quarterly ones five to nine weeks after.`}>
        closed · expected ~{date(s.readyBy)}
      </Badge>
    );
  const days = Math.round((Date.parse(s.end) - Date.parse(today)) / 864e5);
  return <Badge title={`The period is still open; the statement closes ${date(s.end)}.`}>closes {date(s.end)}{days <= 31 ? ` · ${days}d` : ""}</Badge>;
}

/**
 * The statements to download to unlock each period past the horizon, per issuer: the
 * latest statement on file (by its file name, as the issuer's site lists it) and every
 * statement after it each figure waits on, ready now or not issued yet.
 */
export function StatementPlan({ plan }: { plan: Plan }) {
  const quarterly = plan.targets.filter((t) => t.quarter || t.year).at(-1);
  const [pick, setPick] = useState<string | null>(null);
  const target = plan.targets.find((t) => t.end === pick) ?? quarterly ?? plan.targets.at(-1);

  const view = useMemo(() => {
    if (!target) return null;
    const end = target.end;
    const institutions = plan.institutions
      .map((i) => ({
        name: i.name,
        accounts: i.accounts.map((a) => ({ a, need: a.statements.filter((s) => neededBy(s, end)) })).filter((x) => x.need.length),
      }))
      .filter((i) => i.accounts.length);
    const all = institutions.flatMap((i) => i.accounts.flatMap((x) => x.need));
    const employers = plan.stubs.map((e) => ({ e, need: e.stubs.filter((s) => LANES.some((l) => (s.neededFrom[l.id] ?? "9999") <= end)) })).filter((x) => x.need.length);
    const lanes = LANES.map((l) => {
      const need = all.filter((s) => lanesFor(s, l.id, end));
      const stubs = employers.flatMap((x) => x.need.filter((s) => (s.neededFrom[l.id] ?? "9999") <= end));
      const other = plan.other.filter((o) => (o.neededFrom[l.id] ?? "9999") <= end);
      // A stub is out on its pay date.
      const latest = [...need.map((s) => (s.status === "ready" ? plan.today : s.readyBy)), ...stubs.map((s) => (s.status === "ready" ? plan.today : s.date))].sort().at(-1);
      return { ...l, unlocked: target.unlocked[l.id] && !stubs.length && !other.length, need, stubs, other, latest };
    });
    const ready = [
      ...institutions.flatMap((i) => i.accounts.flatMap((x) => x.need.filter((s) => s.status === "ready").map((s) => `${i.name} ${shortName(x.a)} — ${s.label}`))),
      ...employers.flatMap((x) => x.need.filter((s) => s.status === "ready").map((s) => `${x.e.employer} stub — ${date(s.date)}`)),
    ];
    // Accounts that need nothing for this period (whatever they need comes later).
    const clear = plan.institutions.flatMap((i) => i.accounts.filter((a) => !a.statements.some((s) => neededBy(s, end))).map((a) => ({ inst: i.name, a })));
    return { institutions, employers, stubCount: employers.flatMap((x) => x.need).length, lanes, ready, clear };
  }, [plan, target]);

  if (!target || !view) {
    return (
      <Card title="Statements to download">
        <p className="text-sm text-muted">Everything is on file through {date(plan.horizon.netWorth)}. Nothing to download yet.</p>
      </Card>
    );
  }
  const name = `${target.label}${target.quarter ? ` · ${target.quarter}` : ""}${target.year ? ` · ${target.year}` : ""}`;

  return (
    <Card
      title={`Statements to unlock ${target.quarter ?? target.year ?? target.label}`}
      subtitle={
        <>
          The pages are proven through <span className="font-semibold text-fg">{date(plan.horizon.netWorth)}</span> (net worth)
          {plan.horizon.cashFlow !== plan.horizon.netWorth && (
            <>
              {" "}
              and <span className="font-semibold text-fg">{date(plan.horizon.cashFlow)}</span> (cash flow)
            </>
          )}
          . For each issuer: the latest statement on file, by its file name, and every statement after it that {name} waits on. Next dates are predicted
          from each account&apos;s cycle.
        </>
      }
      actions={
        plan.targets.length > 1 && (
          <Segmented
            ariaLabel="Period to unlock"
            size="xs"
            value={target.end}
            onChange={setPick}
            options={plan.targets.map((t) => ({ value: t.end, label: t.quarter ? `${t.label.slice(0, 3)} · ${t.quarter.split(" ")[0]}` : t.year ? `${t.label.slice(0, 3)} · ${t.year}` : t.label }))}
          />
        )
      }
    >
      <div className="grid gap-2 text-xs sm:grid-cols-3">
        {view.lanes.map((l) => (
          <div key={l.id} className="rounded-md bg-surface-2 px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-fg">{l.label}</span>
              {l.unlocked ? <Badge tone="pos">unlocked</Badge> : <Badge tone="warn">locked</Badge>}
            </div>
            {l.unlocked ? (
              <div className="mt-0.5 text-muted">Proven through {target.label}.</div>
            ) : (
              <div className="mt-0.5 text-muted">
                <span className="num font-semibold text-fg">{l.need.length}</span> statement{l.need.length === 1 ? "" : "s"}
                {l.stubs.length > 0 && (
                  <>
                    {" "}
                    · <span className="num font-semibold text-fg">{l.stubs.length}</span> pay stub{l.stubs.length === 1 ? "" : "s"}
                  </>
                )}
                {l.need.length + l.stubs.length > 0 && (
                  <>
                    {" "}
                    · <span className="text-pos">{[...l.need, ...l.stubs].filter((s) => s.status === "ready").length} ready now</span>
                  </>
                )}
                {l.other.length > 0 && <span className="text-neg"> · {l.other.length} to fix</span>}
                {l.latest && (
                  <div className="text-faint">{l.latest <= plan.today ? "Unlocks as soon as they're imported" : `Earliest unlock ~${date(l.latest)}, when the last one posts`}</div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {view.ready.length > 0 && (
        <div className="mt-3 rounded-md border border-pos/30 bg-pos-soft px-3 py-2 text-xs">
          <span className="font-semibold text-pos">Download now ({view.ready.length}):</span>{" "}
          <span className="text-fg-2">{view.ready.join(" · ")}</span>
        </div>
      )}

      <ul className="mt-3 flex flex-col divide-y divide-line">
        {view.institutions.map((i) => (
          <li key={i.name} className="py-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[13px] font-semibold text-fg">{i.name}</h3>
              <span className="text-[11px] text-muted">
                {i.accounts.reduce((n, x) => n + x.need.length, 0)} statement{i.accounts.reduce((n, x) => n + x.need.length, 0) === 1 ? "" : "s"}
              </span>
            </div>
            <ul className="mt-1.5 flex flex-col gap-2">
              {i.accounts.map(({ a, need }) => (
                <AccountRow key={a.accountId} a={a} need={need} today={plan.today} />
              ))}
            </ul>
          </li>
        ))}
      </ul>

      {view.employers.length > 0 && (
        <div className="border-t border-line py-2.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-[13px] font-semibold text-fg">Pay stubs</h3>
            <span className="text-[11px] text-muted">
              {view.stubCount} stub{view.stubCount === 1 ? "" : "s"} · taxes wait on them
            </span>
          </div>
          <ul className="mt-1.5 flex flex-col gap-2">
            {view.employers.map(({ e, need }) => (
              <EmployerRow key={e.key} e={e} need={need} />
            ))}
          </ul>
        </div>
      )}

      {view.lanes.some((l) => l.other.length) && (
        <div className="mt-2 rounded-md border border-neg/30 bg-neg-soft px-3 py-2 text-xs">
          <div className="font-semibold text-neg">Also holding it back (not a statement)</div>
          <ul className="mt-1 flex flex-col gap-1 text-fg-2">
            {plan.other
              .filter((o) => LANES.some((l) => (o.neededFrom[l.id] ?? "9999") <= target.end))
              .map((o) => (
                <li key={o.id}>
                  <span className="font-medium text-fg">{o.title}</span> — {o.fix}
                </li>
              ))}
          </ul>
        </div>
      )}

      {(view.clear.length > 0 || plan.upToDate.length > 0) && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted">Nothing needed for {target.label} ({view.clear.length + plan.upToDate.length} accounts)</summary>
          <ul className="mt-1.5 flex flex-col gap-0.5 text-fg-2">
            {plan.upToDate.map((u) => (
              <li key={u.name}>
                <span className="text-muted">{u.institution}</span> {u.name} <span className="text-faint">— on file through {date(u.coveredThrough)}{u.lastTitle ? ` (${u.lastTitle})` : ""}</span>
              </li>
            ))}
            {view.clear.map(({ inst, a }) => (
              <li key={a.accountId}>
                <span className="text-muted">{inst}</span> {a.name} <span className="text-faint">— on file through {date(a.coveredThrough)}; next one needed only for a later month</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

/** A person's employer and the stubs the period waits on: paychecks the bank shows, then ones the pay cycle says are due. */
function EmployerRow({ e, need }: { e: PlanEmployer; need: PlanStub[] }) {
  return (
    <li className="rounded-md bg-surface-2 px-2.5 py-2 text-xs">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="font-medium text-fg">
          {e.person} · {e.employer}
        </span>
        {e.cadence && <span className="text-faint">{e.cadence}</span>}
      </div>
      <div className="mt-0.5 text-muted">
        Last on file: <span className="font-medium text-fg-2">{e.last.title}</span> · paid {date(e.last.payDate)}
      </div>
      <ul className="mt-1.5 flex flex-col gap-1">
        {need.map((s) => (
          <li key={s.date} className="flex flex-wrap items-start gap-x-2 gap-y-0.5 rounded bg-surface px-2 py-1.5">
            <span className="w-4 shrink-0 text-center text-faint" aria-hidden>
              {s.status === "ready" ? "☐" : "○"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="font-semibold text-fg">{s.kind === "deposited" ? `Stub paid ${date(s.date)}` : `Stub due ~${date(s.date)}`}</span>
              <div className="text-faint">
                {s.kind === "deposited" ? "The bank shows this paycheck; its stub isn't on file." : "Predicted from the pay cycle; no bank statement on file shows it yet."} Needed for taxes from {month(s.date)}.
              </div>
            </span>
            {s.status === "ready" ? <Badge tone="pos">ready to download</Badge> : <Badge title="The pay date hasn't come yet.">pays ~{date(s.date)}</Badge>}
          </li>
        ))}
      </ul>
    </li>
  );
}

/** "Gold Card ••1234" for "Amex Gold Card ••1234": the issuer is already in the heading. */
function shortName(a: PlanAccount) {
  return a.name.replace(/^(Amex|American Express|Chase|Capital One|Fidelity|Vanguard|Bilt)\s+/i, "");
}

function AccountRow({ a, need, today }: { a: PlanAccount; need: PlanStatement[]; today: string }) {
  return (
    <li className="rounded-md bg-surface-2 px-2.5 py-2 text-xs">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="font-medium text-fg">{a.name}</span>
        <span className="text-faint">{a.cadence}</span>
      </div>
      <div className="mt-0.5 text-muted">
        {a.last ? (
          <>
            Last on file: <span className="font-medium text-fg-2">{a.last.title}</span> · {span(a.last.start, a.last.end)}
            {a.coveredThrough > a.last.end && <> · idle (no statement issued) through {date(a.coveredThrough)}</>}
          </>
        ) : (
          "No statements on file"
        )}
      </div>
      <ul className="mt-1.5 flex flex-col gap-1">
        {need.map((s) => (
          <li key={`${s.kind}-${s.start}`} className="flex flex-wrap items-start gap-x-2 gap-y-0.5 rounded bg-surface px-2 py-1.5">
            <span className="w-4 shrink-0 text-center text-faint" aria-hidden>
              {s.status === "ready" || s.kind !== "next" ? "☐" : "○"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="font-semibold text-fg">{s.kind === "next" ? `${s.label} statement` : s.kind === "history" ? `History ${s.label}` : `Missing ${s.label}`}</span>
              <span className="text-muted"> · {span(s.start, s.end)}</span>
              {s.kind === "next" && !isMonthEnd(s.end) && <span className="text-faint"> (closing date predicted)</span>}
              <div className="text-faint">Needed for {neededText(s)}</div>
              {s.ifIdle && (
                <div className="text-faint">
                  If the card had no activity, no statement comes: {s.ifIdle.banks.join(" and ")} statements through {date(s.ifIdle.through)} prove the cycle instead
                  {s.ifIdle.onFile ? " (on file)" : s.ifIdle.readyBy ? (s.ifIdle.readyBy <= today ? " (ready to download now)" : ` (expected ~${date(s.ifIdle.readyBy)})`) : ""}.
                </div>
              )}
              {s.settles.length > 0 && (
                <details className="text-faint">
                  <summary className="cursor-pointer">
                    Also settles {s.settles.length} open finding{s.settles.length === 1 ? "" : "s"}
                  </summary>
                  <ul className="mt-0.5 list-disc pl-4">
                    {s.settles.map((f) => (
                      <li key={f.id}>
                        {f.title}
                        {f.anyOf.length > 1 && <span> (any of those accounts&apos; statements settles it)</span>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </span>
            <StatusBadge s={s} today={today} />
          </li>
        ))}
      </ul>
    </li>
  );
}
