"use client";

import { BlockedValue } from "@/components/ledger/Blocked";
import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { btn, Card, Drawer, ErrorNote, Loading, PageBody, usePersistentState } from "@/components/ui/kit";
import { notify } from "@/components/ui/Feedback";
import type { Mark } from "@/lib/marks";
import { Desk } from "@/components/ui/Panel";
import { compositeOf } from "@/components/ui/proof/context";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { DASHBOARD_KEYS } from "@/components/shell/shortcuts";
import type { Briefing, BriefingDue } from "@/lib/dashboard/briefing";
import { formatPercentRatio, NA, usd0, usdCompact, usdDelta } from "@/lib/formatMoney";
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Range } from "./dashboard/charts";
import { BalancePanel, BridgePanel, CashPanel, day, DuePanel, FeedPanel, type FeedDecide, MoversPanel, NetWorthPanel, PlanPanel, PortfolioPanel, proofOf, tone, type Summary } from "./dashboard/panels";

const SUMMARY = "/api/dashboard/home-summary";
const BRIEFING = "/api/dashboard/briefing";
const UPCOMING = "/api/dashboard/upcoming";
const FEED = "/api/dashboard/feed";
type Upcoming = { due: BriefingDue[] };
const RANGE_KEYS: Record<string, Range> = { "1": "6m", "2": "12m", "3": "all" };

/**
 * The Dashboard: one screen that says where things stand, what moved, what's due and what
 * stands out, each panel leading to the page behind it. Figures come from the reports those
 * pages read, with their proofs (lib/dashboard/homeSummary.ts and briefing.ts).
 */
export function HomeClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [data, setData] = useState(() => cachedResponse<Summary>(SUMMARY));
  const [brief, setBrief] = useState(() => cachedResponse<Briefing>(BRIEFING));
  // Card credits and policy dates: read apart from the briefing, whose other panels never wait for them.
  const [upcoming, setUpcoming] = useState(() => cachedResponse<Upcoming>(UPCOMING));
  // The owner's decisions on the feed: read beside the briefing, never part of it (saving one rebuilds nothing).
  const [marks, setMarks] = useState<Mark[] | null>(() => cachedResponse<{ marks: Mark[] }>(FEED)?.marks ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api.ready) return;
    const failed = (e: Error) => setError(e.message);
    api.call<Summary>(SUMMARY).then(setData).catch(failed);
    api.call<Briefing>(BRIEFING).then(setBrief).catch(failed);
    api.call<Upcoming>(UPCOMING).then(setUpcoming).catch(failed);
    api.call<{ marks: Mark[] }>(FEED).then((r) => setMarks(r.marks)).catch(failed);
  }, [api]);

  const decide = useMemo<FeedDecide | null>(() => {
    if (!api.ready || marks == null) return null;
    const send = (json: Record<string, unknown>) => api.call<{ marks: Mark[] }>(FEED, { method: "POST", json }).then((r) => setMarks(r.marks));
    return (item, how) => {
      const undo = () => send({ op: "undo", id: item.id });
      const words = how.op === "dismiss" ? "Dismissed until it changes" : how.op === "remind" ? `Back ${how.words}` : "Restored";
      void send(how.op === "undo" ? { op: "undo", id: item.id } : { op: how.op, id: item.id, says: item.says, ...(how.op === "remind" ? { until: how.until } : {}) })
        .then(() => notify(words, how.op === "undo" ? { tone: "info" } : { tone: "info", undo }))
        .catch((e: Error) => notify(e.message, { tone: "bad" }));
    };
  }, [api, marks]);

  if (data?.hasStatements)
    return (
      <>
        <h1 className="sr-only">Dashboard</h1>
        {error && (
          <div className="p-2">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}
        <Terminal d={data} b={brief} upcoming={upcoming?.due ?? NONE} marks={marks} decide={decide} />
      </>
    );
  return (
    <PageBody>
      <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
      <ApiSecretField api={api} />
      {error && <ErrorNote>{error}</ErrorNote>}
      {!data ? (
        api.ready && !error ? <Loading label="Reading the ledger…" /> : null
      ) : (
        <Card title="Welcome">
          <p className="text-sm text-muted">No statements on file yet.</p>
          <Link href="/statements" className={`${btn.primary} mt-3`}>
            Import your first statements
          </Link>
        </Card>
      )}
    </PageBody>
  );
}

const NONE: BriefingDue[] = [];

/** The calendar's dates and the rest, by date: what's done last. */
const byDate = (a: BriefingDue, b: BriefingDue) => Number(a.done) - Number(b.done) || a.date.localeCompare(b.date);

function Terminal({ d, b, upcoming, marks, decide }: { d: Summary; b: Briefing | null; upcoming: BriefingDue[]; marks: Mark[] | null; decide: FeedDecide | null }) {
  const [view, setView] = usePersistentState<{ range: Range; average: boolean }>("pf-desk-view", () => ({ range: "all", average: false }));
  const [keys, setKeys] = useState(false);
  const due = useMemo(() => [...(b?.due ?? NONE), ...upcoming].sort(byDate), [b, upcoming]);
  // ? lists the keys, from anywhere on the page but a field being typed in.
  useEffect(() => {
    const onHelp = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey || (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable))) return;
      e.preventDefault();
      setKeys((on) => !on);
    };
    window.addEventListener("keydown", onHelp);
    return () => window.removeEventListener("keydown", onHelp);
  }, []);
  const onKey = (key: string) => {
    if (RANGE_KEYS[key]) setView((v) => ({ ...v, range: RANGE_KEYS[key]! }));
    else if (key === "m") setView((v) => ({ ...v, average: !v.average }));
    else return false;
    return true;
  };
  return (
    <div className="xl:flex xl:h-full xl:min-h-[42rem] xl:flex-col">
      <Tape d={d} b={b} due={due} />
      <Desk onKey={onKey}>
        <NetWorthPanel nw={d.netWorth} events={b?.events ?? NO_EVENTS} range={view.range} setRange={(range) => setView((v) => ({ ...v, range }))} average={view.average} setAverage={(average) => setView((v) => ({ ...v, average }))} />
        {b ? (
          <>
            <BridgePanel change={b.change} />
            <DuePanel due={due} today={b.today} />
          </>
        ) : (
          <Waiting span="xl:col-span-6" />
        )}
        <MoversPanel cf={d.cashFlow} trends={b?.trends ?? null} />
        <CashPanel cf={d.cashFlow} />
        {b ? <PortfolioPanel p={b.portfolio} /> : <Waiting span="xl:col-span-4" />}
        <BalancePanel nw={d.netWorth} />
        {b ? (
          <>
            <PlanPanel goals={b.goals} fire={b.fire} />
            <FeedPanel feed={b.feed} marks={marks} today={b.today} decide={decide} />
          </>
        ) : (
          <Waiting span="xl:col-span-9" />
        )}
      </Desk>
      <Status d={d} onKeys={() => setKeys(true)} />
      <Drawer open={keys} onClose={() => setKeys(false)} title="Keys on the Dashboard" subtitle="Every page's keys are on Help." width="24rem">
        <dl className="divide-y divide-line text-[13px]">
          {DASHBOARD_KEYS.map(([k, what]) => (
            <div key={k} className="flex items-baseline gap-4 py-2">
              <dt className="w-28 shrink-0">
                <kbd className="font-mono text-xs text-accent">{k}</kbd>
              </dt>
              <dd className="text-fg-2">{what}</dd>
            </div>
          ))}
        </dl>
      </Drawer>
    </div>
  );
}

const NO_EVENTS: Briefing["events"] = [];

/** A panel's place while its data is on the way, so nothing jumps when it arrives. */
function Waiting({ span }: { span: string }) {
  return (
    <div className={`bg-surface p-2 ${span}`}>
      <Loading label="Building the panels…" />
    </div>
  );
}

function Cell({ label, children, cls = "" }: { label: string; children: ReactNode; cls?: string }) {
  return (
    <div className="flex shrink-0 items-baseline gap-1.5 border-r border-line px-3 py-1">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className={`num font-semibold ${cls || "text-fg"}`}>{children}</dd>
    </div>
  );
}

/** The headline figures on one line. */
function Tape({ d, b, due }: { d: Summary; b: Briefing | null; due: BriefingDue[] }) {
  const nw = d.netWorth;
  const l12 = d.cashFlow.last12;
  const next = b ? due.find((x) => !x.done && x.date > b.today) : undefined;
  const change = (c: Summary["netWorth"]["change"]["month"]) => (c.cents == null ? <BlockedValue blockers={c.blockers} /> : <ProofValue proof={proofOf("proof" in c ? c.proof : null, c.cents)}>{usdDelta(c.cents)}</ProofValue>);
  return (
    <dl className="app-scroll flex min-h-[1.8rem] shrink-0 items-center overflow-x-auto whitespace-nowrap bg-surface text-[12.5px]" aria-label="Headline figures">
      <Cell label="NET WORTH">{nw.totalCents == null ? <BlockedValue blockers={nw.blockers} /> : <ProofValue proof={proofOf(nw.proofs?.total, nw.totalCents)} quality={nw.quality}>{usd0(nw.totalCents)}</ProofValue>}</Cell>
      <Cell label="1M" cls={tone(nw.change.month.cents)}>
        {change(nw.change.month)}
      </Cell>
      <Cell label="YTD" cls={tone(nw.change.ytd.cents)}>
        {change(nw.change.ytd)}
      </Cell>
      <Cell label="12M" cls={tone(nw.change.year.cents)}>
        {change(nw.change.year)}
      </Cell>
      <Cell label="SAVING" cls={tone(nw.drivers?.principalCents)}>
        {nw.drivers ? <ProofValue proof={proofOf(nw.drivers.proofs.principal, nw.drivers.principalCents)}>{usdDelta(nw.drivers.principalCents)}</ProofValue> : <BlockedValue blockers={nw.driversBlockers} />}
      </Cell>
      <Cell label="MARKETS" cls={tone(nw.drivers?.growthCents)}>
        {nw.drivers ? <ProofValue proof={proofOf(nw.drivers.proofs.growth, nw.drivers.growthCents)}>{usdDelta(nw.drivers.growthCents)}</ProofValue> : <BlockedValue blockers={nw.driversBlockers} />}
      </Cell>
      <Cell label="LIQUID">{nw.liquidCents == null ? <BlockedValue blockers={nw.blockers} /> : <ProofValue proof={proofOf(nw.proofs?.liquid, nw.liquidCents)}>{usdCompact(nw.liquidCents)}</ProofValue>}</Cell>
      <Cell label="DEBTS" cls={nw.debtsCents ? "text-neg" : ""}>
        {nw.debtsCents == null ? <BlockedValue blockers={nw.blockers} /> : <ProofValue proof={proofOf(nw.proofs?.debts, nw.debtsCents)}>{usdCompact(nw.debtsCents)}</ProofValue>}
      </Cell>
      {l12 && (
        <>
          <Cell label="INCOME 12M">
            <ProofValue proof={proofOf(l12.proofs.income, l12.incomeCents)}>{usdCompact(l12.incomeCents)}</ProofValue>
          </Cell>
          <Cell label="SPENT 12M">
            <ProofValue proof={proofOf(l12.proofs.spending, l12.spendingCents)}>{usdCompact(l12.spendingCents)}</ProofValue>
          </Cell>
          <Cell label="KEPT" cls={tone(l12.netCents)}>
            <ProofValue proof={proofOf(l12.proofs.net, l12.netCents)}>{usdCompact(l12.netCents)}</ProofValue>
          </Cell>
          <Cell label="RATE" cls={tone(l12.netCents)}>
            {l12.savingsRate == null ? NA : <ProofValue proof={compositeOf("share", [proofOf(l12.proofs.net, l12.netCents), proofOf(l12.proofs.income, l12.incomeCents)], { ratio: l12.savingsRate })}>{formatPercentRatio(l12.savingsRate, 0)}</ProofValue>}
          </Cell>
        </>
      )}
      {next && (
        <Cell label="NEXT" cls="text-warn">
          <Link href={next.href} className="hover:underline">
            {day(next.date)}
          </Link>
        </Cell>
      )}
    </dl>
  );
}

/** One line: the dates everything is proven through, what needs you, and the keys. */
function Status({ d, onKeys }: { d: Summary; onKeys: () => void }) {
  const i = d.integrity;
  const needs: { text: string; href: string; cls: string }[] = [
    ...(i.failing ? [{ text: `${i.failing} check${i.failing === 1 ? "" : "s"} failing`, href: "/statements?tab=issues", cls: "text-neg" }] : []),
    ...(i.toReview ? [{ text: `${i.toReview} exception${i.toReview === 1 ? "" : "s"} to review`, href: "/statements?tab=issues", cls: "text-info" }] : []),
    ...(d.attention.needsReview ? [{ text: `${d.attention.needsReview.toLocaleString()} to categorize`, href: "/statements?tab=categorize", cls: "text-warn" }] : []),
  ];
  return (
    <footer className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-0.5 bg-surface px-3 py-1 text-[11px] text-faint">
      <span>
        Proven through <span className="text-fg-2">{day(d.netWorth.asOf)}</span>
      </span>
      <span>
        {i.checksPassing} of {i.checksTotal} checks passing
      </span>
      {needs.length ? (
        needs.map((n) => (
          <Link key={n.text} href={n.href} className={`font-semibold hover:underline ${n.cls}`}>
            {n.text}
          </Link>
        ))
      ) : (
        <span className="text-pos">Nothing needs you</span>
      )}
      <button type="button" onClick={onKeys} className="ml-auto hidden outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus lg:inline">
        ← → panel · ↑ ↓ row · Enter open · 1 2 3 range · M average · / command · ? keys
      </button>
    </footer>
  );
}
