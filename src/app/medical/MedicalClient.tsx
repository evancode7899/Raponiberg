"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { chartChrome, useChartPalette } from "@/components/shell/chartPalette";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { Badge, Callout, Card, EmptyState, ErrorNote, Loading, NotFigure, PageBody, Segmented, StatCell, StatGrid, table, Tabs, useTabParam, WordsCell } from "@/components/ui/kit";
import { BALANCE_LABEL, balanceKey, medicalDerived, planLimitKey, sliceKey, yearKey } from "@/lib/book/derived/medical";
import { derivedTarget, type DerivedFigure } from "@/lib/book/derived/types";
import { axisUsd, formatUsdFromCents } from "@/lib/formatMoney";
import type { MedicalPage } from "@/lib/medical/page";
import type { HealthPlan } from "@/lib/medical/plans";
import type { ClaimView, LimitUse, Slice, YearView } from "@/lib/medical/report";
import type { Coverage, EobBalance } from "@/lib/medical/types";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from "recharts";

const URL = "/api/medical";
const TABS = ["overview", "claims", "providers", "plan", "documents"] as const;
const COVERAGE_LABEL: Record<Coverage, string> = { MEDICAL: "Medical", DENTAL: "Dental", VISION: "Vision" };

const money = (cents: number) => (cents === 0 ? "$0.00" : formatUsdFromCents(cents));
const shortDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const monthLabel = (m: string) => new Date(`${m}-15T12:00:00`).toLocaleDateString("en-US", { month: "short" });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const PER_LABEL: Record<string, string> = { CALENDAR_YEAR: "a calendar year", PLAN_YEAR: "a plan year", "12_MONTHS": "every 12 months", "24_MONTHS": "every 24 months", "36_MONTHS": "every 36 months", "60_MONTHS": "every 60 months", "3_YEARS": "every 3 years", "10_YEARS": "every 10 years", LIFETIME: "a lifetime" };
const SHORT_KIND: Record<EobBalance["kind"], string> = { DEDUCTIBLE: "deductible", OUT_OF_POCKET: "out-of-pocket", ANNUAL_MAXIMUM: "annual maximum" };

/** The page's figures and a lookup into them: every amount drawn here is one of these. */
function useFigures(data: MedicalPage | null) {
  const list = useMemo<DerivedFigure[]>(() => (data ? medicalDerived(data) : []), [data]);
  return (figure: string, key?: string) => derivedTarget("medical", list, figure, key);
}
type Fig = ReturnType<typeof useFigures>;

/** An amount from the page's figures, drawn as the figure says. */
function Amt({ fig, figure, k, cents }: { fig: Fig; figure: string; k: string; cents: number }) {
  return <ProofValue proof={fig(figure, k)}>{money(cents)}</ProofValue>;
}

export function MedicalClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [tab, setTab] = useTabParam(TABS, "overview");
  const [data, setData] = useState(() => cachedResponse<MedicalPage>(URL));
  const [error, setError] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<Coverage>("MEDICAL");
  const [pickedYear, setYear] = useState<string | null>(null);
  const fig = useFigures(data);

  useEffect(() => {
    if (!api.ready) return;
    api
      .call<MedicalPage>(URL)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [api]);

  const years = data?.years.filter((y) => y.coverage === coverage) ?? [];
  const year = years.find((y) => String(y.year) === pickedYear) ?? years[0] ?? null;
  const claims = data?.claims.filter((c) => c.coverage === coverage && c.year === year?.year) ?? [];
  const failing = data?.checks.filter((c) => !c.ok).length ?? 0;
  const tabs = [
    { id: "overview" as const, label: "Overview" },
    { id: "claims" as const, label: "Claims", count: claims.length || null },
    { id: "providers" as const, label: "Providers & care" },
    { id: "plan" as const, label: "Plan & coverage" },
    { id: "documents" as const, label: "Documents", count: failing || null },
  ];
  const hasAny = !!data && (data.statements.length > 0 || data.plans.length > 0 || data.pending.length > 0 || data.planDocs.length > 0);

  return (
    <>
      {hasAny && <Tabs tabs={tabs} value={tab} onChange={setTab} />}
      <PageBody>
        <ApiSecretField api={api} />
        {error && <ErrorNote>{error}</ErrorNote>}
        {!data ? (
          api.ready && !error && <Loading label="Reading the explanations of benefits…" />
        ) : !hasAny ? (
          <NothingYet scanned={data.scanned} />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <Segmented
                view
                options={data.coverages.map((c) => ({ value: c.coverage, label: `${COVERAGE_LABEL[c.coverage]}${c.statements || c.plans ? "" : " · soon"}` }))}
                value={coverage}
                onChange={(c) => {
                  setCoverage(c);
                  setYear(null);
                }}
              />
              {years.length > 1 && tab !== "plan" && tab !== "documents" && (
                <Segmented view={{ nested: true }} options={years.map((y) => ({ value: String(y.year), label: String(y.year) }))} value={String(year!.year)} onChange={setYear} />
              )}
            </div>
            {data.errors.length > 0 && (
              <Callout tone="warn" title="Some explanations of benefits couldn't be read">
                <ul className="list-disc space-y-1 pl-4">
                  {data.errors.map((e) => (
                    <li key={e.file}>
                      <code className="text-fg-2">{e.file}</code>: {e.error}
                    </li>
                  ))}
                </ul>
              </Callout>
            )}
            {coverage !== "MEDICAL" && !years.length && tab !== "documents" ? (
              <ComingSoon data={data} coverage={coverage} />
            ) : (
              <>
                {tab === "overview" && (year ? <Overview y={year} fig={fig} /> : <NoClaims coverage={coverage} />)}
                {tab === "claims" && (year ? <Claims y={year} claims={claims} fig={fig} /> : <NoClaims coverage={coverage} />)}
                {tab === "providers" && (year ? <Providers y={year} fig={fig} /> : <NoClaims coverage={coverage} />)}
                {tab === "plan" && <Plans plans={data.plans.filter((p) => p.coverage === coverage)} uses={data.planLimits} problems={data.planProblems} fig={fig} coverage={coverage} />}
              </>
            )}
            {tab === "documents" && <Documents data={data} coverage={coverage} fig={fig} />}
          </div>
        )}
      </PageBody>
    </>
  );
}

function NothingYet({ scanned }: { scanned: boolean }) {
  return (
    <EmptyState title="No health insurance documents found">
      {scanned
        ? "Save your insurer's Explanation of Benefits statements (EOBs) and the plan's documents (the Summary of Benefits and Coverage, the certificate or plan booklet) anywhere in your statements folder, then open this page again. Medical EOBs are read automatically; dental and vision readers are on the way."
        : "The statements folder wasn't found. Set STATEMENTS_DIR, then save the EOBs and plan documents there."}
    </EmptyState>
  );
}

function NoClaims({ coverage }: { coverage: Coverage }) {
  return <EmptyState title={`No ${COVERAGE_LABEL[coverage].toLowerCase()} claims yet`}>Claims appear here as the insurer&apos;s explanations of benefits are saved to the statements folder.</EmptyState>;
}

/** Dental and vision: what's already found, and what reading them needs. */
function ComingSoon({ data, coverage }: { data: MedicalPage; coverage: Coverage }) {
  const c = data.coverages.find((x) => x.coverage === coverage)!;
  const name = COVERAGE_LABEL[coverage].toLowerCase();
  return (
    <Card tone="overview" title={`${COVERAGE_LABEL[coverage]} coverage`} subtitle="Coming soon" actions={<Badge tone="info">Reader on the way</Badge>}>
      <div className="space-y-2 text-sm text-fg-2">
        <p>
          Save the {name} plan&apos;s explanations of benefits and its plan documents (summary of benefits, certificate or booklet) in the statements folder, in a folder of their own. The folder scan already looks for them: {name} EOBs are kept aside until their reader lands, and the plan documents are listed on the Documents tab.
        </p>
        <p>
          Found so far: {plural(c.pending, `${name} EOB`)} waiting for the reader, {plural(c.planDocs, "plan document")}, {plural(c.plans, "plan")} on file.
        </p>
        <p>
          Once they&apos;re there, ask Claude to read the plan documents into <code>data/medical-plans.json</code> (coverage <code>{coverage}</code>) and to add the {name} EOB reader. This tab then fills in the same way as Medical: claims, annual maximum and deductible, what&apos;s covered and how often.
        </p>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------- overview

function Meter({ used, limit }: { used: number; limit: number }) {
  const share = limit > 0 ? Math.min(1, used / limit) : 0;
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden>
      <div className={`h-full rounded-full ${share >= 1 ? "bg-pos" : "bg-accent"}`} style={{ width: `${share * 100}%` }} />
    </div>
  );
}

function BalanceCell({ y, row, fig, label }: { y: YearView; row: EobBalance; fig: Fig; label: string }) {
  const k = balanceKey(y, row);
  const met = row.usedCents >= row.limitCents;
  const done = row.kind === "ANNUAL_MAXIMUM" ? " · used up" : " · met";
  return (
    <div className="min-w-0 bg-surface px-4 py-3">
      <div className="truncate text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="num mt-1 text-xl font-semibold tracking-tight">
        <Amt fig={fig} figure="balance-used" k={k} cents={row.usedCents} />
      </div>
      <div className="mt-0.5 text-xs text-muted">
        of <Amt fig={fig} figure="balance-limit" k={k} cents={row.limitCents} />
        {met ? done : (
          <>
            {" · "}
            <Amt fig={fig} figure="balance-left" k={k} cents={row.remainingCents} /> left
          </>
        )}
      </div>
      <Meter used={row.usedCents} limit={row.limitCents} />
    </div>
  );
}

function Overview({ y, fig }: { y: YearView; fig: Fig }) {
  const k = yearKey(y);
  const T = y.totals;
  const chart = useChartPalette();
  const ui = chartChrome(chart);
  const inNet = y.balances?.rows.filter((r) => r.inNetwork) ?? [];
  const family = inNet.filter((r) => r.person == null);
  const people = [...new Set(inNet.filter((r) => r.person).map((r) => r.person!))];
  const outNetUsed = y.balances?.rows.some((r) => !r.inNetwork && r.usedCents > 0);
  return (
    <>
      <Card
        tone="overview"
        title={`${y.year} ${COVERAGE_LABEL[y.coverage].toLowerCase()} care`}
        subtitle={[y.plan?.name, y.plan?.sponsor && `through ${y.plan.sponsor}`].filter(Boolean).join(" · ") || "From the insurer's explanations of benefits"}
        actions={y.plan?.hsaEligible ? <Badge tone="info" title="A high-deductible plan: you can contribute to a Health Savings Account while covered.">HSA-eligible</Badge> : undefined}
      >
        <p className="text-sm text-fg-2">
          {plural(T.claims, "claim")} for {y.people.length === 1 ? "1 person" : `${y.people.length} people`} across {plural(y.providers.length, "provider")}
          {y.balances ? `, with the plan's balances as of the EOB of ${shortDate(y.balances.asOf)}.` : "."} What you owe is what each EOB says you owe the provider; check it against the provider&apos;s bill before paying, and pay from the HSA if you like.
        </p>
      </Card>
      <StatGrid cols={5}>
        <StatCell proof={fig("you-owe", k)} label="You owe" value={money(T.yourShareCents)} sub="Your share on every claim" />
        <StatCell proof={fig("plan-paid", k)} label="Plan paid" value={money(T.planCents)} sub="To your providers" />
        <StatCell proof={fig("billed", k)} label="Billed" value={money(T.billedCents)} sub="What providers charged" />
        <StatCell proof={fig("write-off", k)} label="Discounts & not owed" value={money(T.writeOffCents)} sub="Network rates and charges you don't owe" />
        {T.otherPlanCents ? <StatCell proof={fig("other-paid", k)} label="Other plan paid" value={money(T.otherPlanCents)} sub="Paid first (coordination of benefits)" /> : <StatCell proof={fig("claims", k)} label="Claims" value={String(T.claims)} sub="An adjusted claim counts once" />}
      </StatGrid>

      {y.balances && (
        <Card
          title={[...new Set(inNet.map((r) => BALANCE_LABEL[r.kind]))].join(" and ").replace(/^./, (c) => c.toUpperCase())}
          subtitle={`${y.coverage === "MEDICAL" ? "In network, as the insurer counted them" : "As the insurer printed them, each person on their latest statement"}, through the EOB of ${shortDate(y.balances.asOf)} (${shortDate(y.balances.from)} – ${shortDate(y.balances.to)})${inNet.some((r) => r.includesPharmacy) ? "; both count medical and pharmacy" : ""}.`}
        >
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
            {family.map((r) => (
              <BalanceCell key={r.kind} y={y} row={r} fig={fig} label={`Family ${SHORT_KIND[r.kind]}`} />
            ))}
            {people.flatMap((p) =>
              inNet.filter((r) => r.person === p).map((r) => <BalanceCell key={`${p}${r.kind}`} y={y} row={r} fig={fig} label={`${p} · ${SHORT_KIND[r.kind]}`} />),
            )}
          </div>
          <p className="mt-2 text-xs text-muted">
            {y.coverage === "MEDICAL" && (outNetUsed ? "Some out-of-network care counted too: see Documents for the EOB's full balances." : "No out-of-network care counted this year.")}{inNet.some((r) => r.kind === "OUT_OF_POCKET") && " Once the family out-of-pocket limit is met, covered in-network care is paid in full for the rest of the year."}
            {inNet.some((r) => r.kind === "ANNUAL_MAXIMUM") && " The annual maximum is the most the plan pays for each person in a year, in network or out; care beyond it is yours."}
          </p>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="By month" subtitle="Who paid for each month's care, by the first day of each claim">
          <div className="h-56">
          <RechartsResponsive>
            <BarChart data={y.months.map((m) => ({ label: monthLabel(m.month), you: m.yourShareCents / 100, plan: m.planCents / 100 }))}>
              <CartesianGrid {...ui.grid} />
              <XAxis dataKey="label" {...ui.xAxis} />
              <YAxis {...ui.yAxis} tickFormatter={(n: number) => axisUsd(n)} />
              <Tooltip {...ui.tooltip} formatter={(v) => `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
              <Legend {...ui.legend} />
              <Bar dataKey="you" name="You owe" stackId="a" fill={chart.series[0]} isAnimationActive={false} />
              <Bar dataKey="plan" name="Plan paid" stackId="a" fill={chart.series[1]} isAnimationActive={false} />
            </BarChart>
          </RechartsResponsive>
          </div>
        </Card>
        <Card title="By person" subtitle="Visits are days with care from a provider">
          <SliceTable y={y} rows={y.people} kind="person" fig={fig} name="Person" />
        </Card>
      </div>
    </>
  );
}

function SliceTable({ y, rows, kind, fig, name }: { y: YearView; rows: Slice[]; kind: "person" | "provider" | "kind"; fig: Fig; name: string }) {
  return (
    <div className={table.wrap}>
      <table className={table.table}>
        <thead>
          <tr className={table.head}>
            <th className={table.th}>{name}</th>
            {kind !== "kind" && <th className={table.thR}>Visits</th>}
            <th className={table.thR}>Claims</th>
            {kind !== "person" && <th className={table.thR}>Billed</th>}
            {kind !== "kind" && <th className={table.thR}>Plan paid</th>}
            <th className={table.thR}>You owe</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const k = sliceKey(y, s.key);
            return (
              <tr key={s.key} className={table.tr}>
                <td className={`${table.td} max-w-[18rem] truncate`} title={s.key}>
                  {s.key}
                </td>
                {kind !== "kind" && <td className={table.tdR}>{s.visits}</td>}
                <td className={table.tdR}>{s.claims}</td>
                {kind !== "person" && (
                  <td className={table.tdR}>
                    <Amt fig={fig} figure={`${kind}-billed`} k={k} cents={s.billedCents} />
                  </td>
                )}
                {kind !== "kind" && (
                  <td className={table.tdR}>
                    <Amt fig={fig} figure={`${kind}-plan`} k={k} cents={s.planCents} />
                  </td>
                )}
                <td className={table.tdR}>
                  <Amt fig={fig} figure={`${kind}-you`} k={k} cents={s.yourShareCents} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------- claims

function Claims({ y, claims, fig }: { y: YearView; claims: ClaimView[]; fig: Fig }) {
  const [open, setOpen] = useState<string | null>(null);
  const [who, setWho] = useState<string>("all");
  const shown = who === "all" ? claims : claims.filter((c) => c.patient === who);
  return (
    <Card title={`${y.year} claims`} subtitle="Every claim on the explanations of benefits, newest first. An adjusted claim replaces the version before it. Click an amount for the service lines behind it; click a row for the services and the insurer's remarks.">
      {y.people.length > 1 && (
        <div className="mb-3">
          <Segmented options={[{ value: "all", label: "Everyone" }, ...y.people.map((p) => ({ value: p.key, label: p.key }))]} value={who} onChange={setWho} />
        </div>
      )}
      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr className={table.head}>
              <th className={table.th}>Date</th>
              <th className={table.th}>Patient</th>
              <th className={table.th}>Provider</th>
              <th className={table.th}>Care</th>
              <th className={table.thR}>Billed</th>
              <th className={table.thR}>Plan paid</th>
              <th className={table.thR}>You owe</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <Fragment key={c.id}>
                <tr className={`${table.trHover} cursor-pointer`} onClick={() => setOpen(open === c.id ? null : c.id)}>
                  <td className={`${table.td} whitespace-nowrap`}>{c.firstDate === c.lastDate ? shortDate(c.firstDate) : `${shortDate(c.firstDate)} – ${shortDate(c.lastDate)}`}</td>
                  <td className={table.td}>{c.patient}</td>
                  <td className={`${table.td} max-w-[16rem] truncate`} title={c.provider}>
                    {c.provider || <span className="text-muted">Not printed</span>}
                    {c.inNetwork === false && (
                      <>
                        {" "}
                        <Badge tone="warn">Out of network</Badge>
                      </>
                    )}
                  </td>
                  <td className={`${table.td} whitespace-nowrap text-fg-2`}>
                    {c.kind}
                    {c.earlier.length > 0 && (
                      <>
                        {" "}
                        <Badge tone="info" title="The insurer reprocessed this claim: this version replaces the earlier one.">Adjusted</Badge>
                      </>
                    )}
                    {c.cob && (
                      <>
                        {" "}
                        <Badge tone="info" title="Another plan paid first (coordination of benefits).">COB</Badge>
                      </>
                    )}
                  </td>
                  <td className={table.tdR} onClick={(e) => e.stopPropagation()}>
                    <Amt fig={fig} figure="claim-billed" k={c.id} cents={c.billedCents} />
                  </td>
                  <td className={table.tdR} onClick={(e) => e.stopPropagation()}>
                    <Amt fig={fig} figure="claim-plan" k={c.id} cents={c.planCents} />
                  </td>
                  <td className={`${table.tdR} font-medium`} onClick={(e) => e.stopPropagation()}>
                    <Amt fig={fig} figure="claim-you" k={c.id} cents={c.yourShareCents} />
                  </td>
                </tr>
                {open === c.id && (
                  <tr className="bg-surface-2">
                    <td colSpan={7} className="px-3 py-2 text-xs text-fg-2">
                      <ClaimDetail c={c} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ClaimDetail({ c }: { c: ClaimView }) {
  const remarks = Object.entries(c.remarks);
  return (
    <div className="space-y-2">
      <div>
        Claim <code>{c.id}</code>
        {c.received && ` · received ${shortDate(c.received)}`} · on the EOB of {shortDate(c.statementDate)}
        {c.relationship && ` · ${c.patient} (${c.relationship})`}
      </div>
      <ul className="list-disc space-y-0.5 pl-4">
        {c.lines.map((l, i) => (
          <li key={i}>
            {shortDate(l.date)}
            {l.dateTo && ` – ${shortDate(l.dateTo)}`}: {l.service}
            {l.code && <span className="text-muted"> ({l.code})</span>}
            {l.remarks.length > 0 && <span className="text-muted"> · remark {l.remarks.join(", ")}</span>}
          </li>
        ))}
      </ul>
      {c.earlier.length > 0 && <div>Replaces {c.earlier.map((e) => `claim ${e.id} on the EOB of ${shortDate(e.statementDate)}`).join(" and ")}: the amounts shown are this version&apos;s. Click an amount for what the earlier version said.</div>}
      {c.cob && <div>Another plan paid first: what you owe and what this plan paid are the EOB&apos;s figures after coordination of benefits.</div>}
      {remarks.length > 0 && (
        <div className="space-y-0.5">
          {remarks.map(([n, text]) => (
            <div key={n}>
              <NotFigure why="The insurer's remark, as the EOB prints it">
                ({n}) {text}
              </NotFigure>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- providers & care

function Providers({ y, fig }: { y: YearView; fig: Fig }) {
  return (
    <>
      <Card title="Providers" subtitle={`Every provider with a ${y.year} claim, by what you owe`}>
        <SliceTable y={y} rows={y.providers} kind="provider" fig={fig} name="Provider" />
      </Card>
      <Card title="Kinds of care" subtitle="Grouped by each claim's procedure codes (most of its billed amount)">
        <SliceTable y={y} rows={y.kinds} kind="kind" fig={fig} name="Care" />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------- plan & coverage

function Plans({ plans, uses, problems, fig, coverage }: { plans: HealthPlan[]; uses: Record<string, LimitUse[]>; problems: MedicalPage["planProblems"]; fig: Fig; coverage: Coverage }) {
  return (
    <>
      {problems.length > 0 && (
        <Callout tone="warn" title="Some plans in data/medical-plans.json couldn't be used">
          <ul className="list-disc space-y-1 pl-4">
            {problems.map((p) => (
              <li key={p.id}>
                <code>{p.id}</code> {p.problem}
              </li>
            ))}
          </ul>
        </Callout>
      )}
      {!plans.length ? (
        <EmptyState title={`No ${COVERAGE_LABEL[coverage].toLowerCase()} plan on file`}>
          Save the plan&apos;s documents (its Summary of Benefits and Coverage and certificate or booklet) in the statements folder, then ask Claude to read them into <code>data/medical-plans.json</code>.
        </EmptyState>
      ) : (
        plans.map((p) => <PlanView key={p.id} p={p} uses={uses[p.id] ?? []} fig={fig} />)
      )}
    </>
  );
}

const terms = (s: string) => <NotFigure why="The plan's terms, as its documents print them">{s}</NotFigure>;

function PlanView({ p, uses, fig }: { p: HealthPlan; uses: LimitUse[]; fig: Fig }) {
  const amount = (figure: string, network: "in" | "out", who: "individual" | "family", cents: number | null | undefined) =>
    cents == null ? <span className="text-muted">None</span> : <ProofValue proof={fig(figure, planLimitKey(p, network, who))}>{money(cents)}</ProofValue>;
  const byId = new Map(uses.map((u) => [u.limit.id, u]));
  const limitRows = [
    ...(p.deductible ? [{ label: "Deductible", figure: "plan-deductible", inNet: p.deductible.inNetwork, outNet: p.deductible.outOfNetwork }] : []),
    ...(p.outOfPocket ? [{ label: "Out-of-pocket limit", figure: "plan-oop", inNet: p.outOfPocket.inNetwork, outNet: p.outOfPocket.outOfNetwork }] : []),
    ...(p.annualMaximum ? [{ label: "Annual maximum", figure: "plan-max", inNet: p.annualMaximum, outNet: null }] : []),
  ];
  const outNet = limitRows.some((r) => r.outNet);
  return (
    <>
      <Card
        tone="overview"
        title={p.name}
        subtitle={[p.insurer, p.type, p.sponsor && `through ${p.sponsor}`, `${shortDate(p.coverageFrom)} – ${shortDate(p.coverageTo)}`].filter(Boolean).join(" · ")}
        actions={
          <div className="flex gap-1">
            {p.hsaEligible && <Badge tone="info">HSA-eligible</Badge>}
            <Badge>{p.accumulator === "CALENDAR_YEAR" ? "Resets each Jan 1" : "Resets each plan year"}</Badge>
          </div>
        }
      >
        <p className="text-sm text-fg-2">
          {[p.covers && `Covers ${p.covers.toLowerCase()}.`, p.network && `Network: ${p.network}.`, p.embeddedDeductible && "Each person meets their own deductible inside the family's."].filter(Boolean).join(" ")}
        </p>
      </Card>
      {(p.deductible || p.outOfPocket || p.annualMaximum) && (
        <Card title={limitRows.map((r) => r.label.toLowerCase()).join(", ").replace(/^./, (c) => c.toUpperCase())} subtitle={p.outOfPocketExcludes?.length ? `Not counted toward the out-of-pocket limit: ${p.outOfPocketExcludes.join(", ").toLowerCase()}.` : undefined}>
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr className={table.head}>
                  <th className={table.th} />
                  <th className={table.thR}>{outNet ? "In network, each" : "Each person"}</th>
                  <th className={table.thR}>{outNet ? "In network, family" : "Family"}</th>
                  {outNet && <th className={table.thR}>Out of network, each</th>}
                  {outNet && <th className={table.thR}>Out of network, family</th>}
                </tr>
              </thead>
              <tbody>
                {limitRows.map((r) => (
                  <tr key={r.figure} className={table.tr}>
                    <td className={table.td}>{r.label}</td>
                    <td className={table.tdR}>{amount(r.figure, "in", "individual", r.inNet?.individualCents)}</td>
                    <td className={table.tdR}>{amount(r.figure, "in", "family", r.inNet?.familyCents)}</td>
                    {outNet && <td className={table.tdR}>{r.figure === "plan-max" ? <span className="text-muted">Same</span> : amount(r.figure, "out", "individual", r.outNet?.individualCents)}</td>}
                    {outNet && <td className={table.tdR}>{r.figure === "plan-max" ? <span className="text-muted">Same</span> : amount(r.figure, "out", "family", r.outNet?.familyCents)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        {!!p.beforeDeductible?.length && (
          <div className="mt-3 text-xs text-fg-2">
            <span className="font-medium text-fg">Covered before the deductible: </span>
            {terms(p.beforeDeductible.join("; "))}
          </div>
        )}
        </Card>
      )}

      {!!p.allowances?.length && (
        <Card title="Allowances" subtitle="What the plan puts toward each item; you pay anything above it (less any member discount).">
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr className={table.head}>
                  <th className={table.th}>Item</th>
                  <th className={table.thR}>Allowance</th>
                  <th className={table.th}>How often</th>
                </tr>
              </thead>
              <tbody>
                {p.allowances.map((a) => (
                  <tr key={a.id} className={table.tr}>
                    <td className={table.td}>
                      {a.service}
                      {a.note && <div className="text-xs text-muted">{terms(a.note)}</div>}
                    </td>
                    <td className={table.tdR}>
                      <ProofValue proof={fig("plan-allowance", `${p.id}|${a.id}`)}>{money(a.cents)}</ProofValue>
                    </td>
                    <td className={table.td}>{PER_LABEL[a.per]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {p.limits.length > 0 && (
        <Card title="Visit and service limits" subtitle="How much of each capped service the plan covers, and how much the claims show used (services the plan covered; a refused claim uses none). A limit whose care has no procedure code to count is listed only.">
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr className={table.head}>
                  <th className={table.th}>Service</th>
                  <th className={table.th}>Plan covers</th>
                  <th className={table.th}>Used</th>
                </tr>
              </thead>
              <tbody>
                {p.limits.map((l) => {
                  const u = byId.get(l.id);
                  return (
                    <tr key={l.id} className={table.tr}>
                      <td className={table.td}>
                        {l.service}
                        {(l.note || l.ages) && <div className="text-xs text-muted">{[l.ages, l.note].filter(Boolean).join(" · ")}</div>}
                      </td>
                      <td className={`${table.td} whitespace-nowrap`}>
                        {l.limit} {l.unit} {PER_LABEL[l.per]}
                      </td>
                      <td className={table.td}>
                        {!u?.tracked ? (
                          <span className="text-muted">Not counted from claims</span>
                        ) : u.people.length === 0 ? (
                          <span className="text-muted">None {l.per === "CALENDAR_YEAR" ? `in ${u.from.slice(0, 4)}` : l.per === "LIFETIME" ? "yet" : `since ${shortDate(u.from)}`}</span>
                        ) : (
                          u.people.map((x) => (
                            <div key={x.person} title={x.dates.map(shortDate).join(", ")}>
                              {x.person}: {x.used} of {l.limit}
                              {x.nextOn && <span className="text-muted"> · covered again {shortDate(x.nextOn)}</span>}
                              {x.used >= l.limit ? (
                                <>
                                  {" "}
                                  <Badge tone="warn">Limit reached</Badge>
                                </>
                              ) : <span className="text-muted"> · {l.limit - x.used} left</span>}
                            </div>
                          ))
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="What you pay for care" subtitle="After the deductible, unless it says otherwise; as the plan's summary of benefits and schedule print it.">
        <div className={table.wrap}>
          <table className={table.table}>
            <thead>
              <tr className={table.head}>
                <th className={table.th}>Service</th>
                <th className={table.th}>In network</th>
                <th className={table.th}>Out of network</th>
              </tr>
            </thead>
            <tbody>
              {p.services.map((g) => (
                <Fragment key={g.group}>
                  <tr className={table.tr}>
                    <td colSpan={3} className={`${table.td} pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted`}>
                      {g.group}
                    </td>
                  </tr>
                  {g.items.map((s) => (
                    <tr key={s.service} className={table.tr}>
                      <td className={table.td}>
                        {s.service}
                        {s.note && <div className="text-xs text-muted">{terms(s.note)}</div>}
                      </td>
                      <td className={table.td}>{terms(s.inNetwork)}</td>
                      <td className={`${table.td} text-fg-2`}>{terms(s.outOfNetwork)}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Not covered">
          <ul className="list-disc space-y-1 pl-4 text-sm text-fg-2">
            {p.excluded.map((x) => (
              <li key={x}>{terms(x)}</li>
            ))}
          </ul>
        </Card>
        <Card title="Also covered, with limits">
          <ul className="list-disc space-y-1 pl-4 text-sm text-fg-2">
            {p.otherCovered.map((x) => (
              <li key={x}>{terms(x)}</li>
            ))}
          </ul>
        </Card>
      </div>

      {p.rules.length > 0 && (
        <Card title="Rules worth knowing">
          <dl className="space-y-2 text-sm">
            {p.rules.map((r) => (
              <div key={r.title}>
                <dt className="font-medium">{r.title}</dt>
                <dd className="text-fg-2">{terms(r.text)}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      <Card title="Read from" subtitle="The plan's documents in the statements folder; the plan's terms live in data/medical-plans.json.">
        <ul className="space-y-1 text-sm">
          {p.sources.map((s) => (
            <li key={s.file}>
              {s.title}
              {s.date && <span className="text-muted"> · {shortDate(s.date)}</span>}
              <div className="truncate text-xs text-muted" title={s.file}>
                <code>{s.file}</code>
              </div>
            </li>
          ))}
        </ul>
        {!!p.notes?.length && (
          <div className="mt-3 space-y-1 text-xs text-muted">
            {p.notes.map((n) => (
              <p key={n}>{terms(n)}</p>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------- documents

function CheckList({ checks }: { checks: MedicalPage["checks"] }) {
  return (
    <ul className="space-y-1 text-xs">
      {checks.map((c) => (
        <li key={c.id} className="flex items-start gap-2">
          <Badge tone={c.ok ? "pos" : "neg"}>{c.ok ? "Pass" : "Fail"}</Badge>
          <span>
            <span className="font-medium">{c.subject}</span>{" "}
            <span className="text-fg-2">
              <NotFigure why="A check's finding, in words">{c.detail}</NotFigure>
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Documents({ data, coverage, fig }: { data: MedicalPage; coverage: Coverage; fig: Fig }) {
  const statements = data.statements.filter((s) => s.coverage === coverage);
  const planDocs = data.planDocs.filter((d) => d.coverage === coverage);
  const pending = data.pending.filter((d) => d.coverage === coverage);
  const files = new Set([...statements.map((s) => s.file), ...planDocs.map((d) => d.file)]);
  const checks = data.checks.filter((c) => !c.file || files.has(c.file));
  const failing = checks.filter((c) => !c.ok);
  const unread = planDocs.filter((d) => !d.read);
  return (
    <>
      <StatGrid cols={4}>
        <WordsCell label="Explanations of benefits" value={String(statements.length)} sub={statements[0] ? `Latest ${shortDate(statements[0].statementDate)}` : "None yet"} />
        <WordsCell label="Plan documents" value={String(planDocs.length)} sub={unread.length ? `${unread.length} not read into the plan file yet` : planDocs.length ? "All read into the plan file" : "None yet"} tone={unread.length ? "warn" : "neutral"} />
        <WordsCell label="Waiting for a reader" value={String(pending.length)} sub={pending.length ? "Kept aside until their reader lands" : "Nothing waiting"} />
        <WordsCell label="Checks" value={failing.length ? `${failing.length} failing` : "All pass"} sub={`${checks.length} checks over these documents`} tone={failing.length ? "neg" : "pos"} />
      </StatGrid>

      {unread.length > 0 && (
        <Callout tone="info" title="Plan documents not read yet">
          {plural(unread.length, "plan document")} in the folder {unread.length === 1 ? "isn't" : "aren't"} a source of any plan in <code>data/medical-plans.json</code>. Ask Claude to read {unread.length === 1 ? "it" : "them"} in.
        </Callout>
      )}

      <Card title="Checks" subtitle="Each EOB held to itself (lines add to each claim's totals; the payment summary is its claims) and each plan's limits to the ones its EOBs count against.">
        {checks.length === 0 ? (
          <p className="text-sm text-muted">No documents to check yet.</p>
        ) : (
          <div className="space-y-2">
            {failing.length > 0 && <CheckList checks={failing} />}
            {checks.length > failing.length && (
              <details className="text-xs">
                <summary className="cursor-pointer text-fg-2">{plural(checks.length - failing.length, "check")} pass</summary>
                <div className="mt-2">
                  <CheckList checks={checks.filter((c) => c.ok)} />
                </div>
              </details>
            )}
          </div>
        )}
      </Card>

      {statements.length > 0 && (
        <Card title="Explanations of benefits" subtitle="Each statement as read, newest first">
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr className={table.head}>
                  <th className={table.th}>Statement</th>
                  <th className={table.th}>File</th>
                  <th className={table.thR}>Claims</th>
                  <th className={table.thR}>Plan paid</th>
                  <th className={table.thR}>You owe</th>
                </tr>
              </thead>
              <tbody>
                {statements.map((s) => (
                  <tr key={s.file} className={table.tr}>
                    <td className={`${table.td} whitespace-nowrap`}>
                      {shortDate(s.statementDate)} <span className="text-muted">· {s.insurer}</span>
                    </td>
                    <td className={`${table.td} max-w-[16rem] truncate text-fg-2`} title={s.file}>
                      {s.file.split("/").at(-1)}
                    </td>
                    <td className={table.tdR}>{s.claims}</td>
                    <td className={table.tdR}>
                      <Amt fig={fig} figure="statement-plan" k={s.file} cents={s.planCents} />
                    </td>
                    <td className={table.tdR}>
                      <Amt fig={fig} figure="statement-you" k={s.file} cents={s.yourShareCents} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {(planDocs.length > 0 || pending.length > 0) && (
        <Card title="Other documents found">
          <ul className="space-y-1 text-sm">
            {planDocs.map((d) => (
              <li key={d.file} className="flex flex-wrap items-center gap-2">
                <Badge tone={d.read ? "pos" : "warn"}>{d.read ? "Read" : "Not read yet"}</Badge>
                <span>
                  {d.title}
                  {d.insurer && <span className="text-muted"> · {d.insurer}</span>}
                  {d.periodFrom && d.periodTo && <span className="text-muted"> · {shortDate(d.periodFrom)} – {shortDate(d.periodTo)}</span>}
                </span>
                <code className="truncate text-xs text-muted" title={d.file}>
                  {d.file}
                </code>
              </li>
            ))}
            {pending.map((d) => (
              <li key={d.file} className="flex flex-wrap items-center gap-2">
                <Badge tone="info">Waiting for reader</Badge>
                <span>
                  {COVERAGE_LABEL[d.coverage]} EOB{d.statementDate && ` of ${shortDate(d.statementDate)}`}
                  {d.insurer && <span className="text-muted"> · {d.insurer}</span>}
                </span>
                <code className="truncate text-xs text-muted" title={d.file}>
                  {d.file}
                </code>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
