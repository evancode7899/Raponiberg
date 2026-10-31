"use client";

import { ShareBar, ShareLegend, type ShareSegment } from "@/components/charts/ShareBar";
import { fundsDerived } from "@/lib/book/derived/funds";
import { derivedTarget } from "@/lib/book/derived/types";
import { useChartPalette } from "@/components/shell/chartPalette";
import { Badge, Callout, Card, StatCell, StatGrid, table } from "@/components/ui/kit";
import type { LpEvent, LpFund } from "@/lib/funds/report";
import type { FundsPage } from "@/lib/funds/page";
import { formatPercentRatio, usd0, usdDelta } from "@/lib/formatMoney";

const multiple = (x: number | null) => (x == null ? "—" : `${x.toFixed(2)}x`);
const cell = (cents: number) => (cents ? usd0(cents) : "—");

/** Every private fund's LP view, grouped by manager (Investments › Private funds). */
export function PrivateFunds({ page }: { page: FundsPage }) {
  const managers = [...new Set(page.funds.map((f) => f.manager))];
  return (
    <>
      {page.errors.length > 0 && (
        <Callout tone="warn" title={`${page.errors.length} fund document${page.errors.length === 1 ? "" : "s"} couldn't be read`}>
          {page.errors.map((e) => `${e.title}: ${e.error}`).join("; ")}
        </Callout>
      )}
      {managers.map((m) => (
        <section key={m} className="space-y-4">
          <h2 className="text-sm font-semibold text-fg">{m}</h2>
          {page.funds
            .filter((f) => f.manager === m)
            .map((f) => (
              <LpPanel key={f.key} fund={f} />
            ))}
        </section>
      ))}
    </>
  );
}

/**
 * One fund as an LP reads it, from the manager's notices and capital statements:
 * commitment, contributions gross and net, everything paid out (recycled or not),
 * interest, unfunded commitment, value, and each notice tied to the bank's wire.
 */
export function LpPanel({ fund: f }: { fund: LpFund }) {
  const p = useChartPalette();
  const failed = f.checks.filter((c) => !c.ok);
  const s = f.statement;
  const drawdown: ShareSegment[] =
    f.commitmentCents == null
      ? []
      : [
          { id: "net", label: "Contributed (net of returns)", cents: f.netContributedCents, color: p.principal },
          { id: "unfunded", label: "Unfunded commitment", cents: Math.max(0, f.unfundedCents ?? 0), color: p.neutral },
        ];
  const wires = f.events.filter((e) => e.wire).length;
  return (
    <div className="space-y-4">
      <Card
        tone="overview"
        title={f.fund}
        subtitle={
          <>
            From the manager&apos;s own notices and capital statements{f.latestNotice ? `, through the ${f.latestNotice} notice` : ""}.{" "}
            <span title={f.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.label}: ${usd0(c.expectedCents)} vs ${usd0(c.actualCents)}`).join("\n")} className="cursor-help underline decoration-dotted">
              {f.checks.length - failed.length} of {f.checks.length} tie-outs pass
            </span>
          </>
        }
        actions={f.investorId ? <Badge>Investor {f.investorId.replace(/^\D+0*/, "••")}</Badge> : undefined}
      >
        {drawdown.length > 0 && (
          <>
            <ShareBar segments={drawdown} label="Commitment drawn vs unfunded" />
            <ShareLegend segments={drawdown} />
          </>
        )}
      </Card>
      {failed.length > 0 && (
        <Callout tone="warn" title={`${failed.length} figure${failed.length === 1 ? "" : "s"} don't tie to what the manager printed`}>
          {failed.map((c) => `${c.label}: printed ${usd0(c.expectedCents)}, notices on file give ${usd0(c.actualCents)}`).join("; ")}. A notice may be missing from the statements folder.
        </Callout>
      )}
      <StatGrid cols={4}>
        <StatCell proof={derivedTarget("lp-funds", fundsDerived([f]), "commitment", f.key)} label="Commitment" value={usd0(f.commitmentCents)} sub="total capital committed" />
        <StatCell proof={derivedTarget("lp-funds", fundsDerived([f]), "called", f.key)} label="Contributions (gross)" value={usd0(f.calledCents)} sub="every call, before anything handed back" />
        <StatCell proof={derivedTarget("lp-funds", fundsDerived([f]), "distributed", f.key)}
          label="Distributions to date"
          value={usd0(f.distributedCents)}
          sub={`${usd0(f.returnedCents)} returned at later closes (recallable) + ${usd0(f.interestCents)} interest${f.otherDistributionsCents ? ` + ${usd0(f.otherDistributionsCents)} other` : ""}`}
        />
        <StatCell proof={derivedTarget("lp-funds", fundsDerived([f]), "net-contributed", f.key)} label="Contributions (net)" value={usd0(f.netContributedCents)} sub="gross less returned: the manager's contributions to date" />
        <StatCell proof={derivedTarget("lp-funds", fundsDerived([f]), "interest", f.key)} label="Interest received" value={usd0(f.interestCents)} tone={f.interestCents > 0 ? "pos" : "neutral"} sub="paid by later investors on returned contributions" />
        <StatCell proof={derivedTarget("lp-funds", fundsDerived([f]), "unfunded", f.key)}
          label="Unfunded commitment"
          value={usd0(f.unfundedCents)}
          sub={f.commitmentCents ? `${formatPercentRatio((f.unfundedCents ?? 0) / f.commitmentCents, 0)} of the commitment still to be called` : "no commitment printed yet"}
        />
        <StatCell proof={derivedTarget("lp-funds", fundsDerived([f]), "net-cash", f.key)} label="Net cash wired" value={usd0(f.netCashCents)} sub={`amounts due on the notices; ${wires} bank wire${wires === 1 ? "" : "s"} on file total ${usd0(f.wiredCents)}`} />
        <StatCell proof={derivedTarget("lp-funds", fundsDerived([f]), "nav", f.key)} label="Value (NAV)" value={s ? usd0(s.navCents) : "—"} sub={s ? `capital account at the ${s.asOf} statement` : "no capital statement yet"} />
      </StatGrid>
      {s && (
        <Card
          title={`Performance at the ${s.asOf} statement`}
          subtitle={`On the contributions called through the statement date.${f.callsSinceStatement ? ` ${f.callsSinceStatement} notice${f.callsSinceStatement === 1 ? "" : "s"} since then count in the totals above, not here, until the next statement values them.` : ""}`}
        >
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.head}>
                <tr>
                  <th className={table.thR}>Paid in</th>
                  <th className={table.thR}>Distributed</th>
                  <th className={table.thR}>NAV</th>
                  <th className={table.thR}>Gain</th>
                  <th className={table.thR}>Income to date</th>
                  <th className={table.thR}>Mgmt fees</th>
                  <th className={table.thR}>Carry</th>
                  <th className={table.thR}>DPI</th>
                  <th className={table.thR}>RVPI</th>
                  <th className={table.thR}>TVPI</th>
                </tr>
              </thead>
              <tbody>
                <tr className={table.tr}>
                  <td className={table.tdR}>{usd0(s.paidInCents)}</td>
                  <td className={table.tdR}>{usd0(s.distributedCents)}</td>
                  <td className={table.tdR}>{usd0(s.navCents)}</td>
                  <td className={`${table.tdR} ${s.gainCents < 0 ? "text-neg" : "text-pos"}`}>{usdDelta(s.gainCents)}</td>
                  <td className={table.tdR}>{usd0(s.incomeCents)}</td>
                  <td className={table.tdR}>{cell(s.managementFeeCents)}</td>
                  <td className={table.tdR}>{cell(s.carryCents)}</td>
                  <td className={table.tdR}>{multiple(s.dpi)}</td>
                  <td className={table.tdR}>{multiple(s.rvpi)}</td>
                  <td className={table.tdR}>{multiple(s.tvpi)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <Card title="Notice by notice" subtitle="Newest first. An equalisation call hands part of earlier contributions back (added back to unfunded) with interest, against a new contribution; only the net is wired.">
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Date</th>
                <th className={table.th}>Document</th>
                <th className={table.thR}>Called</th>
                <th className={table.thR}>Returned</th>
                <th className={table.thR}>Interest</th>
                <th className={table.thR}>Net due</th>
                <th className={table.th}>Bank wire</th>
                <th className={table.thR}>Unfunded after</th>
                <th className={table.thR}>NAV</th>
              </tr>
            </thead>
            <tbody>{f.events.map((e) => <EventRow key={`${e.kind}${e.date}`} e={e} />)}</tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function EventRow({ e }: { e: LpEvent }) {
  const statement = e.kind === "STATEMENT";
  const mismatch = e.printedUnfundedCents != null && e.unfundedCents != null && Math.abs(e.printedUnfundedCents - e.unfundedCents) > 100;
  return (
    <tr className={table.tr}>
      <td className={`${table.td} whitespace-nowrap`}>{e.date}</td>
      <td className={table.td} title={e.sources.map((s) => s.title).join("\n")}>
        {e.label} {e.kind === "EQUALISATION" && <Badge tone="info">equalisation</Badge>}
        {e.sources.length > 1 && <span className="text-xs text-muted"> · {e.sources.length} copies</span>}
      </td>
      <td className={table.tdR}>{statement ? "" : cell(e.calledCents)}</td>
      <td className={table.tdR}>{statement ? "" : e.returnedCents ? `(${usd0(e.returnedCents)})` : "—"}</td>
      <td className={table.tdR}>{statement ? "" : e.interestCents ? `(${usd0(e.interestCents)})` : "—"}</td>
      <td className={table.tdR}>{statement ? "" : usd0(e.netDueCents)}</td>
      <td className={`${table.td} whitespace-nowrap text-xs`}>
        {e.wire ? (
          <span title={e.wire.accountName}>
            {usd0(e.wire.amountCents)} on {e.wire.date}
          </span>
        ) : !statement && e.netDueCents > 0 ? (
          <Badge tone="warn">no wire on file</Badge>
        ) : (
          ""
        )}
      </td>
      <td className={`${table.tdR} ${mismatch ? "text-warn" : ""}`} title={e.printedUnfundedCents != null ? `Printed by the manager: ${usd0(e.printedUnfundedCents)}` : undefined}>
        {usd0(e.unfundedCents)}
      </td>
      <td className={table.tdR}>{e.navCents != null ? usd0(e.navCents) : ""}</td>
    </tr>
  );
}
