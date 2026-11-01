"use client";

import { RechartsResponsive } from "@/components/charts/RechartsResponsive";
import { ShareBar, ShareLegend, type ShareSegment } from "@/components/charts/ShareBar";
import { BlockedNote } from "@/components/ledger/Blocked";
import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { chartChrome, useChartPalette, type ChartPalette } from "@/components/shell/chartPalette";
import { Badge, btn, Callout, Card, EmptyState, ErrorNote, Field, Loading, PageBody, PercentInput, selectCls, StatCell, StatGrid, table, Tabs, useTabParam } from "@/components/ui/kit";
import type { ProofTarget } from "@/components/ui/proof/context";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import type { ClassAmount, ClassId, InvestmentsReport, PositionRow } from "@/lib/book/reports/investments";
import { axisUsd, formatPercentRatio, usd0, usdDelta } from "@/lib/formatMoney";
import { ASSET_CLASSES, classLabel, type AssetClass, type Weights } from "@/lib/investments/securities";
import type { FundsPage } from "@/lib/funds/page";
import type { InvestmentSettings } from "@/lib/investments/settings";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LpPanel, PrivateFunds } from "./LpView";
import { CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { growthKey, investmentsDerived } from "@/lib/book/derived/investments";
import { cellKey, derivedTarget } from "@/lib/book/derived/types";

const TABS = ["overview", "holdings", "fees", "gains", "growth", "funds"] as const;
type Data = { report: InvestmentsReport; settings: InvestmentSettings; /** The forecast's return. */ returnRate: number };

/** Each asset class keeps one chart slot everywhere; unclassified is the neutral gray. */
export function classColor(p: ChartPalette, c: ClassId) {
  const i = ASSET_CLASSES.findIndex((x) => x.id === c);
  return i < 0 ? p.neutral : p.series[i]!;
}

const segmentsOf = (p: ChartPalette, xs: ClassAmount[]): ShareSegment[] => xs.map((x) => ({ id: x.cls, label: classLabel(x.cls), cents: x.cents, color: classColor(p, x.cls) }));
const pct = (r: number | null | undefined, d = 1) => (r == null ? "—" : formatPercentRatio(r, d));
const ratio = (r: number | null) => (r == null ? "—" : `${(r * 100).toFixed(r < 0.001 ? 3 : 2)}%`);

/** The proof behind an account's value, or the household total (no account). */
const accountTarget = (accountId: string | null, shownCents: number): ProofTarget => ({ descriptor: { report: "investments", ...(accountId ? { accountId } : {}) }, shownCents });
/** A position's proof; the balancing line ("whole account", "change since holdings") opens its account's. */
const positionTarget = (p: PositionRow): ProofTarget =>
  p.kind === "ACCOUNT" ? { descriptor: { report: "investments", accountId: p.accountId }, shownCents: p.valueCents } : { descriptor: { report: "investments", accountId: p.accountId, position: p.key, ...(p.lot ? { lot: p.lot } : {}) }, shownCents: p.valueCents };

export function InvestmentsClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [tab, setTab] = useTabParam(TABS, "overview");
  const [data, setData] = useState(() => cachedResponse<Data>("/api/investments"));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The LP view reads the funds' own notices, apart from the Book's report.
  const [funds, setFunds] = useState(() => cachedResponse<FundsPage>("/api/investments/funds"));

  const load = useCallback(() => {
    api
      .call<Data>("/api/investments")
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [api]);
  useEffect(() => {
    if (api.ready) load();
  }, [api, load]);
  useEffect(() => {
    if (!api.ready) return;
    api
      .call<FundsPage>("/api/investments/funds")
      .then(setFunds)
      .catch((e: Error) => setError(e.message));
  }, [api]);

  const save = async (settings: InvestmentSettings) => {
    setSaving(true);
    try {
      await api.call("/api/investments", { method: "PUT", json: settings });
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const r = data?.report;
  return (
    <>
      <Tabs
        tabs={[
          { id: "overview", label: "Allocation" },
          { id: "holdings", label: "Holdings", count: r?.unclassified.length || null },
          { id: "fees", label: "Fees" },
          { id: "gains", label: "Unrealized gains" },
          { id: "growth", label: "Money in vs growth" },
          ...(funds?.funds.length ? [{ id: "funds" as const, label: "Private funds", count: funds.funds.length }] : []),
        ]}
        value={tab}
        onChange={setTab}
      />
      <PageBody>
        <ApiSecretField api={api} />
        {error && <ErrorNote>{error}</ErrorNote>}
        {!data ? (
          api.ready && !error && <Loading label="Reading every account's holdings…" />
        ) : !r!.accounts.length ? (
          <EmptyState
            title="No investment statements yet"
            action={
              <Link href="/statements" className={btn.primary}>
                Import statements
              </Link>
            }
          />
        ) : (
          <>
            <BlockedNote what="every account's latest balance" blockers={r!.blockers} />
            {tab === "overview" && <Overview data={data} save={save} saving={saving} />}
            {tab === "holdings" && <Holdings data={data} save={save} saving={saving} />}
            {tab === "fees" && <Fees r={r!} returnRate={data!.returnRate} />}
            {tab === "gains" && <Gains r={r!} />}
            {tab === "growth" && <Growth r={r!} funds={funds} />}
            {tab === "funds" && (funds ? <PrivateFunds page={funds} /> : <Loading label="Reading the funds' notices and statements…" />)}
          </>
        )}
      </PageBody>
    </>
  );
}

// ---------------------------------------------------------------------------- allocation

function Overview({ data, save, saving }: { data: Data; save: (s: InvestmentSettings) => void; saving: boolean }) {
  const p = useChartPalette();
  const r = data.report;
  const classified = r.allocation.filter((c) => c.cls !== "UNCLASSIFIED");
  const stocks = classified.filter((c) => c.cls === "US_STOCK" || c.cls === "INTL_STOCK").reduce((s, c) => s + c.share, 0);
  const d = investmentsDerived(r);
  const dt = (figure: string) => derivedTarget("investments", d, figure);
  const unclassified = r.allocation.find((c) => c.cls === "UNCLASSIFIED");
  return (
    <>
      <StatGrid cols={4}>
        <StatCell label="Invested" value={usd0(r.totalCents)} proof={accountTarget(null, r.totalCents)}sub={`as of ${r.asOf}, as on Net worth`} />
        <StatCell proof={dt("stocks")} label="Stocks" value={pct(stocks)} sub="US + international, of all holdings" />
        <StatCell proof={dt("fund-costs")} label="Fund costs" value={usd0(r.fees.annualCents)} sub={`a year · ${ratio(r.fees.weightedRatio)} weighted expense ratio`} />
        <StatCell proof={dt("unrealized")} label="Unrealized gain (taxable)" value={usdDelta(r.gains.taxable.unrealizedCents)} tone={r.gains.taxable.unrealizedCents < 0 ? "neg" : "pos"} sub="where cost basis is on the statement" />
      </StatGrid>
      {unclassified && (
        <Callout tone="info" title={`${usd0(unclassified.cents)} isn't classified yet (${pct(unclassified.share)})`}>
          Securities the reference list doesn&apos;t know and accounts without a holdings list. Classify them on the Holdings tab; until then they&apos;re shown as unclassified, never guessed.
        </Callout>
      )}
      <Card title="Asset allocation" subtitle="Look-through: a target-date fund counts toward stocks and bonds by its typical glide path; funds by their reference classification or yours.">
        <ShareBar label="Asset allocation" segments={segmentsOf(p, r.allocation)} height={18} />
        <ShareLegend segments={segmentsOf(p, r.allocation)} />
      </Card>
      <Card title="By tax treatment" subtitle="Where each dollar sits decides how it's taxed: taxable accounts every year, tax-deferred on withdrawal, Roth and HSA (for medical costs) never.">
        <div className="flex flex-col gap-4">
          {r.byTreatment.map((t) => (
            <div key={t.treatment}>
              <div className="mb-1.5 flex items-baseline justify-between text-xs">
                <span className="font-medium text-fg">{t.treatment}</span>
                <span className="num text-muted">
                  <ProofValue proof={derivedTarget("investments", d, "treatment", t.treatment)}>{usd0(t.cents)}</ProofValue> · <ProofValue proof={derivedTarget("investments", d, "treatment-share", t.treatment)}>{pct(t.cents / r.totalCents)}</ProofValue>
                </span>
              </div>
              <ShareBar label={`${t.treatment} allocation`} segments={segmentsOf(p, t.allocation)} />
              <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted">
                {t.allocation.map((a) => (
                  <span key={a.cls}>
                    {classLabel(a.cls)} <ProofValue proof={derivedTarget("investments", d, "treatment-class", `${t.treatment}|${a.cls}`)}>{pct(a.share, 0)}</ProofValue>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>
      <TargetCard data={data} save={save} saving={saving} />
      <Card title="Largest positions" subtitle="The same security across accounts counts once. Above 10% of everything invested is flagged as concentrated.">
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Security</th>
                <th className={table.th}>Held in</th>
                <th className={table.thR}>Value</th>
                <th className={table.thR}>Share</th>
              </tr>
            </thead>
            <tbody>
              {r.concentration.map((c) => (
                <tr key={c.key} className={table.trHover}>
                  <td className={table.td}>
                    <span className="font-medium">{c.symbol ?? c.name}</span>
                    {c.symbol && <span className="ml-2 text-xs text-muted">{c.name}</span>}
                  </td>
                  <td className={`${table.td} text-xs text-muted`}>{c.accounts.join(", ")}</td>
                  <td className={table.tdR}>{usd0(c.cents)}</td>
                  <td className={table.tdR}>
                    {c.share > 0.1 && (
                      <Badge tone="warn" title="Over 10% of everything invested in one security">
                        concentrated
                      </Badge>
                    )}{" "}
                    {pct(c.share)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function TargetCard({ data, save, saving }: { data: Data; save: (s: InvestmentSettings) => void; saving: boolean }) {
  const [draft, setDraft] = useState<Weights>(data.settings.target ?? {});
  // A newly saved target resets the draft (adjusted during render, not in an effect).
  const [seen, setSeen] = useState(data.settings.target);
  if (data.settings.target !== seen) {
    setSeen(data.settings.target);
    setDraft(data.settings.target ?? {});
  }
  const sum = Object.values(draft).reduce((s, v) => s + (v ?? 0), 0);
  const drift = data.report.drift;
  return (
    <Card
      title="Target allocation"
      subtitle="Set the mix you're aiming for; drift shows how far each class is from it in dollars (of everything classified). Rebalancing inside tax-deferred and Roth accounts avoids realizing taxable gains."
      actions={
        <button type="button" className={btn.primary} disabled={saving || Math.abs(sum - 1) > 0.001} onClick={() => save({ ...data.settings, target: sum ? draft : null })}>
          {saving ? "Saving…" : "Save target"}
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {ASSET_CLASSES.map((c) => (
          <Field key={c.id} label={c.label}>
            <PercentInput value={draft[c.id] ?? 0} onChange={(v) => setDraft({ ...draft, [c.id]: v })} />
          </Field>
        ))}
      </div>
      <p className={`mt-2 text-xs ${Math.abs(sum - 1) > 0.001 ? "text-warn" : "text-muted"}`}>Total {pct(sum, 1)} {Math.abs(sum - 1) > 0.001 && "— must add up to 100%"}</p>
      {drift && (
        <div className={`${table.wrap} mt-3`}>
          <table className={table.table}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Class</th>
                <th className={table.thR}>Now</th>
                <th className={table.thR}>Target</th>
                <th className={table.thR}>To reach target</th>
              </tr>
            </thead>
            <tbody>
              {drift.map((d) => (
                <tr key={d.cls} className={table.tr}>
                  <td className={table.td}>{classLabel(d.cls)}</td>
                  <td className={table.tdR}>{pct(d.currentShare)}</td>
                  <td className={table.tdR}>{pct(d.targetShare)}</td>
                  <td className={`${table.tdR} ${Math.abs(d.deltaCents) > 0.05 * data.report.totalCents ? "font-semibold" : ""}`}>
                    {d.deltaCents === 0 ? "—" : `${d.deltaCents > 0 ? "buy" : "sell"} ${usd0(Math.abs(d.deltaCents))}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------- holdings

const STATUS: Record<string, { tone: "pos" | "warn" | "neg" | "neutral"; label: string; help: string }> = {
  TIES: { tone: "pos", label: "ties", help: "The positions listed on that day add up to the balance to the cent." },
  STALE: { tone: "warn", label: "older holdings", help: "No positions are listed on that day; they're from an earlier statement and the change since is one line." },
  MISMATCH: { tone: "neg", label: "doesn't tie", help: "The positions on file don't add up to the statement balance, so they aren't used." },
  NONE: { tone: "neutral", label: "no holdings", help: "This account's statements don't list positions; it counts as one line." },
};

function Holdings({ data, save, saving }: { data: Data; save: (s: InvestmentSettings) => void; saving: boolean }) {
  const r = data.report;
  const byAccount = useMemo(() => {
    const m = new Map<string, PositionRow[]>();
    for (const p of r.positions) m.set(p.accountId, [...(m.get(p.accountId) ?? []), p]);
    return m;
  }, [r.positions]);
  return (
    <>
      {r.unclassified.length > 0 && <Classify data={data} save={save} saving={saving} />}
      {r.accounts.map((a) => {
        const rows = byAccount.get(a.accountId) ?? [];
        const s = STATUS[a.status]!;
        return (
          <Card
            key={a.accountId}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {a.name}
                <Badge tone="neutral">{a.treatment}</Badge>
                <Badge tone={s.tone} title={s.help}>
                  {s.label}
                </Badge>
              </span>
            }
            subtitle={
              <>
                <ProofValue proof={accountTarget(a.accountId, a.valueCents)}>{usd0(a.valueCents)}</ProofValue>
                {` as of ${a.asOf}${a.holdingsAsOf && a.holdingsAsOf !== a.asOf ? ` · holdings as of ${a.holdingsAsOf}` : ""}${a.differenceCents ? ` · positions off by ${usdDelta(a.differenceCents)}` : ""}`}
              </>
            }
          >
            <div className={table.wrap}>
              <table className={`${table.table} min-w-[44rem]`}>
                <thead className={table.head}>
                  <tr>
                    <th className={table.th}>Security</th>
                    <th className={table.th}>Class</th>
                    <th className={table.thR}>Quantity</th>
                    <th className={table.thR}>Price</th>
                    <th className={table.thR}>Value</th>
                    <th className={table.thR}>Cost basis</th>
                    <th className={table.thR}>Gain</th>
                    <th className={table.thR}>Expense ratio</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p, i) => (
                    <tr key={i} className={table.trHover}>
                      <td className={table.td}>
                        <span className="font-medium">{p.symbol ?? p.name}</span>
                        {p.symbol && <div className="max-w-[22rem] truncate text-[11px] text-muted">{p.name}</div>}
                      </td>
                      <td className={`${table.td} text-xs`}>
                        {p.weights ? (
                          <span className="text-fg-2" title={p.source === "NAME_RULE" ? "From the fund's name" : p.source === "OWNER" ? "Your classification" : undefined}>
                            {weightsLabel(p.weights)}
                          </span>
                        ) : (
                          <Badge tone="warn">unclassified</Badge>
                        )}
                      </td>
                      <td className={table.tdR}>{p.quantity == null ? "—" : p.quantity.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
                      <td className={table.tdR}>{p.price == null ? "—" : `$${p.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`}</td>
                      <td className={`${table.tdR} font-medium`}><ProofValue proof={positionTarget(p)}>{usd0(p.valueCents)}</ProofValue></td>
                      <td className={`${table.tdR} text-muted`}>{p.costBasisCents == null ? "—" : usd0(p.costBasisCents)}</td>
                      <td className={`${table.tdR} ${p.unrealizedCents == null ? "" : p.unrealizedCents < 0 ? "text-neg" : "text-pos"}`}>{p.unrealizedCents == null ? "—" : usdDelta(p.unrealizedCents)}</td>
                      <td className={`${table.tdR} text-muted`}>{ratio(p.expenseRatio)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}
    </>
  );
}

const weightsLabel = (w: Weights) =>
  (Object.entries(w) as [AssetClass, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([c, v]) => (v === 1 ? classLabel(c) : `${classLabel(c)} ${Math.round(v * 100)}%`))
    .join(" · ");

function Classify({ data, save, saving }: { data: Data; save: (s: InvestmentSettings) => void; saving: boolean }) {
  const [picks, setPicks] = useState<Record<string, { cls: AssetClass | ""; er: number | null }>>({});
  const apply = () => {
    const securities = { ...data.settings.securities };
    for (const [key, v] of Object.entries(picks)) {
      if (!v.cls && v.er == null) continue;
      securities[key] = { weights: v.cls ? { [v.cls]: 1 } : null, expenseRatio: v.er };
    }
    save({ ...data.settings, securities });
    setPicks({});
  };
  return (
    <Card
      title="Classify"
      subtitle="Securities the reference list doesn't know, and accounts whose statements list no positions. Your answer applies wherever the security is held. (A blend like a balanced fund can be split later from the same list.)"
      actions={
        <button type="button" className={btn.primary} disabled={saving || !Object.values(picks).some((v) => v.cls || v.er != null)} onClick={apply}>
          {saving ? "Saving…" : "Save classifications"}
        </button>
      }
    >
      <div className={table.wrap}>
        <table className={table.table}>
          <thead className={table.head}>
            <tr>
              <th className={table.th}>Security</th>
              <th className={table.thR}>Value</th>
              <th className={table.th}>Asset class</th>
              <th className={table.th}>Expense ratio</th>
            </tr>
          </thead>
          <tbody>
            {data.report.unclassified.map((u) => {
              const v = picks[u.key] ?? { cls: "", er: null };
              return (
                <tr key={u.key} className={table.tr}>
                  <td className={table.td}>
                    <span className="font-medium">{u.symbol ?? u.name}</span>
                    {u.symbol && <span className="ml-2 text-xs text-muted">{u.name}</span>}
                  </td>
                  <td className={table.tdR}>{usd0(u.cents)}</td>
                  <td className={table.td}>
                    <select className={selectCls} value={v.cls} onChange={(e) => setPicks({ ...picks, [u.key]: { ...v, cls: e.target.value as AssetClass | "" } })}>
                      <option value="">—</option>
                      {ASSET_CLASSES.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className={table.td}>
                    <PercentInput className="w-24" value={v.er ?? 0} onChange={(x) => setPicks({ ...picks, [u.key]: { ...v, er: x || null } })} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------- fees

function Fees({ r, returnRate }: { r: InvestmentsReport; returnRate: number }) {
  const funds = r.positions.filter((p) => (p.annualFeeCents ?? 0) > 0).sort((a, b) => (b.annualFeeCents ?? 0) - (a.annualFeeCents ?? 0));
  const unknown = r.positions.filter((p) => p.expenseRatio == null && p.valueCents > 0).sort((a, b) => b.valueCents - a.valueCents);
  const d = investmentsDerived(r);
  const dt = (figure: string) => derivedTarget("investments", d, figure);
  return (
    <>
      <StatGrid cols={4}>
        <StatCell proof={dt("fund-costs")} label="Fund expenses" value={usd0(r.fees.annualCents)} sub="a year, at today's balances" />
        <StatCell proof={dt("weighted-ratio")} label="Weighted expense ratio" value={ratio(r.fees.weightedRatio)} sub={`over ${usd0(r.fees.knownCents)} with a known ratio`} />
        <StatCell proof={dt("account-fees")} label="Account fees, last 12 months" value={usd0(-r.fees.accountFeesLast12Cents)} sub="advisory, admin and plan fees the statements deducted" />
        <StatCell proof={dt("ratio-unknown")} label="Ratio unknown" value={usd0(r.fees.unknownCents)} tone={r.fees.unknownCents ? "warn" : "neutral"} sub="plan funds without a ticker, unlisted securities" />
      </StatGrid>
      <Card title="What each fund costs" subtitle="Expense ratios come out of a fund's returns, so they never appear on a statement as a fee. Ratios are from the statement where printed (Slavic's fund menu), else published figures for common funds, else yours.">
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Security</th>
                <th className={table.th}>Account</th>
                <th className={table.thR}>Value</th>
                <th className={table.thR}>Expense ratio</th>
                <th className={table.thR}>Per year</th>
                <th className={table.thR}>Over 20 years*</th>
              </tr>
            </thead>
            <tbody>
              {funds.map((p, i) => (
                <tr key={i} className={table.trHover}>
                  <td className={`${table.td} font-medium`}>{p.symbol ?? p.name}</td>
                  <td className={`${table.td} text-xs text-muted`}>{p.account}</td>
                  <td className={table.tdR}><ProofValue proof={positionTarget(p)}>{usd0(p.valueCents)}</ProofValue></td>
                  <td className={table.tdR}>{ratio(p.expenseRatio)}</td>
                  <td className={table.tdR}>{usd0(p.annualFeeCents)}</td>
                  <td className={`${table.tdR} text-muted`}>{usd0(costOver(p.valueCents, p.expenseRatio!, 20, returnRate))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-muted">* Ending value lost to the fee over 20 years at the Forecast&apos;s {ratio(returnRate)} return, with no new money: value × ((1 + return)²⁰ − (1 + return − ratio)²⁰).</p>
      </Card>
      {unknown.length > 0 && (
        <Card title="Expense ratio unknown" subtitle="Add the ratio from the fund's fact sheet or your plan's fee disclosure on the Holdings tab.">
          <ul className="flex flex-col gap-1 text-xs">
            {unknown.map((p, i) => (
              <li key={i} className="flex justify-between gap-4">
                <span>
                  <span className="font-medium">{p.symbol ?? p.name}</span> <span className="text-muted">· {p.account}</span>
                </span>
                <span className="num"><ProofValue proof={positionTarget(p)}>{usd0(p.valueCents)}</ProofValue></span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title="Fees by account" subtitle="What each account's statements deducted over the 12 months to the proven-through date.">
        <div className={table.wrap}>
          <table className={table.table}>
            <tbody>
              {r.accounts.map((a) => (
                <tr key={a.accountId} className={table.tr}>
                  <td className={table.td}>{a.name}</td>
                  <td className={`${table.td} text-xs text-muted`}>
                    {a.feesWindow.from} → {a.feesWindow.to}
                  </td>
                  <td className={table.tdR}>{a.feesLast12Cents ? usd0(-a.feesLast12Cents) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

/** What a fee takes from the ending value over `years`, at return `rate` (the forecast's). */
const costOver = (cents: number, er: number, years: number, rate: number) => Math.round(cents * ((1 + rate) ** years - (1 + rate - er) ** years));

// ---------------------------------------------------------------------------- gains

function Gains({ r }: { r: InvestmentsReport }) {
  const g = r.gains.taxable;
  const d = investmentsDerived(r);
  const dt = (figure: string) => derivedTarget("investments", d, figure);
  return (
    <>
      <StatGrid cols={4}>
        <StatCell proof={dt("unrealized")} label="Taxable unrealized" value={usdDelta(g.unrealizedCents)} tone={g.unrealizedCents < 0 ? "neg" : "pos"} sub={`on ${usd0(g.costKnownCents)} with known cost`} />
        <StatCell proof={dt("gains")} label="Gains" value={usd0(g.gainCents)} tone="pos" sub="positions above cost" />
        <StatCell proof={dt("losses")} label="Losses" value={usd0(g.lossCents)} tone={g.lossCents < 0 ? "neg" : "neutral"} sub="positions below cost" />
        <StatCell proof={dt("cost-unknown")} label="Cost unknown" value={usd0(g.costUnknownCents)} tone={g.costUnknownCents ? "warn" : "neutral"} sub="taxable positions without a printed basis" />
      </StatGrid>
      <Card
        title="Tax-loss harvesting candidates"
        subtitle="Taxable positions below cost. Selling realizes the loss: it offsets gains, then up to $3,000 of ordinary income a year, with the rest carried forward. Buying the same or a substantially identical security within 30 days before or after the sale (in any account, including IRAs) is a wash sale and disallows the loss. Holding period (short vs long term) isn't on the statement — check the lot details before selling. Not tax advice."
      >
        {r.gains.harvest.length === 0 ? (
          <p className="text-xs text-muted">No taxable position is below its cost basis.</p>
        ) : (
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.head}>
                <tr>
                  <th className={table.th}>Security</th>
                  <th className={table.th}>Account</th>
                  <th className={table.thR}>Value</th>
                  <th className={table.thR}>Cost basis</th>
                  <th className={table.thR}>Loss</th>
                  <th className={table.thR}>Below cost</th>
                </tr>
              </thead>
              <tbody>
                {r.gains.harvest.map((p, i) => (
                  <tr key={i} className={table.trHover}>
                    <td className={table.td}>
                      <span className="font-medium">{p.symbol ?? p.name}</span>
                      {p.kind === "OPTION" && <Badge tone="neutral">option</Badge>}
                    </td>
                    <td className={`${table.td} text-xs text-muted`}>{p.account}</td>
                    <td className={table.tdR}><ProofValue proof={positionTarget(p)}>{usd0(p.valueCents)}</ProofValue></td>
                    <td className={`${table.tdR} text-muted`}>{usd0(p.costBasisCents)}</td>
                    <td className={`${table.tdR} text-neg`}>{usdDelta(p.unrealizedCents)}</td>
                    <td className={table.tdR}>{p.costBasisCents ? pct(p.unrealizedCents! / Math.abs(p.costBasisCents)) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Every position with a cost basis" subtitle="Including tax-advantaged accounts, where gains are never taxed on sale (so harvesting doesn't apply).">
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Security</th>
                <th className={table.th}>Account</th>
                <th className={table.thR}>Value</th>
                <th className={table.thR}>Gain</th>
              </tr>
            </thead>
            <tbody>
              {r.positions
                .filter((p) => p.unrealizedCents != null)
                .sort((a, b) => b.unrealizedCents! - a.unrealizedCents!)
                .map((p, i) => (
                  <tr key={i} className={table.trHover}>
                    <td className={`${table.td} font-medium`}>{p.symbol ?? p.name}</td>
                    <td className={`${table.td} text-xs text-muted`}>
                      {p.account} · {p.treatment}
                    </td>
                    <td className={table.tdR}><ProofValue proof={positionTarget(p)}>{usd0(p.valueCents)}</ProofValue></td>
                    <td className={`${table.tdR} ${p.unrealizedCents! < 0 ? "text-neg" : "text-pos"}`}>{usdDelta(p.unrealizedCents)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------- growth

function Growth({ r, funds }: { r: InvestmentsReport; funds: FundsPage | null }) {
  const p = useChartPalette();
  const ui = chartChrome(p);
  const [which, setWhich] = useState<string>("all");
  // A private fund also gets its LP view: commitment, calls, distributions, unfunded. One
  // whose statements all fall after the proven-through date has no series yet, but its LP
  // view still opens here.
  const lpOnly = (funds?.funds ?? []).filter((f) => f.accountId && !r.growth.some((g) => g.accountId === f.accountId));
  const lp = which === "all" ? undefined : funds?.funds.find((f) => f.accountId === which);
  const found = r.growth.find((x) => growthKey(x.accountId) === which);
  const d = investmentsDerived(r);
  const picker = (
    <div className="flex flex-wrap items-center gap-2">
      <select data-audit-view="" className={selectCls} value={which} onChange={(e) => setWhich(e.target.value)} aria-label="Account">
        {r.growth.map((g) => (
          <option key={g.accountId ?? "all"} value={g.accountId ?? "all"}>
            {g.name}
          </option>
        ))}
        {lpOnly.map((f) => (
          <option key={f.accountId} value={f.accountId!}>
            {f.accountName ?? f.fund}
          </option>
        ))}
      </select>
    </div>
  );
  if (!found && lp) {
    return (
      <>
        {picker}
        <LpPanel fund={lp} />
        <p className="text-xs text-muted">Its money in vs value starts once the proven-through date reaches its first capital statement.</p>
      </>
    );
  }
  const s = found ?? r.growth[0]!;
  const last = s.points.at(-1);
  const blocked = s.points.filter((x) => x.blocked).length;
  const rows = s.points.map((x) => ({ label: x.label, invested: x.investedCents / 100, value: x.valueCents / 100 }));
  return (
    <>
      {picker}
      {lp && <LpPanel fund={lp} />}
      {last && (
        <StatGrid cols={3}>
          <StatCell proof={derivedTarget("investments", d, "growth-value", growthKey(s.accountId))} label="Value" value={usd0(last.valueCents)} sub={`end of ${last.label}`} />
          <StatCell proof={derivedTarget("investments", d, "growth-money-in", growthKey(s.accountId))} label="Money in" value={usd0(last.investedCents)} sub="deposits, rollovers and opening balances, net of withdrawals" />
          <StatCell proof={derivedTarget("investments", d, "growth-growth", growthKey(s.accountId))} label="Growth" value={usdDelta(last.valueCents - last.investedCents)} tone={last.valueCents < last.investedCents ? "neg" : "pos"} sub="market change net of fees" />
        </StatGrid>
      )}
      {blocked > 0 && (
        <Callout tone="warn" title={`${blocked} quarter${blocked === 1 ? "" : "s"} depend on missing or failing data`}>
          Their money-in and growth split can&apos;t be proven yet; see Integrity for what to fetch.
        </Callout>
      )}
      <Card title="Money in vs value" subtitle="Quarter-ends through the proven-through date. The gap between the lines is what the market added (or took away), after fees.">
        <div className="h-[300px] w-full min-w-0">
          <RechartsResponsive>
            <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid {...ui.grid} />
              <XAxis dataKey="label" {...ui.xAxis} minTickGap={24} />
              <YAxis {...ui.yAxis} tickFormatter={axisUsd} />
              <Tooltip {...ui.tooltip} formatter={(v, n) => [usd0(Math.round(Number(v) * 100)), n === "value" ? "Value" : "Money in"]} />
              <Legend {...ui.legend} formatter={(v) => (v === "value" ? "Value" : "Money in")} />
              <Line type="monotone" dataKey="invested" stroke={p.principal} strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="value" stroke={p.growth} strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </RechartsResponsive>
        </div>
      </Card>
      <Card title="Quarter by quarter">
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Quarter</th>
                <th className={table.thR}>Money in</th>
                <th className={table.thR}>Value</th>
                <th className={table.thR}>Growth to date</th>
              </tr>
            </thead>
            <tbody>
              {[...s.points].reverse().map((x) => (
                <tr key={x.label} className={table.tr}>
                  <td className={table.td}>
                    {x.label} {x.blocked && <Badge tone="warn">unproven</Badge>}
                  </td>
                  <td className={table.tdR}>
                    <ProofValue proof={derivedTarget("investments", d, "growth-point", cellKey(growthKey(s.accountId), x.end, "money-in"))}>{usd0(x.investedCents)}</ProofValue>
                  </td>
                  <td className={table.tdR}>
                    <ProofValue proof={derivedTarget("investments", d, "growth-point", cellKey(growthKey(s.accountId), x.end, "value"))}>{usd0(x.valueCents)}</ProofValue>
                  </td>
                  <td className={`${table.tdR} ${x.valueCents < x.investedCents ? "text-neg" : ""}`}>
                    <ProofValue proof={derivedTarget("investments", d, "growth-point", cellKey(growthKey(s.accountId), x.end, "growth"))}>{usdDelta(x.valueCents - x.investedCents)}</ProofValue>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="text-xs text-muted">
        Time-weighted returns (which ignore when money went in) are on{" "}
        <Link href="/net-worth?tab=returns" className={btn.link}>
          Net worth › Investment returns
        </Link>
        .
      </p>
    </>
  );
}
