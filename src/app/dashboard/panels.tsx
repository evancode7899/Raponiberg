"use client";

import { Sparkline } from "@/components/charts/Sparkline";
import { BlockedValue } from "@/components/ledger/Blocked";
import { groupColor, useChartPalette } from "@/components/shell/chartPalette";
import { NotFigure, Segmented, WhatIf } from "@/components/ui/kit";
import { grid, Panel } from "@/components/ui/Panel";
import { compositeOf, type ProofRef } from "@/components/ui/proof/context";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { unswept } from "@/lib/book/proof/clearance";
import type { ProofDescriptor } from "@/lib/book/proof";
import type { Briefing, BriefingDue } from "@/lib/dashboard/briefing";
import type { HomeSummary } from "@/lib/dashboard/homeSummary";
import { formatDisplayDateFromYmd } from "@/lib/displayTime";
import { formatPercentRatio, NA, usd0, usdCompact, usdDelta } from "@/lib/formatMoney";
import Link from "next/link";
import { CashBars, cashCap, NetWorthLine, pastScale, type Range } from "./charts";

export type Summary = HomeSummary;

/** A figure's proof, as the page shows it (cents before any per-month split). */
export const proofOf = (descriptor: ProofDescriptor | null | undefined, shownCents: number | null | undefined): ProofRef =>
  descriptor && shownCents != null ? { descriptor, shownCents } : unswept("the Dashboard has no recipe for this figure");

export const day = (iso: string | null | undefined) => (iso ? formatDisplayDateFromYmd(iso) : NA);
const short = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "2-digit" });
const daysTo = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
export const tone = (c: number | null | undefined) => (!c ? "text-muted" : c > 0 ? "text-pos" : "text-neg");

/** A row's own link, pressed by Enter on the row. */
function Open({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link data-desk-open="" tabIndex={-1} href={href} className="outline-none hover:text-accent hover:underline">
      {children}
    </Link>
  );
}

// ------------------------------------------------------------------ net worth

export function NetWorthPanel({ nw, events, range, setRange, average, setAverage }: { nw: Summary["netWorth"]; events: Briefing["events"]; range: Range; setRange: (r: Range) => void; average: boolean; setAverage: (on: boolean) => void }) {
  return (
    <Panel
      code="NW"
      title="Net worth"
      href="/net-worth"
      note={`as of ${day(nw.asOf)}`}
      className="md:col-span-2 xl:col-span-6"
      controls={
        <span className="flex items-center gap-1.5">
          <Segmented
            view
            size="xs"
            ariaLabel="Months shown"
            options={[
              { value: "6m", label: "6M", title: "Key 1" },
              { value: "12m", label: "12M", title: "Key 2" },
              { value: "all", label: "All", title: "Key 3" },
            ]}
            value={range}
            onChange={setRange}
          />
          <button type="button" aria-pressed={average} title="3-month average (key M)" onClick={() => setAverage(!average)} className={`px-1.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-focus ${average ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"}`}>
            AVG
          </button>
        </span>
      }
    >
      <NetWorthLine series={nw.series} events={events} range={range} average={average} />
    </Panel>
  );
}

// ------------------------------------------------------------------ the month's bridge

export function BridgePanel({ change }: { change: Briefing["change"] }) {
  if (!change)
    return (
      <Panel code="CHG" title="What moved it" href="/net-worth?tab=changes" className="xl:col-span-3">
        <p className="p-2 text-xs text-muted">No month that both net worth and cash flow can prove yet.</p>
      </Panel>
    );
  const ends = change.steps.flatMap((s) => [s.fromCents, s.toCents]);
  const lo = Math.min(0, ...ends);
  const hi = Math.max(0, ...ends);
  const pct = (v: number) => ((v - lo) / (hi - lo || 1)) * 100;
  return (
    <Panel code="CHG" title={`What moved it · ${change.label}`} href="/net-worth?tab=changes" note="vs 12-mo average" className="xl:col-span-3">
      <table className={grid.table}>
        <thead>
          <tr>
            <th className={grid.th}>Step</th>
            <th className={`${grid.th} w-[24%]`} aria-label="Waterfall" />
            <th className={grid.th}>Amount</th>
            <th className={grid.th}>Average</th>
          </tr>
        </thead>
        <tbody>
          <tr data-desk-row="" tabIndex={-1} className={grid.row}>
            <td className={`${grid.td} text-muted`}>
              <Open href="/net-worth?tab=changes">Opening</Open>
            </td>
            <td className={grid.td} />
            <td className={grid.td}>
              <ProofValue proof={change.proofs.opening}>{usd0(change.openingCents)}</ProofValue>
            </td>
            <td className={grid.td} />
          </tr>
          {change.steps.map((s) => {
            const up = s.toCents >= s.fromCents;
            const a = pct(Math.min(s.fromCents, s.toCents));
            const b = pct(Math.max(s.fromCents, s.toCents));
            return (
              <tr key={s.key} data-desk-row="" tabIndex={-1} className={grid.row}>
                <td className={grid.td} title={s.note}>
                  <Open href="/net-worth?tab=changes">{s.label}</Open>
                </td>
                <td className={grid.td}>
                  <span aria-hidden className="relative block h-2.5 bg-surface-3">
                    <span className={`absolute inset-y-0 ${up ? "bg-pos" : "bg-neg"}`} style={{ left: `${a}%`, width: `${Math.max(1, b - a)}%` }} />
                    <span className="absolute -inset-y-0.5 w-px bg-fg-2" style={{ left: `${pct(0)}%` }} />
                  </span>
                </td>
                <td className={`${grid.td} font-medium ${up ? "text-pos" : "text-neg"}`}>
                  <ProofValue proof={s.proof}>{usd0(s.cents)}</ProofValue>
                </td>
                <td className={`${grid.td} text-muted`}>{s.typicalCents == null ? NA : <ProofValue proof={s.typicalProof}>{usd0(s.typicalCents)}</ProofValue>}</td>
              </tr>
            );
          })}
          <tr data-desk-row="" tabIndex={-1} className={`${grid.row} font-semibold`}>
            <td className={grid.td}>
              <Open href="/net-worth?tab=changes">Closing</Open>
            </td>
            <td className={`${grid.td} ${tone(change.changeCents)}`}>
              <ProofValue proof={change.proofs.change}>{usdDelta(change.changeCents)}</ProofValue>
            </td>
            <td className={grid.td}>
              <ProofValue proof={change.proofs.closing}>{usd0(change.closingCents)}</ProofValue>
            </td>
            <td className={grid.td} />
          </tr>
        </tbody>
      </table>
    </Panel>
  );
}

// ------------------------------------------------------------------ what's due

export function DuePanel({ due, today }: { due: BriefingDue[]; today: string }) {
  const open = due.filter((d) => !d.done);
  return (
    <Panel code="DUE" title="Next up" href="/calendar" note={`${open.length} open`} className="xl:col-span-3">
      <table className={grid.table}>
        <thead>
          <tr>
            <th className={grid.th}>Action</th>
            <th className={grid.th}>Due</th>
            <th className={grid.th}>Days</th>
            <th className={grid.th}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {due.map((d) => {
            const left = daysTo(today, d.date);
            const back = d.kind === "file" && (d.cents ?? 0) < 0;
            return (
              <tr key={d.id} data-desk-row="" tabIndex={-1} title={d.detail} className={`${grid.row} ${d.done ? "text-faint" : ""}`}>
                <td className={grid.name}>
                  <Open href={d.href}>{d.done ? `✓ ${d.title}` : d.title}</Open>
                </td>
                <td className={grid.td}>{short(d.date)}</td>
                <td className={`${grid.td} ${!d.done && left <= 30 ? "font-semibold text-warn" : "text-muted"}`}>{left <= 0 ? "now" : left}</td>
                <td className={`${grid.td} ${back || d.kind === "vest" || d.kind === "credit" ? "text-pos" : ""}`}>
                  {d.dateOnly ? null : d.cents == null ? (
                    NA
                  ) : (
                    <>
                      <ProofValue proof={d.proof} drawn={{ zeroWithin: 0 }}>
                        {usd0(back ? -d.cents : d.cents)}
                      </ProofValue>
                      {d.perPaycheck && <span className="text-faint">/pay</span>}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}

// ------------------------------------------------------------------ spending movers

export function MoversPanel({ cf, trends }: { cf: Summary["cashFlow"]; trends: Briefing["trends"] | null }) {
  const p = useChartPalette();
  const lm = cf.lastMonth;
  if (!lm || !cf.categories.length)
    return (
      <Panel code="CAT" title="Spending movers" href="/cash-flow?tab=spending" className="xl:col-span-4">
        <p className="p-2 text-xs text-muted">No proven month to compare yet.</p>
      </Panel>
    );
  const rows = [...cf.categories].sort((a, b) => Math.abs(b.lastMonthCents - b.avgCents) - Math.abs(a.lastMonthCents - a.avgCents));
  return (
    <Panel code="CAT" title="Spending movers" href="/cash-flow?tab=spending" note={`${lm.label} vs 12-mo average`} className="xl:col-span-4">
      <table className={grid.table}>
        <thead>
          <tr>
            <th className={grid.th}>Category</th>
            <th className={grid.th}>{lm.label.split(" ")[0]}</th>
            <th className={grid.th}>Average</th>
            <th className={grid.th}>Change</th>
            <th className={grid.th}>12 mo</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const over = c.lastMonthCents - c.avgCents;
            const heat = Math.round(Math.min(45, (Math.abs(over) / Math.max(1, c.avgCents)) * 40));
            const avg: ProofRef = c.totalProof && c.totalCents ? { descriptor: c.totalProof, shownCents: c.totalCents, perMonths: c.months } : unswept("no months to average");
            return (
              <tr key={c.category} data-desk-row="" tabIndex={-1} className={grid.row}>
                <td className={grid.name}>
                  <Open href={`/statements?tab=transactions&category=${encodeURIComponent(c.category)}&from=${lm.start}&to=${lm.end}`}>{c.category}</Open>
                </td>
                <td className={grid.td}>
                  <ProofValue proof={proofOf(c.proof, c.lastMonthCents)}>{usd0(c.lastMonthCents)}</ProofValue>
                </td>
                <td className={`${grid.td} text-muted`}>
                  <ProofValue proof={avg}>{usd0(c.avgCents)}</ProofValue>
                </td>
                <td className={`${grid.td} font-medium`} style={Math.abs(over) < 2500 ? undefined : { background: `color-mix(in srgb, var(${over > 0 ? "--neg" : "--pos"}) ${heat}%, transparent)` }}>
                  {Math.abs(over) < 100 || !c.totalCents ? "—" : <ProofValue proof={compositeOf("diff", [proofOf(c.proof, c.lastMonthCents), proofOf(c.totalProof, c.totalCents)], { cents: c.lastMonthCents - c.totalCents / c.months }, [1, c.months])}>{usdDelta(over)}</ProofValue>}
                </td>
                <td className={grid.td}>{trends?.[c.category] && <Sparkline values={trends[c.category]!} color={p.series[0]!} width={64} height={14} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}

// ------------------------------------------------------------------ cash flow

export function CashPanel({ cf }: { cf: Summary["cashFlow"] }) {
  const months = cf.months.map((m) => ({ label: m.label, income: m.incomeCents == null ? null : m.incomeCents / 100, spending: m.spendingCents == null ? null : m.spendingCents / 100 }));
  const cap = cashCap(months);
  const over = pastScale(cf.months, cap);
  return (
    <Panel code="CF" title="Cash flow" href="/cash-flow" note="12 months" className="xl:col-span-4" bodyClassName="flex flex-col">
      <div className="relative min-h-[9rem] flex-1">
        <div className="absolute inset-0 p-1">
          <CashBars months={months} cap={cap} />
        </div>
      </div>
      {over.length > 0 && (
        <p className="shrink-0 border-t border-line px-2 py-1 text-[11px] text-muted">
          Off the scale:{" "}
          {over.map((o, i) => (
            <span key={`${o.m.start}${o.what}`}>
              {i > 0 && " · "}
              {o.m.label} {o.what}{" "}
              <span className="text-fg">
                <ProofValue proof={{ descriptor: { report: "cash-flow", metric: o.what, granularity: "month", start: o.m.start, end: o.m.end }, shownCents: o.cents }}>{usdCompact(o.cents)}</ProofValue>
              </span>
            </span>
          ))}
        </p>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ portfolio

export function PortfolioPanel({ p: port }: { p: Briefing["portfolio"] }) {
  const ret = port.returns;
  return (
    <Panel code="INV" title="Portfolio" href="/investments" note={`as of ${day(port.asOf)}`} className="xl:col-span-4" bodyClassName="flex flex-col">
      {ret && (
        <dl className="flex shrink-0 flex-wrap gap-x-4 border-b border-line px-2 py-1 text-[11.5px] text-muted" title="Time-weighted and net of fees, from Net worth › Investment returns.">
          {ret.month && (
            <div className="flex gap-1.5">
              <dt>Return {ret.month.label}</dt>
              <dd className={`num font-semibold ${ret.month.ratio < 0 ? "text-neg" : "text-pos"}`}>
                <ProofValue proof={ret.month.proof}>{formatPercentRatio(ret.month.ratio, 1)}</ProofValue>
              </dd>
            </div>
          )}
          <div className="flex gap-1.5">
            <dt>since {day(ret.from)}</dt>
            <dd className={`num font-semibold ${ret.total < 0 ? "text-neg" : "text-pos"}`}>
              <ProofValue proof={ret.totalProof}>{formatPercentRatio(ret.total, 1)}</ProofValue>
            </dd>
          </div>
          {ret.annualized != null && (
            <div className="flex gap-1.5">
              <dt>a year</dt>
              <dd className="num font-semibold text-fg">
                <ProofValue proof={ret.annualizedProof}>{formatPercentRatio(ret.annualized, 2)}</ProofValue>
              </dd>
            </div>
          )}
        </dl>
      )}
      <table className={grid.table}>
        <thead>
          <tr>
            <th className={grid.th}>Holding</th>
            <th className={grid.th}>Value</th>
            <th className={grid.th}>Weight</th>
            {port.hasTarget && (
              <th className={grid.th} title="What to buy (or sell) to reach your target allocation.">
                To target
              </th>
            )}
            <th className={grid.th}>Unrealized</th>
          </tr>
        </thead>
        <tbody>
          {port.classes.map((c) => (
            <tr key={c.cls} data-desk-row="" tabIndex={-1} className={`${grid.row} text-fg`}>
              <td className={grid.name}>
                <Open href="/investments">
                  <span className="text-muted">▪ </span>
                  {c.label}
                </Open>
              </td>
              <td className={grid.td}>
                <ProofValue proof={c.proof}>{usd0(c.cents)}</ProofValue>
              </td>
              <td className={grid.td}>
                <ProofValue proof={c.shareProof}>{formatPercentRatio(c.share, 1)}</ProofValue>
              </td>
              {port.hasTarget && <td className={grid.td}>{c.driftCents == null ? <span className="text-faint">{NA}</span> : c.driftCents === 0 ? "—" : <ProofValue proof={c.driftProof}>{usdDelta(c.driftCents)}</ProofValue>}</td>}
              <td className={grid.td} />
            </tr>
          ))}
          {port.holdings.map((h) => (
            <tr key={h.key} data-desk-row="" tabIndex={-1} className={grid.row}>
              <td className={`${grid.name} !pl-4`}>
                <Open href="/investments?tab=holdings">
                  <span title={h.accounts.join(", ")}>{h.name}</span>
                </Open>
              </td>
              <td className={grid.td}>
                <ProofValue proof={h.proof}>{usd0(h.cents)}</ProofValue>
              </td>
              <td className={grid.td} />
              {port.hasTarget && <td className={grid.td} />}
              <td className={`${grid.td} ${tone(h.gainCents)}`}>{h.gainCents == null ? <span className="text-faint">{NA}</span> : <ProofValue proof={h.gainProof}>{usdDelta(h.gainCents)}</ProofValue>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

// ------------------------------------------------------------------ balance sheet

export function BalancePanel({ nw }: { nw: Summary["netWorth"] }) {
  const p = useChartPalette();
  return (
    <Panel code="BAL" title="Balance sheet" href="/net-worth" note={nw.asOf ? `as of ${day(nw.asOf)}` : undefined} className="xl:col-span-3">
      <table className={grid.table}>
        <thead>
          <tr>
            <th className={grid.th}>Group</th>
            <th className={grid.th}>Balance</th>
            <th className={grid.th}>Of assets</th>
          </tr>
        </thead>
        <tbody>
          {nw.groups.map((g) => (
            <tr key={g.group} data-desk-row="" tabIndex={-1} className={grid.row}>
              <td className={grid.name}>
                <span aria-hidden className="mr-1.5 inline-block h-2 w-2" style={{ background: groupColor(p, g.group) }} />
                <Open href="/net-worth">{g.group}</Open>
              </td>
              <td className={`${grid.td} ${g.cents < 0 ? "text-neg" : ""}`}>
                <ProofValue proof={proofOf(g.proof, g.cents)}>{usd0(g.cents)}</ProofValue>
              </td>
              <td className={`${grid.td} text-muted`}>
                {g.cents > 0 && nw.assetsCents ? <ProofValue proof={compositeOf("share", [proofOf(g.proof, g.cents), proofOf(nw.proofs?.assets, nw.assetsCents)], { ratio: g.cents / nw.assetsCents })}>{formatPercentRatio(g.cents / nw.assetsCents, 1)}</ProofValue> : ""}
              </td>
            </tr>
          ))}
          <tr data-desk-row="" tabIndex={-1} className={`${grid.row} font-semibold`}>
            <td className={grid.td}>
              <Open href="/net-worth">Net worth</Open>
            </td>
            <td className={grid.td}>{nw.totalCents == null ? <BlockedValue blockers={nw.blockers} /> : <ProofValue proof={proofOf(nw.proofs?.total, nw.totalCents)} quality={nw.quality}>{usd0(nw.totalCents)}</ProofValue>}</td>
            <td className={grid.td} />
          </tr>
        </tbody>
      </table>
    </Panel>
  );
}

// ------------------------------------------------------------------ plans

const STATUS: Record<string, { label: string; cls: string }> = {
  REACHED: { label: "done", cls: "text-pos" },
  ON_TRACK: { label: "on track", cls: "text-pos" },
  IN_PROGRESS: { label: "in progress", cls: "text-info" },
  BEHIND: { label: "behind", cls: "text-warn" },
  NO_PACE: { label: "not reached", cls: "text-neg" },
  NO_TARGET: { label: "no target", cls: "text-muted" },
};
const monthOf = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" }) : NA);

const LEVER: Record<string, string> = { spend: "Spend $1k/mo less", earn: "earn $12k/yr more", return: "1 pt less return" };
/** How far a lever moves the FI year, in words. */
function leverWords(y: number | null, base: number | null): string {
  if (y === base) return "no change";
  if (y == null) return "not within 60 years";
  if (base == null) return `FI in ${y}`;
  const n = Math.abs(y - base);
  return `${n} yr${n === 1 ? "" : "s"} ${y < base ? "sooner" : "later"}`;
}
const leverTone = (y: number | null, base: number | null) => (y === base ? "" : y != null && (base == null || y < base) ? "text-pos" : "text-warn");

export function PlanPanel({ goals, fire }: { goals: Briefing["goals"]; fire: Briefing["fire"] }) {
  return (
    <Panel code="PLAN" title="Plans" href="/goals" note="from the forecast" className="xl:col-span-3">
      <table className={grid.table}>
        <thead>
          <tr>
            <th className={grid.th}>Plan</th>
            <th className={grid.th}>Now</th>
            <th className={grid.th}>Target</th>
            <th className={grid.th}>Lands</th>
          </tr>
        </thead>
        <tbody>
          {fire && (
            <tr data-desk-row="" tabIndex={-1} className={grid.row}>
              <td className={grid.name}>
                <Open href="/fire">Financial independence</Open>
              </td>
              <td className={grid.td}>
                <ProofValue proof={fire.progressProof}>{formatPercentRatio(fire.progress, 0)}</ProofValue>
              </td>
              <td className={grid.td}>
                <ProofValue proof={fire.numberProof}>{usdCompact(fire.numberCents)}</ProofValue>
              </td>
              <td className={`${grid.td} text-pos`}>
                <ProofValue proof={fire.fiProof}>{fire.fiYear ?? "60+ yrs"}</ProofValue>
              </td>
            </tr>
          )}
          {fire && fire.levers.length > 0 && (
            <tr>
              <td colSpan={4} className="border-b border-line/60 px-2 pb-1 pl-4 text-[11px] leading-snug text-muted">
                {/* FIRE › Levers' own what-ifs: scenarios, not figures of yours. */}
                <WhatIf why="FIRE › Levers: the FI year with one thing changed" inline>
                  {fire.levers.map((l, i) => (
                    <span key={l.key}>
                      {i > 0 && " · "}
                      {LEVER[l.key]}: <span className={leverTone(l.fiYear, fire.fiYear)}>{leverWords(l.fiYear, fire.fiYear)}</span>
                    </span>
                  ))}
                </WhatIf>
              </td>
            </tr>
          )}
          {goals.map((g) => {
            const s = STATUS[g.status] ?? STATUS.NO_TARGET!;
            return (
              <tr key={g.id} data-desk-row="" tabIndex={-1} className={grid.row}>
                <td className={grid.name}>
                  <Open href="/goals">
                    <NotFigure why="the goal's name, as you typed it">{g.name}</NotFigure>
                  </Open>
                </td>
                <td className={grid.td}>
                  <ProofValue proof={g.currentProof} blockers={g.blockers}>
                    {usdCompact(g.currentCents)}
                  </ProofValue>
                </td>
                <td className={grid.td}>{g.targetCents == null ? NA : <ProofValue proof={g.targetProof}>{usdCompact(g.targetCents)}</ProofValue>}</td>
                <td className={`${grid.td} ${s.cls}`} title={s.label}>
                  {g.status === "REACHED" ? "✓ done" : g.lands ? <ProofValue proof={g.landsProof}>{monthOf(g.lands)}</ProofValue> : s.label}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}

// ------------------------------------------------------------------ the feed

const FEED_TONE: Record<Briefing["feed"][number]["tone"], string> = { good: "text-pos", bad: "text-neg", warn: "text-warn", info: "text-info" };

export function FeedPanel({ feed }: { feed: Briefing["feed"] }) {
  return (
    <Panel code="NEWS" title="What stands out" note="ranked by what's at stake" className="md:col-span-2 xl:col-span-6">
      {feed.length === 0 ? (
        <p className="p-2 text-xs text-muted">Nothing stands out right now.</p>
      ) : (
        <ol className="py-0.5 text-[12px] leading-snug">
          {feed.map((f, i) => (
            <li key={f.id} data-desk-row="" tabIndex={-1} className={`flex gap-2 px-2 py-[3px] ${grid.row}`}>
              <span className="num w-4 shrink-0 text-right text-faint">{i + 1}</span>
              <Link data-desk-open="" tabIndex={-1} href={f.href} className={`w-9 shrink-0 text-[11px] font-bold leading-[1.45] hover:underline ${FEED_TONE[f.tone]}`}>
                {f.area}
              </Link>
              <span className="min-w-0 text-fg-2">
                {f.segs.map((s, j) =>
                  typeof s === "string" ? (
                    s
                  ) : "notFigure" in s ? (
                    <NotFigure key={j} why={s.notFigure}>
                      {s.text}
                    </NotFigure>
                  ) : (
                    <span key={j} className="font-semibold text-fg">
                      <ProofValue proof={s.proof}>{s.text}</ProofValue>
                    </span>
                  ),
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
