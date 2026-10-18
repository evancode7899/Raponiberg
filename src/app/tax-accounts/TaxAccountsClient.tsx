"use client";

import { BlockedNote } from "@/components/ledger/Blocked";
import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { Badge, btn, Callout, Card, ErrorNote, Field, Loading, PageBody, PercentInput, Segmented, selectCls, StatCell, StatGrid, table, Tabs, useTabParam } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import type { ProofTarget } from "@/components/ui/proof/context";
import type { AccountLimitsDescriptor } from "@/lib/book/proof/accountLimitsProof";
import type { Amount, PersonAccounts, TaxAccountsReport } from "@/lib/book/reports/taxAccounts";
import { formatPercentRatio, usd0 } from "@/lib/formatMoney";
import { EMPTY_PERSON, type HsaCoverage, type RetirementSettings } from "@/lib/taxAccounts/settings";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";

const TABS = ["people", "inputs"] as const;

/** The proof behind one of the page's figures (lib/book/proof/accountLimitsProof.ts). */
const lim = (r: TaxAccountsReport, d: Omit<AccountLimitsDescriptor, "report" | "year">, cents: number): ProofTarget => ({ descriptor: { report: "account-limits", year: r.year, ...d }, shownCents: cents });
/** A dollar figure that opens its proof. */
const Fig = ({ proof, cents }: { proof: ProofTarget; cents: number }) => <ProofValue proof={proof}>{usd0(cents)}</ProofValue>;
type Data = { report: TaxAccountsReport; settings: RetirementSettings; years: number[]; persons: { id: string; name: string }[] };

export function TaxAccountsClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [tab, setTab] = useTabParam(TABS, "people");
  const [year, setYear] = useState<number | null>(() => cachedResponse<Data>("/api/tax-accounts")?.report.year ?? null);
  const [data, setData] = useState(() => cachedResponse<Data>("/api/tax-accounts"));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (y: number | null) => {
      api
        .call<Data>(`/api/tax-accounts${y ? `?year=${y}` : ""}`)
        .then((d) => {
          setData(d);
          setYear(d.report.year);
        })
        .catch((e: Error) => setError(e.message));
    },
    [api],
  );
  useEffect(() => {
    if (api.ready) load(null);
  }, [api, load]);

  const save = async (s: RetirementSettings) => {
    try {
      await api.call("/api/tax-accounts", { method: "PUT", json: s });
      load(year);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const r = data?.report;
  return (
    <>
      <Tabs
        tabs={[
          { id: "people", label: "Accounts" },
          { id: "inputs", label: "Inputs" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <PageBody>
        <ApiSecretField api={api} />
        {error && <ErrorNote>{error}</ErrorNote>}
        {!data || !r ? (
          api.ready && !error && <Loading label="Adding up every contribution…" />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Segmented
                ariaLabel="Tax year"
                options={data.years.map((y) => ({ value: String(y), label: String(y) }))}
                value={String(r.year)}
                onChange={(v) => {
                  setData(null);
                  load(Number(v));
                }}
              />
              <p className="text-xs text-muted">Estimates from pay stubs and statements, not tax advice. Limits: {r.paramsNotes[0]}</p>
            </div>
            {r.warnings.map((w) => (
              <Callout key={w} tone="bad" title="Check this">
                {w}
              </Callout>
            ))}
            {r.notices.map((n) => (
              <Callout key={n} tone="good" title="Settled">
                {n}
              </Callout>
            ))}
            {r.people.map((p) => (
              <BlockedNote key={p.id} what={`${p.name}'s contributions`} blockers={p.blockers} />
            ))}
            {tab === "people" && <Accounts r={r} />}
            {tab === "inputs" && <Inputs data={data} save={save} />}
          </>
        )}
      </PageBody>
    </>
  );
}

// ---------------------------------------------------------------------------- accounts

function Accounts({ r }: { r: TaxAccountsReport }) {
  const open = r.steps.filter((s) => !s.done);
  const { roomCents: pretaxRoom, taxSavedCents: saved } = r.pretax;
  const chet = r.steps.find((s) => s.id === "chet");
  return (
    <>
      <StatGrid cols={4}>
        <StatCell label="Pre-tax room left" value={usd0(pretaxRoom)} proof={lim(r, { account: "steps", figure: "room" }, pretaxRoom)} sub={r.isCurrentYear ? "401(k) and HSA, through December 31" : `${r.year}: the year is over`} />
        <StatCell
          label="Tax it would save"
          value={saved == null ? "Unknown" : usd0(saved)}
          proof={saved == null ? { descriptor: { report: "account-limits", year: r.year, account: "steps", figure: "tax-saved" } } : lim(r, { account: "steps", figure: "tax-saved" }, saved)}
          sub={r.marginalRate.rate == null ? "set a marginal rate on Inputs" : `at ${formatPercentRatio(r.marginalRate.rate, 1)} federal + state${r.marginalRate.source === "PRIOR_YEAR" ? ` (${r.year - 1}'s rate)` : ""}`}
        />
        <StatCell
          label="Household MAGI"
          value={usd0(r.magi.cents)}
          proof={r.magi.source === "TAX_REPORT" ? { descriptor: { report: "tax-estimate", year: r.year, basis: "projected", key: "fed.agi" }, shownCents: r.magi.cents } : undefined} sub={r.magi.source === "TAX_REPORT" ? "from the tax estimate" : "wages from pay stubs only (the tax estimate isn't provable yet)"} />
        <StatCell label="Still open" value={String(open.length)} sub={`of ${r.steps.length} yearly limits`} />
      </StatGrid>
      {r.people.map((p) => (
        <PersonCard key={p.id} p={p} r={r} />
      ))}
      {chet && (
        <Card title="Household" subtitle={chet.benefit}>
          <Meter
            label={chet.title}
            used={r.household.chet.contributed}
            limit={r.household.chet.deductionLimit}
            proofs={{ used: lim(r, { account: "chet", figure: "used" }, r.household.chet.contributed), limit: lim(r, { account: "chet", figure: "limit" }, r.household.chet.deductionLimit) }}
            sub={chet.done ? "Deduction filled." : <><Fig proof={lim(r, { account: "chet", figure: "room" }, chet.roomCents)} cents={chet.roomCents} /> of room.</>}
          />
        </Card>
      )}
    </>
  );
}

/** " Filling it saves ≈$X of tax." for an open pre-tax limit, when a marginal rate is known. */
const savesNote = (r: TaxAccountsReport, id: string) => {
  const s = r.steps.find((x) => x.id === id);
  return s && !s.done && s.taxSavedCents ? ` Filling it saves ≈${usd0(s.taxSavedCents)} of tax.` : "";
};

// ---------------------------------------------------------------------------- per person

function Meter({ label, used, limit, projected, sub, overSettled, proofs }: { label: string; used: number; limit: number; projected?: number; sub?: ReactNode; overSettled?: boolean; proofs?: { used?: ProofTarget; limit?: ProofTarget; projected?: ProofTarget } }) {
  const pct = (c: number) => `${Math.min(100, limit ? (c / limit) * 100 : 0)}%`;
  // Over the limit is an alarm unless the excess has been dealt with (returned and taxed).
  const over = used > limit && !overSettled;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium text-fg">{label}</span>
        <span className="num text-muted">
          <span className={over ? "font-semibold text-neg" : "text-fg"}>
            <ProofValue proof={proofs?.used}>{usd0(used)}</ProofValue>
          </span>{" "}
          of <ProofValue proof={proofs?.limit}>{usd0(limit)}</ProofValue>
          {projected != null && projected !== used && (
            <>
              {" "}
              · <ProofValue proof={proofs?.projected}>{usd0(projected)}</ProofValue> by Dec 31
            </>
          )}
        </span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-surface-3" role="meter" aria-valuenow={used} aria-valuemax={limit} aria-label={label}>
        {projected != null && <div className="absolute inset-y-0 left-0 rounded-full bg-accent/30" style={{ width: pct(projected) }} />}
        <div className={`absolute inset-y-0 left-0 rounded-full ${over ? "bg-neg" : "bg-accent"}`} style={{ width: pct(used) }} />
      </div>
      {sub && <p className="mt-1 text-[11px] text-muted">{sub}</p>}
    </div>
  );
}

/** Year to date, and projected to Dec 31 when that differs, each opening its proof. */
const amt = (a: Amount, proof?: (figure: "used" | "projected", cents: number) => ProofTarget) =>
  a.ytd === a.projected ? (
    <ProofValue proof={proof?.("used", a.ytd)}>{usd0(a.ytd)}</ProofValue>
  ) : (
    <>
      <ProofValue proof={proof?.("used", a.ytd)}>{usd0(a.ytd)}</ProofValue> → <ProofValue proof={proof?.("projected", a.projected)}>{usd0(a.projected)}</ProofValue>
    </>
  );

function PersonCard({ p, r }: { p: PersonAccounts; r: TaxAccountsReport }) {
  const k = (d: Omit<AccountLimitsDescriptor, "report" | "year" | "account" | "personId">, cents: number) => lim(r, { account: "k401", personId: p.id, ...d }, cents);
  const h = (d: Omit<AccountLimitsDescriptor, "report" | "year" | "account" | "personId">, cents: number) => lim(r, { account: "hsa", personId: p.id, ...d }, cents);
  const i = (d: Omit<AccountLimitsDescriptor, "report" | "year" | "account" | "personId">, cents: number) => lim(r, { account: "ira", personId: p.id, ...d }, cents);
  const room = <Fig proof={k({ figure: "room" }, p.k401.room)} cents={p.k401.room} />;
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {p.name}
          {p.age != null && <Badge tone="neutral">age {p.age} in {r.year}</Badge>}
        </span>
      }
      subtitle={p.through ? `Pay stubs through ${p.through}${p.remainingPaychecks ? ` · ${p.remainingPaychecks} paychecks left this year` : ""}` : "No pay stubs this year"}
    >
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <Meter
            label={`401(k) deferrals${p.k401.catchUp ? " (incl. catch-up)" : ""}`}
            used={p.k401.total.ytd}
            projected={p.k401.total.projected}
            limit={p.k401.limit}
            overSettled={p.k401.excessDeferral?.status === "RETURNED"}
            proofs={{ used: k({ figure: "used" }, p.k401.total.ytd), projected: k({ figure: "projected" }, p.k401.total.projected), limit: k({ figure: "limit" }, p.k401.limit) }}
            sub={
              p.k401.excess ? (
                <>
                  <Fig proof={k({ figure: "excess" }, p.k401.excess)} cents={p.k401.excess} /> over the limit —{" "}
                  {p.k401.excessDeferral?.status === "RETURNED" ? `returned in time and taxed as ${r.year} income (see above).` : "see the warning above."}
                </>
              ) : (
                <>
                  {p.k401.room && p.k401.perPaycheckToMax ? (
                    <>
                      {room} short of the limit: about {usd0(p.k401.perPaycheckToMax)} more per paycheck fills it.
                    </>
                  ) : p.k401.room ? (
                    <>{room} of room.</>
                  ) : (
                    "On track to max."
                  )}
                  {savesNote(r, `k401-${p.id}`)}
                  {p.k401.rothCatchUpRequired ? " Catch-up contributions must go in as Roth (prior-year wages over the threshold)." : ""}
                </>
              )
            }
          />
          <Meter label={`HSA (${p.hsa.coverage === "NONE" ? "not eligible" : `${p.hsa.coverage.toLowerCase()} coverage${p.hsa.assumed ? ", assumed" : ""}`})`} used={p.hsa.total.ytd} projected={p.hsa.total.projected} limit={p.hsa.limit}
            proofs={{ used: h({ figure: "used" }, p.hsa.total.ytd), projected: h({ figure: "projected" }, p.hsa.total.projected), limit: h({ figure: "limit" }, p.hsa.limit) }}
            sub={
              <>
                You {amt(p.hsa.employee, (figure, c) => h({ figure, part: "employee" }, c))} · employer {amt(p.hsa.employer, (figure, c) => h({ figure, part: "employer" }, c))}
                {p.hsa.outsidePayroll ? ` · outside payroll ${usd0(p.hsa.outsidePayroll)}` : ""}. {p.hsa.coverage !== "NONE" && <><Fig proof={h({ figure: "room" }, p.hsa.room)} cents={p.hsa.room} /> of room.</>}
                {savesNote(r, `hsa-${p.id}`)}
              </>
            }
          />
          <Meter
            label="IRA contributions (traditional + Roth)"
            used={p.ira.total}
            limit={p.ira.limit}
            proofs={{ used: i({ figure: "used" }, p.ira.total), limit: i({ figure: "limit" }, p.ira.limit) }}
            sub={
              <>
                {p.ira.contributions.map((c) => `${c.account}: ${usd0(c.cents)}`).join(" · ") || "None this year."} <Fig proof={i({ figure: "room" }, p.ira.room)} cents={p.ira.room} /> of room.
              </>
            }
          />
        </div>
        <div className="flex flex-col gap-3 text-xs">
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.head}>
                <tr>
                  <th className={table.th}>Employer plan</th>
                  <th className={table.thR}>You</th>
                  <th className={table.thR}>Employer</th>
                </tr>
              </thead>
              <tbody>
                {p.k401.employers.map((e) => (
                  <tr key={e.employer} className={table.tr}>
                    <td className={table.td}>
                      {e.employer} {!e.active && <Badge tone="neutral">former</Badge>}
                    </td>
                    <td className={table.tdR}>{amt(e.employee, (figure, c) => k({ figure, employer: e.employer, part: "employee" }, c))}</td>
                    <td className={table.tdR}>{amt(e.employer$, (figure, c) => k({ figure, employer: e.employer, part: "employer" }, c))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {p.k401.match && (
            <p className="text-[11px] text-muted">
              Match: {usd0(p.k401.match.fullMatchDeferral)} of deferrals earns all of it{p.k401.match.shortfall ? ` — ${usd0(p.k401.match.shortfall)} short` : " — captured"}.{savesNote(r, `match-${p.id}`)}
            </p>
          )}
          <div className="rounded-md border border-line p-3">
            <div className="mb-1 font-medium text-fg">Roth IRA eligibility</div>
            <p className="text-muted">
              {p.ira.rothDirectShare === 1
                ? "Direct Roth contributions allowed in full."
                : p.ira.rothDirectShare === 0
                  ? `Household MAGI is above the direct Roth limit — use the backdoor (non-deductible traditional, then convert).`
                  : `Direct Roth limited to ${formatPercentRatio(p.ira.rothDirectShare, 0)} of the limit at this MAGI.`}{" "}
              Traditional IRA deduction: {p.ira.deductibleShare === 1 ? "full" : p.ira.deductibleShare === 0 ? "none (covered by a workplace plan)" : formatPercentRatio(p.ira.deductibleShare, 0)}.
            </p>
          </div>
          <div className="rounded-md border border-line p-3">
            <div className="mb-1 flex items-center gap-2 font-medium text-fg">
              Backdoor Roth check
              {p.backdoor.pretaxIraCents > 0 ? <Badge tone="warn">pro-rata risk</Badge> : <Badge tone="pos">clean</Badge>}
            </div>
            <p className="text-muted">
              Converted {usd0(p.backdoor.conversions)} on {usd0(p.backdoor.basis)} of after-tax basis; ≈{usd0(p.backdoor.taxableConversion)} taxable.{" "}
              {p.backdoor.pretaxIraCents > 0
                ? `Pre-tax IRA money (${p.backdoor.pretaxAccounts.map((a) => `${a.name} ${usd0(a.cents)}`).join(", ")}) on ${r.isCurrentYear ? "the latest statement" : "December 31"} makes part of any conversion taxable — rolling it into the 401(k) before year end avoids that.`
                : `No pre-tax IRA money ${r.isCurrentYear ? "on the latest statements" : "on December 31"}, so conversions are taxed only on growth before converting.`}
            </p>
          </div>
          {p.notes.length > 0 && (
            <details className="text-muted">
              <summary className="cursor-pointer">{p.notes.length} pay notes (don&apos;t change these totals)</summary>
              <ul className="mt-1 list-disc pl-4">
                {p.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------- inputs

function Inputs({ data, save }: { data: Data; save: (s: RetirementSettings) => void }) {
  const [draft, setDraft] = useState(data.settings);
  // Newly saved settings reset the draft (adjusted during render, not in an effect).
  const [seen, setSeen] = useState(data.settings);
  if (data.settings !== seen) {
    setSeen(data.settings);
    setDraft(data.settings);
  }
  const person = (id: string) => draft.people[id] ?? EMPTY_PERSON;
  const set = (id: string, patch: Partial<typeof EMPTY_PERSON>) => setDraft({ ...draft, people: { ...draft.people, [id]: { ...person(id), ...patch } } });
  return (
    <Card
      title="What the statements can't tell"
      subtitle={
        <>
          Ages (for catch-up limits) come from birth years on{" "}
          <Link href="/settings?tab=household" className={btn.link}>
            Settings › Household
          </Link>
          ; HSA money paid outside payroll and IRA basis from earlier years from the Taxes inputs.
        </>
      }
      actions={
        <button type="button" className={btn.primary} onClick={() => save(draft)}>
          Save
        </button>
      }
    >
      <div className="flex flex-col gap-5">
        {data.persons.map((p) => {
          const v = person(p.id);
          return (
            <div key={p.id} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={`${p.name}: HSA coverage`} hint="Family coverage has the higher limit, shared between spouses.">
                <select className={selectCls} value={v.hsaCoverage ?? ""} onChange={(e) => set(p.id, { hsaCoverage: (e.target.value || null) as HsaCoverage | null })}>
                  <option value="">Assume from pay stubs</option>
                  <option value="FAMILY">Family</option>
                  <option value="SELF">Self-only</option>
                  <option value="NONE">No HSA-eligible plan</option>
                </select>
              </Field>
              <Field label="Employer match rate" hint="Cents per dollar deferred (100% = dollar for dollar).">
                <PercentInput value={v.matchRate ?? 0} onChange={(x) => set(p.id, { matchRate: x || null })} />
              </Field>
              <Field label="…on deferrals up to" hint="Share of pay the match applies to (e.g. 4%).">
                <PercentInput value={v.matchUpTo ?? 0} onChange={(x) => set(p.id, { matchUpTo: x || null })} />
              </Field>
            </div>
          );
        })}
        <Field label="Marginal rate for estimates" hint="Federal + state on the next pre-tax dollar. Blank: from the tax estimate.">
          <PercentInput className="w-28" value={draft.marginalRate ?? 0} onChange={(x) => setDraft({ ...draft, marginalRate: x || null })} />
        </Field>
      </div>
    </Card>
  );
}
