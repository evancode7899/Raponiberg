"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { insuranceDerived } from "@/lib/book/derived/insurance";
import { derivedTarget } from "@/lib/book/derived/types";
import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { chartChrome, useChartPalette } from "@/components/shell/chartPalette";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { Badge, btn, Callout, Card, EmptyState, ErrorNote, inputCls, Loading, PageBody, Segmented, selectCls, StatCell, StatGrid, table, Tabs, useTabParam } from "@/components/ui/kit";
import { formatUsdFromCents, usd0 } from "@/lib/formatMoney";
import type { InsurancePage } from "@/lib/insurance/page";
import type { Beneficiary, InsuranceNotes, PolicyNotes } from "@/lib/insurance/notes";
import { addDays } from "@/lib/dates/isoDate";
import { addYears, type PolicyView } from "@/lib/insurance/report";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";

const URL = "/api/insurance";
const TABS = ["overview", "premiums", "payments", "terms"] as const;

const longDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
const shortDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const yearsUntil = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / (365.25 * 86_400_000);
const until = (from: string, to: string) => {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  if (days < 0) return null;
  if (days < 62) return days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`;
  const y = yearsUntil(from, to);
  return y < 2 ? `in ${Math.round(y * 12)} months` : `in ${Math.round(y)} years`;
};
const pct = (r: number) => `${+(r * 100).toFixed(2)}%`;
const rowProof = (rowId: string, cents: number) => ({ descriptor: { report: "row" as const, rowId }, shownCents: -cents });

export function InsuranceClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [tab, setTab] = useTabParam(TABS, "overview");
  const [data, setData] = useState(() => cachedResponse<InsurancePage>(URL));
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (!api.ready) return;
    api
      .call<InsurancePage>(URL)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [api]);

  const saveNotes = useCallback(
    async (next: InsuranceNotes) => {
      const saved = await api.call<InsuranceNotes>(URL, { method: "PUT", json: next });
      setData((d) => (d ? { ...d, notes: saved } : d));
    },
    [api],
  );

  const policy = data?.policies.find((p) => p.policy.policyNumber === picked) ?? data?.policies[0] ?? null;
  const tabs = [
    { id: "overview" as const, label: "Overview" },
    { id: "premiums" as const, label: "Premiums & coverage" },
    { id: "payments" as const, label: "Payments", count: policy?.payments.length ?? null },
    { id: "terms" as const, label: "Terms" },
  ];

  return (
    <>
      {policy && <Tabs tabs={tabs} value={tab} onChange={setTab} />}
      <PageBody>
        <ApiSecretField api={api} />
        {error && <ErrorNote>{error}</ErrorNote>}
        {!data ? (
          api.ready && !error && <Loading label="Reading the policy documents…" />
        ) : !policy ? (
          <NoPolicies data={data} />
        ) : (
          <div className="flex flex-col gap-4">
            {data.policies.length > 1 && (
              <Segmented
                options={data.policies.map((p) => ({ value: p.policy.policyNumber, label: `${p.policy.product ?? p.policy.insurer} ••${p.policy.policyNumber.slice(-4)}` }))}
                value={policy.policy.policyNumber}
                onChange={setPicked}
              />
            )}
            {data.errors.length > 0 && (
              <Callout tone="warn" title="Some insurance documents couldn't be read">
                <ul className="list-disc space-y-1 pl-4">
                  {data.errors.map((e) => (
                    <li key={e.file}>
                      <code className="text-fg-2">{e.file}</code>: {e.error}
                    </li>
                  ))}
                </ul>
              </Callout>
            )}
            {tab === "overview" && <Overview v={policy} today={data.today} notes={data.notes} save={saveNotes} />}
            {tab === "premiums" && <Premiums v={policy} today={data.today} />}
            {tab === "payments" && <Payments v={policy} accounts={data.accounts} />}
            {tab === "terms" && <Terms v={policy} />}
          </div>
        )}
      </PageBody>
    </>
  );
}

function NoPolicies({ data }: { data: InsurancePage }) {
  return (
    <EmptyState title="No life insurance policy found">
      {data.scanned
        ? "Save the policy packet PDF (the contract with its policy schedule and table of premiums) anywhere in your statements folder, along with any premium notices, and open this page again."
        : "The statements folder wasn't found. Set STATEMENTS_DIR, then save the policy packet PDF there."}
    </EmptyState>
  );
}

// ---------------------------------------------------------------------------- overview

function Overview({ v, today, notes, save }: { v: PolicyView; today: string; notes: InsuranceNotes; save: (n: InsuranceNotes) => Promise<void> }) {
  const p = v.policy;
  const level = v.years.find((y) => y.year === (p.levelYears ?? 0) + 1);
  const ageAtLevelEnd = p.issueAge != null && p.levelYears != null ? p.issueAge + p.levelYears : null;
  const upcoming = v.dates.filter((d) => !d.past);
  const requirements = v.dates.find((d) => d.key === "requirements");
  return (
    <>
      <Card
        tone="overview"
        title={`${p.product ?? "Term life"} · ${p.insurer}`}
        subtitle={[p.brand, `Policy ${p.policyNumber}`, p.state && `a ${p.state} policy`].filter(Boolean).join(" · ")}
        actions={<StatusBadge v={v} />}
      >
        <p className="text-sm text-fg-2">
          {usd0(p.faceCents)} of {p.levelYears ? `${p.levelYears}-year level ` : ""}term life on {p.insured}
          {p.premiumClass ? ` (${p.premiumClass})` : ""}, for {usd0(p.annualPremiumCents)} a year
          {p.levelEndDate ? ` fixed through ${longDate(addDays(p.levelEndDate, -1))}` : ""}.
          {v.nextDue && ` Next premium ${usd0(v.nextDue.cents)} due ${longDate(v.nextDue.date)}, ${until(today, v.nextDue.date)}.`}
          {v.paidTo && ` The insurer shows it paid to ${longDate(v.paidTo.date)} (as of ${shortDate(v.paidTo.asOf)}).`}
        </p>
      </Card>

      <StatGrid cols={4}>
        <StatCell proof={derivedTarget("insurance", insuranceDerived([v]), "death-benefit", v.policy.policyNumber)} label="Death benefit" value={usd0(v.faceNowCents ?? p.faceCents)} sub={level && level.faceCents < p.faceCents ? `Drops to ${usd0(level.faceCents)} after year ${p.levelYears}` : "Level for the term"} />
        <StatCell proof={derivedTarget("insurance", insuranceDerived([v]), "premium", v.policy.policyNumber)} label="Annual premium" value={usd0(p.annualPremiumCents)} sub={`${formatUsdFromCents(Math.round(v.per1000Cents))} per $1,000 of cover${p.policyFeeCents ? ` · incl. ${usd0(p.policyFeeCents)} policy fee` : ""}`} />
        <StatCell proof={derivedTarget("insurance", insuranceDerived([v]), "level-end", v.policy.policyNumber)}
          label="Level term ends"
          value={p.levelEndDate ? shortDate(p.levelEndDate) : "—"}
          sub={p.levelEndDate ? `${until(today, p.levelEndDate) ?? "ended"}${ageAtLevelEnd != null ? ` · insured age ${ageAtLevelEnd}` : ""}` : undefined}
        />
        <StatCell proof={derivedTarget("insurance", insuranceDerived([v]), "level-total", v.policy.policyNumber)}
          label="Total premiums"
          value={v.levelTotalCents != null ? usd0(v.levelTotalCents) : "—"}
          sub={v.levelTotalCents != null ? `${p.levelYears} × ${usd0(p.annualPremiumCents)}, fixed by contract` : undefined}
        />
      </StatGrid>

      {requirements && !requirements.past && (
        <Callout tone="warn" title={`Delivery requirements due ${longDate(requirements.date)}`}>
          {requirements.note}
        </Callout>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="The policy">
          <Facts
            rows={[
              ["Insurer", [p.insurer, p.brand && `(${p.brand})`].filter(Boolean).join(" ")],
              ["Product", p.product],
              ["Policy number", p.policyNumber],
              ["Insured", `${p.insured}${p.issueAge != null ? `, insurance age ${p.issueAge} at issue` : ""}`],
              ["Owner", p.owner],
              ["Premium class", p.premiumClass],
              ["Date of issue", longDate(p.issueDate)],
              ["Billing", [p.billing.frequency, p.billing.type].filter(Boolean).join(", ") || null],
              ["Riders", p.riders.map((r) => r.name).join("; ") || "None"],
              ["Agent", p.agent],
              ["Service line", p.servicePhone],
              ["Packet", v.file],
            ]}
          />
        </Card>
        <Card title="Coming up" subtitle="Dates set by the contract, counted from the date of issue.">
          {upcoming.length === 0 ? (
            <p className="text-sm text-muted">Every date in the contract has passed.</p>
          ) : (
            <ul className="divide-y divide-line">
              {upcoming.map((d) => (
                <li key={d.key} className="flex flex-wrap items-baseline gap-x-3 py-2 first:pt-0 last:pb-0">
                  <span className="num w-28 shrink-0 text-xs font-semibold text-fg">{shortDate(d.date)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="text-sm font-medium text-fg">{d.label}</span>
                    <span className="ml-2 text-xs text-muted">{until(today, d.date)}</span>
                    <span className="block text-xs text-muted">{d.note}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <BeneficiariesCard policyNumber={p.policyNumber} notes={notes} save={save} />
    </>
  );
}

function StatusBadge({ v }: { v: PolicyView }) {
  if (v.status === "NOT_STARTED") return <Badge tone="info">Not yet in force</Badge>;
  if (v.status === "ENDED") return <Badge tone="neutral">Ended</Badge>;
  return <Badge tone="pos">In force · year {v.currentYear}</Badge>;
}

function Facts({ rows }: { rows: [string, string | null | undefined][] }) {
  return (
    <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="min-w-0 break-words text-fg">{value}</dd>
          </div>
        ))}
    </dl>
  );
}

const blankBeneficiary = (): Beneficiary => ({ name: "", relationship: "", sharePct: 100, type: "PRIMARY" });

function BeneficiariesCard({ policyNumber, notes, save }: { policyNumber: string; notes: InsuranceNotes; save: (n: InsuranceNotes) => Promise<void> }) {
  const current: PolicyNotes = notes.policies[policyNumber] ?? { beneficiaries: [], note: "" };
  const [draft, setDraft] = useState<PolicyNotes | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = draft != null;
  const list = (draft ?? current).beneficiaries;
  const share = (type: Beneficiary["type"]) => list.filter((b) => b.type === type).reduce((s, b) => s + b.sharePct, 0);
  const primary = share("PRIMARY");
  const contingent = share("CONTINGENT");
  const hasContingent = current.beneficiaries.some((b) => b.type === "CONTINGENT");

  const set = (i: number, patch: Partial<Beneficiary>) => setDraft((d) => d && { ...d, beneficiaries: d.beneficiaries.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  const submit = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await save({ ...notes, policies: { ...notes.policies, [policyNumber]: draft } });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Beneficiaries"
      subtitle="Who the death benefit goes to. They're named on the application, a scanned page with no text, so they're typed in here. Change them with the insurer in writing; this list is your record."
      actions={
        !editing && (
          <button type="button" className={btn.secondary} onClick={() => setDraft({ ...current, beneficiaries: current.beneficiaries.length ? current.beneficiaries : [blankBeneficiary()] })}>
            {current.beneficiaries.length ? "Edit" : "Add beneficiaries"}
          </button>
        )
      }
    >
      {!editing ? (
        current.beneficiaries.length === 0 ? (
          <p className="text-sm text-muted">None entered yet.</p>
        ) : (
          <>
            <BeneficiaryTable list={current.beneficiaries} />
            {current.note && <p className="mt-3 whitespace-pre-wrap text-sm text-fg-2">{current.note}</p>}
            {!hasContingent && <p className="mt-3 text-xs text-muted">No contingent beneficiary: if no primary beneficiary is living, the contract pays the owner or the owner&apos;s estate.</p>}
          </>
        )
      ) : (
        <div className="flex flex-col gap-3">
          {draft.beneficiaries.map((b, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_10rem_6rem_9rem_auto]">
              <input className={inputCls} placeholder="Name" value={b.name} onChange={(e) => set(i, { name: e.target.value })} aria-label="Name" />
              <input className={inputCls} placeholder="Relationship" value={b.relationship} onChange={(e) => set(i, { relationship: e.target.value })} aria-label="Relationship" />
              <input className={inputCls} type="number" min={0} max={100} value={b.sharePct} onChange={(e) => set(i, { sharePct: Number(e.target.value) })} aria-label="Share %" />
              <select className={selectCls} value={b.type} onChange={(e) => set(i, { type: e.target.value as Beneficiary["type"] })} aria-label="Type">
                <option value="PRIMARY">Primary</option>
                <option value="CONTINGENT">Contingent</option>
              </select>
              <button type="button" className={btn.ghost} onClick={() => setDraft((d) => d && { ...d, beneficiaries: d.beneficiaries.filter((_, j) => j !== i) })}>
                Remove
              </button>
            </div>
          ))}
          <div>
            <button type="button" className={btn.ghost} onClick={() => setDraft((d) => d && { ...d, beneficiaries: [...d.beneficiaries, blankBeneficiary()] })}>
              + Add another
            </button>
          </div>
          <textarea className={`${inputCls} min-h-16`} placeholder="Note (optional)" value={draft.note} onChange={(e) => setDraft((d) => d && { ...d, note: e.target.value })} aria-label="Note" />
          {(primary !== 100 && list.some((b) => b.type === "PRIMARY")) || (contingent !== 0 && contingent !== 100) ? (
            <p className="text-xs text-warn">Shares should add up to 100% for each type (primary {primary}%{contingent ? `, contingent ${contingent}%` : ""}).</p>
          ) : null}
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex gap-2">
            <button type="button" className={btn.primary} disabled={busy} onClick={() => void submit()}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" className={btn.ghost} disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

function BeneficiaryTable({ list }: { list: Beneficiary[] }) {
  return (
    <div className={table.wrap}>
      <table className={table.table}>
        <thead>
          <tr className={table.head}>
            <th className={table.th}>Name</th>
            <th className={table.th}>Relationship</th>
            <th className={table.th}>Type</th>
            <th className={table.thR}>Share</th>
          </tr>
        </thead>
        <tbody>
          {[...list]
            .sort((a, b) => (a.type === b.type ? 0 : a.type === "PRIMARY" ? -1 : 1))
            .map((b, i) => (
              <tr key={i} className={table.tr}>
                <td className={table.td}>{b.name}</td>
                <td className={table.td}>{b.relationship || "—"}</td>
                <td className={table.td}>{b.type === "PRIMARY" ? "Primary" : "Contingent"}</td>
                <td className={table.tdR}>{b.sharePct}%</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------- premiums

function Premiums({ v, today }: { v: PolicyView; today: string }) {
  const chart = useChartPalette();
  const ui = chartChrome(chart);
  const p = v.policy;
  const [show, setShow] = useState<"term" | "all">("term");
  const levelYears = p.levelYears ?? 0;
  const shown = show === "term" ? v.years.filter((y) => y.year <= Math.max(levelYears + 10, 1)) : v.years;
  const data = useMemo(
    () => v.years.map((y) => ({ label: y.age != null ? `${y.age}` : `Y${y.year}`, year: y.year, premium: y.maxPremiumCents / 100, per1000: (y.maxPremiumCents * 1000) / y.faceCents, level: y.level })),
    [v.years],
  );
  const renewal = v.years.filter((y) => !y.level);
  const firstRenewal = renewal[0];
  const lastRenewal = renewal.at(-1);
  return (
    <>
      <StatGrid cols={4}>
        <StatCell proof={derivedTarget("insurance", insuranceDerived([v]), "premium", v.policy.policyNumber)} label="Fixed premium" value={usd0(p.annualPremiumCents)} sub={p.levelYears ? `Years 1–${p.levelYears}, guaranteed` : undefined} />
        <StatCell proof={derivedTarget("insurance", insuranceDerived([v]), "face", v.policy.policyNumber)} label="Coverage, level term" value={usd0(p.faceCents)} sub={p.levelEndDate ? `Through ${shortDate(addDays(p.levelEndDate, -1))}` : undefined} />
        <StatCell proof={derivedTarget("insurance", insuranceDerived([v]), "face-after", v.policy.policyNumber)} label="Coverage after" value={firstRenewal ? usd0(firstRenewal.faceCents) : "—"} sub={firstRenewal ? `From year ${firstRenewal.year}, renewing yearly` : undefined} />
        <StatCell proof={derivedTarget("insurance", insuranceDerived([v]), "max-premium-last", v.policy.policyNumber)}
          label="Maximum premium, last year"
          value={lastRenewal ? usd0(lastRenewal.maxPremiumCents) : "—"}
          sub={lastRenewal ? `Year ${lastRenewal.year}${lastRenewal.age != null ? `, age ${lastRenewal.age}` : ""}` : undefined}
        />
      </StatGrid>

      <Card
        title="Maximum premium by age"
        subtitle={`What the insurer may charge each year, by the insured's age. Inside the level term it's fixed; after it, the line is the guaranteed ceiling, not a quote, while the cover falls to ${firstRenewal ? usd0(firstRenewal.faceCents) : "the renewal amount"}.`}
      >
        <div className="h-64">
          <RechartsResponsive>
            <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid {...ui.grid} />
              <XAxis dataKey="label" {...ui.xAxis} minTickGap={20} />
              <YAxis {...ui.yAxis} scale="log" domain={["auto", "auto"]} ticks={[1000, 3000, 10_000, 30_000, 100_000]} tickFormatter={(n: number) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`)} />
              <Tooltip {...ui.tooltip} labelFormatter={(l) => `Age ${l}`} formatter={(n) => [formatUsdFromCents(Math.round(Number(n) * 100)), "Max premium"]} />
              {p.levelYears && <ReferenceLine x={data[p.levelYears]?.label} stroke={chart.axisLine} strokeDasharray="4 3" label={{ value: "Level term ends", fill: chart.axis, fontSize: 11, position: "insideTopLeft" }} />}
              <Line type="monotone" dataKey="premium" stroke={chart.series[0]} dot={false} strokeWidth={2} isAnimationActive={false} />
            </LineChart>
          </RechartsResponsive>
        </div>
        <p className="mt-2 text-xs text-muted">Log scale: each gridline step is a multiple, so the early years stay readable next to the late ones.</p>
      </Card>

      <Card
        title="Table of premiums and face amounts"
        subtitle="From the contract. Each policy year starts on the anniversary of the date of issue, when that year's premium is due."
        actions={
          <Segmented
            options={[
              { value: "term", label: "Term +10 years" },
              { value: "all", label: `All ${v.years.length} years` },
            ]}
            value={show}
            onChange={setShow}
          />
        }
      >
        <div className={table.wrap}>
          <table className={table.table}>
            <thead>
              <tr className={table.head}>
                <th className={table.th}>Year</th>
                <th className={table.th}>Due</th>
                <th className={table.thR}>Age</th>
                <th className={table.thR}>Premium</th>
                <th className={table.thR}>Face amount</th>
                <th className={table.thR}>Per $1,000</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((y) => {
                const now = y.year === v.currentYear;
                const past = y.end < today;
                return (
                  <tr key={y.year} className={`${table.tr} ${now ? "bg-accent-soft" : ""} ${past ? "text-muted" : ""} ${y.year === levelYears + 1 ? "border-t-2 border-line-strong" : ""}`}>
                    <td className={table.td}>
                      {y.year}
                      {now && <span className="ml-2 text-[11px] font-semibold text-accent">now</span>}
                    </td>
                    <td className={table.td}>{shortDate(y.start)}</td>
                    <td className={table.tdR}>{y.age ?? "—"}</td>
                    <td className={table.tdR}>
                      {formatUsdFromCents(y.maxPremiumCents)}
                      {!y.level && <span className="ml-1 text-faint" title="Guaranteed maximum: the insurer may charge less.">max</span>}
                    </td>
                    <td className={table.tdR}>{usd0(y.faceCents)}</td>
                    <td className={table.tdR}>{formatUsdFromCents(Math.round((y.maxPremiumCents * 100_000) / y.faceCents))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Paying other than once a year" subtitle="The contract's charge for each payment interval, as a share of the annual premium.">
        <div className={table.wrap}>
          <table className={table.table}>
            <thead>
              <tr className={table.head}>
                <th className={table.th}>Interval</th>
                <th className={table.thR}>Each payment</th>
                <th className={table.thR}>Payments</th>
                <th className={table.thR}>A year</th>
                <th className={table.thR}>Extra vs annual</th>
              </tr>
            </thead>
            <tbody>
              {v.modes.map((m) => (
                <tr key={m.mode} className={table.tr}>
                  <td className={table.td}>
                    {m.mode}
                    {m.mode === "Annual" && p.billing.frequency?.toLowerCase().startsWith("annual") && <Badge tone="accent">yours</Badge>}
                  </td>
                  <td className={table.tdR}>{formatUsdFromCents(m.perPaymentCents)}</td>
                  <td className={table.tdR}>{m.payments}</td>
                  <td className={table.tdR}>{formatUsdFromCents(m.yearCents)}</td>
                  <td className={table.tdR}>{m.extraCents ? `+${formatUsdFromCents(m.extraCents)} (${pct(m.extraCents / p.annualPremiumCents)})` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------- payments

function Payments({ v, accounts }: { v: PolicyView; accounts: Record<string, string> }) {
  const p = v.policy;
  const paidYears = new Set(v.payments.map((x) => x.year));
  const dueSoFar = v.years.filter((y) => v.currentYear != null && y.year <= v.currentYear);
  return (
    <>
      <StatGrid cols={v.paidTo ? 4 : 3}>
        <StatCell proof={derivedTarget("insurance", insuranceDerived([v]), "paid", v.policy.policyNumber)} label="Paid so far" value={usd0(v.paidCents)} sub={`${v.payments.length} premium${v.payments.length === 1 ? "" : "s"} found in the statements`} />
        <StatCell proof={derivedTarget("insurance", insuranceDerived([v]), "years-paid", v.policy.policyNumber)} label="Years paid" value={`${dueSoFar.filter((y) => paidYears.has(y.year)).length} of ${dueSoFar.length}`} sub="Policy years started so far" />
        <StatCell proof={derivedTarget("insurance", insuranceDerived([v]), "next-due", v.policy.policyNumber)} label="Next premium" value={v.nextDue ? usd0(v.nextDue.cents) : "—"} sub={v.nextDue ? `Due ${longDate(v.nextDue.date)} (year ${v.nextDue.year})` : undefined} />
        {v.paidTo && <StatCell proof={derivedTarget("insurance", insuranceDerived([v]), "paid-to", v.policy.policyNumber)} label="Paid to" value={shortDate(v.paidTo.date)} sub={`Per the insurer's policy summary of ${shortDate(v.paidTo.asOf)}`} />}
      </StatGrid>

      <Card title="Premiums in the statements" subtitle={`Charges to ${p.insurer} on your bank and card statements, each counted toward the policy year it paid for. Click an amount for the statement row.`}>
        {v.payments.length === 0 ? (
          <p className="text-sm text-muted">No premium to the insurer found in the statements yet.</p>
        ) : (
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr className={table.head}>
                  <th className={table.th}>Date</th>
                  <th className={table.th}>Policy year</th>
                  <th className={table.th}>Paid from</th>
                  <th className={table.th}>As printed</th>
                  <th className={table.thR}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {v.payments.map((x) => (
                  <tr key={x.rowId} className={table.tr}>
                    <td className={table.td}>{shortDate(x.date)}</td>
                    <td className={table.td}>{x.year}</td>
                    <td className={table.td}>{accounts[x.accountId] ?? "—"}</td>
                    <td className={`${table.td} max-w-[22rem] truncate text-fg-2`} title={x.payee}>
                      {x.payee}
                    </td>
                    <td className={table.tdR}>
                      <ProofValue proof={rowProof(x.rowId, x.cents)}>{formatUsdFromCents(x.cents)}</ProofValue>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {v.receipts.length > 0 && (
        <Card title="Payment confirmations" subtitle="The insurer's receipts found in the statements folder, and the statement charge each one confirms.">
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr className={table.head}>
                  <th className={table.th}>Paid</th>
                  <th className={table.th}>Confirmation</th>
                  <th className={table.th}>Charge</th>
                  <th className={table.th}>File</th>
                  <th className={table.thR}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {v.receipts.map((x) => {
                  const paid = v.payments.find((y) => y.rowId === x.paidBy);
                  return (
                    <tr key={x.file} className={table.tr}>
                      <td className={table.td}>{shortDate(x.date)}</td>
                      <td className={`${table.td} text-fg-2`}>{[x.confirmation, x.method].filter(Boolean).join(" · ") || "—"}</td>
                      <td className={table.td}>{paid ? `${shortDate(paid.date)} · ${accounts[paid.accountId] ?? "statement"}` : <span className="text-muted">Not found in the statements</span>}</td>
                      <td className={`${table.td} max-w-[16rem] truncate text-fg-2`} title={x.file}>
                        {x.file}
                      </td>
                      <td className={table.tdR}>{formatUsdFromCents(x.cents)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="Premium notices" subtitle="The insurer's billing notices found in the statements folder, and the statement charge that paid each one.">
        {v.bills.length === 0 ? (
          <p className="text-sm text-muted">No premium notice in the statements folder.</p>
        ) : (
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr className={table.head}>
                  <th className={table.th}>Due</th>
                  <th className={table.th}>Interval</th>
                  <th className={table.th}>Paid by</th>
                  <th className={table.th}>File</th>
                  <th className={table.thR}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {v.bills.map((b) => {
                  const paid = v.payments.find((x) => x.rowId === b.paidBy);
                  return (
                    <tr key={b.file} className={table.tr}>
                      <td className={table.td}>{shortDate(b.dueDate)}</td>
                      <td className={table.td}>{b.mode ?? "—"}</td>
                      <td className={table.td}>{paid ? `${shortDate(paid.date)} · ${accounts[paid.accountId] ?? "statement"}` : <span className="text-muted">Not found in the statements</span>}</td>
                      <td className={`${table.td} max-w-[16rem] truncate text-fg-2`} title={b.file}>
                        {b.file}
                      </td>
                      <td className={table.tdR}>{formatUsdFromCents(b.premiumCents)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------- terms

function Terms({ v }: { v: PolicyView }) {
  const p = v.policy;
  const yesNo = (b: boolean) => (b ? "Yes" : "No");
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="What kind of policy" subtitle="As the contract's cover page describes it.">
        <Facts
          rows={[
            ["Type", `Term life${p.levelYears ? `, ${p.levelYears}-year level premium` : ""}`],
            ["Renewable", p.features.renewable ? `Yes, yearly after the level term${p.finalEndDate ? `, until ${longDate(p.finalEndDate)}` : ""}` : "No"],
            ["Convertible", p.features.convertible ? `Yes${p.conversionExpiryDate ? `, ${p.conversionThroughExpiry ? "through" : "before"} ${longDate(p.conversionExpiryDate)}` : ""}${p.conversionMinFaceCents ? `; at least ${usd0(p.conversionMinFaceCents)} after converting` : ""}` : "No"],
            ["Re-entry option", p.features.reEntry ? `Yes${p.levelEndDate ? `, on ${longDate(p.levelEndDate)} only` : ""}` : "No"],
            ["Pays dividends", yesNo(p.features.participating)],
            ["Cash value", "None: term insurance pays only on death"],
          ]}
        />
      </Card>
      <Card title="Rules that protect the policy" subtitle="What keeps it in force, and how it can be undone.">
        <Facts
          rows={[
            ["Grace period", p.graceDays != null ? `${p.graceDays} days after a missed due date; the policy lapses after that` : null],
            ["Free look", p.freeLookDays != null ? `${p.freeLookDays} days after delivery to return it for a full refund` : null],
            ["Contestable", p.contestableYears != null ? `${p.contestableYears} years from issue (until ${longDate(addYears(p.issueDate, p.contestableYears))})` : null],
            ["Suicide exclusion", p.suicideYears != null ? `${p.suicideYears} years from issue: before then a claim pays back the premiums` : null],
            ["Proceeds left on deposit", p.paymentOptionsRate != null ? `Earn at least ${pct(p.paymentOptionsRate)} a year, guaranteed` : null],
            ["Premium after the term", "Can change on the anniversary after the level term and each one after, never above the table's maximum"],
          ]}
        />
      </Card>
      {p.riders.map((r) => (
        <Card key={r.name} title={r.name} subtitle="A rider attached to the policy, at no extra premium on the schedule.">
          <Facts rows={r.terms.map((t) => [t.label, t.value] as [string, string])} />
        </Card>
      ))}
      <Card title="Contacts">
        <Facts
          rows={[
            ["Insurer", p.insurer],
            ["Service line", p.servicePhone],
            ["Agent", p.agent],
            ["Packet dated", p.packetDate ? longDate(p.packetDate) : null],
          ]}
        />
      </Card>
    </div>
  );
}
