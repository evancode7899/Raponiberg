"use client";

import { derivedTarget, type DerivedFigure } from "@/lib/book/derived/types";
import { Card, EmptyState, StatCell, StatGrid, table } from "@/components/ui/kit";
import { limitKey } from "@/lib/book/derived/insurance";
import { NA, usd0 } from "@/lib/formatMoney";
import type { AutoView } from "@/lib/insurance/cover";
import type { InsurancePage } from "@/lib/insurance/page";
import Link from "next/link";
import { useState } from "react";
import { CoverPayments, CoverStatusBadge, Facts, Fig, longDate, PolicyPicker, shortDate, SubTabs, termText, TermsOnFile, until, useViewParam } from "./parts";

/** Insurance › Auto: each auto policy from its latest declarations page, its renewal letter and the packet's other pages. */

const VIEWS = ["coverage", "vehicles", "payments", "policy"] as const;

const vehicleName = (x: AutoView["policy"]["vehicles"][number]) => [x.year, x.make].filter(Boolean).join(" ");

export function AutoTab({ data, figs }: { data: InsurancePage; figs: readonly DerivedFigure[] }) {
  const [view, setView] = useViewParam(VIEWS, "coverage");
  const [picked, setPicked] = useState<string | null>(null);
  const v = data.autos.find((a) => a.policy.policyNumber === picked) ?? data.autos[0] ?? null;
  if (!v) {
    return (
      <EmptyState title="No auto policy found">
        {data.scanned
          ? "Save your auto policy's declarations page (in the renewal or new-policy packet) anywhere in your statements folder, and open this page again."
          : "The statements folder wasn't found. Set STATEMENTS_DIR, then save the declarations page there."}
      </EmptyState>
    );
  }
  const p = v.policy;
  const pn = p.policyNumber;
  const change = v.renewal?.renewal.priorPremiumCents != null ? v.renewal.renewal.newPremiumCents - v.renewal.renewal.priorPremiumCents : null;
  return (
    <>
      <PolicyPicker options={data.autos.map((a) => ({ value: a.policy.policyNumber, label: `${a.policy.vehicles.map(vehicleName).join(", ") || "Auto"} ••${a.policy.policyNumber.slice(-4)}` }))} value={pn} onChange={setPicked} />
      <Card tone="overview" title={`Auto · ${p.insurer}`} subtitle={[`Policy ${pn}`, p.vehicles.map(vehicleName).join(", ")].filter(Boolean).join(" · ")} actions={<CoverStatusBadge status={v.status} end={p.periodEnd} />}>
        <p className="text-sm text-fg-2">
          {p.renewal ? "Renewal" : "New policy"} for {p.namedInsured.join(" and ") || "the named insured"}, {termText(p.periodStart, p.periodEnd)} ({p.termMonths} months).
          {v.status === "IN_FORCE" && ` The term ends ${longDate(p.periodEnd)}, ${until(data.today, p.periodEnd)}.`}
          {v.status === "NOT_STARTED" && ` It starts ${longDate(p.periodStart)}, ${until(data.today, p.periodStart)}.`}
        </p>
      </Card>

      <StatGrid cols={4}>
        <StatCell proof={derivedTarget("insurance", figs, "auto-premium", pn)} label="Term premium" value={usd0(p.termPremiumCents)} sub={`For ${p.termMonths} months`} />
        <StatCell proof={derivedTarget("insurance", figs, "annual", `AUTO|${pn}`)} label="A year of cover" value={usd0(v.annualCents)} sub="At this term's rate" />
        <StatCell
          proof={derivedTarget("insurance", figs, "renewal-change", pn)}
          label="Change at renewal"
          tone={change == null ? "neutral" : change > 0 ? "neg" : "pos"}
          value={change == null ? NA : `${change > 0 ? "+" : ""}${usd0(change)}`}
          sub={change == null ? "No renewal letter on file" : "New term against the one it renews"}
        />
        <StatCell proof={derivedTarget("insurance", figs, "discount-total", pn)} label="Discounts" value={p.discountTotalCents == null ? NA : usd0(p.discountTotalCents)} sub="Already taken off the premium" />
      </StatGrid>

      <SubTabs
        tabs={[
          { id: "coverage" as const, label: "Coverage" },
          { id: "vehicles" as const, label: "Vehicles & drivers", count: p.vehicles.length },
          { id: "payments" as const, label: "Payments", count: v.payments.length },
          { id: "policy" as const, label: "Policy & documents" },
        ]}
        value={view}
        onChange={setView}
      />
      {view === "coverage" && <AutoCoverage v={v} figs={figs} />}
      {view === "vehicles" && <AutoVehicles v={v} />}
      {view === "payments" && (
        <>
          <StatGrid cols={3}>
            <StatCell proof={derivedTarget("insurance", figs, "paid-term", pn)} label="Paid this term" value={usd0(v.paidTermCents)} sub={`${v.payments.filter((x) => x.term === p.periodStart).length} payments found in the statements`} />
            <StatCell proof={derivedTarget("insurance", figs, "auto-premium", pn)} label="Term premium" value={usd0(p.termPremiumCents)} sub="Installments can add a fee each" />
            <StatCell proof={derivedTarget("insurance", figs, "annual", `AUTO|${pn}`)} label="A year of cover" value={usd0(v.annualCents)} sub="At this term's rate" />
          </StatGrid>
          <Card title="Premiums in the statements" subtitle={`Charges to ${p.insurer} on your bank and card statements, newest first, each under the term it paid for. Click an amount for the statement row.`}>
            <CoverPayments payments={v.payments} terms={v.terms} accounts={data.accounts} insurer={p.insurer} />
          </Card>
          <Card title="Terms on file" subtitle="Each term's premium: from its declarations, or the term before the latest from the renewal letter's prior premium.">
            <TermsOnFile line="AUTO" policyNumber={pn} terms={v.terms} figs={figs} />
          </Card>
        </>
      )}
      {view === "policy" && <AutoPolicyFacts v={v} />}
    </>
  );
}

function AutoCoverage({ v, figs }: { v: AutoView; figs: readonly DerivedFigure[] }) {
  const p = v.policy;
  const pn = p.policyNumber;
  const vehicles = p.vehicles.length ? p.vehicles : [{ n: 1, year: null, make: "Vehicle 1", vin: null, garaged: null, lienholder: null }];
  return (
    <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <Card title="Coverages" subtitle="Limits and deductibles as the declarations print them, and each coverage's premium for the term. A vehicle is covered where it shows a premium.">
        <div className={table.wrap}>
          <table className={table.table}>
            <thead>
              <tr className={table.head}>
                <th className={table.th}>Coverage</th>
                <th className={table.thR}>Limits / deductible</th>
                {vehicles.map((x) => (
                  <th key={x.n} className={table.thR}>
                    {vehicles.length > 1 ? vehicleName(x) : "Premium"}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {p.coverages.map((c, i) => (
                <tr key={i} className={table.tr}>
                  <td className={table.td}>
                    {c.name}
                    {c.per && <span className="block text-xs text-muted">{c.per.toLowerCase()}</span>}
                  </td>
                  <td className={table.tdR}>
                    <Fig figs={figs} figure="limit" k={limitKey(pn, "C", i)} />
                  </td>
                  {vehicles.map((x, j) => (
                    <td key={x.n} className={table.tdR}>
                      {c.premiumCents[j] == null ? <span className="text-muted">{NA}</span> : <Fig figs={figs} figure="coverage-premium" k={`${pn}|${i}|${j}`} />}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className={`${table.tr} border-t-2 border-line-strong font-semibold`}>
                <td className={table.td} colSpan={2}>
                  Total {p.termMonths}-month premium
                </td>
                <td className={table.tdR} colSpan={vehicles.length}>
                  <Fig figs={figs} figure="auto-premium" k={pn} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Discounts" subtitle="Already taken off the premium above.">
        <div className={table.wrap}>
          <table className={table.table}>
            <tbody>
              {p.discounts.map((d, i) => (
                <tr key={d.name} className={table.tr}>
                  <td className={table.td}>{d.name}</td>
                  <td className={table.tdR}>{d.cents == null ? <span className="text-muted">Included</span> : <Fig figs={figs} figure="discount" k={`${pn}|${i}`} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function AutoVehicles({ v }: { v: AutoView }) {
  const p = v.policy;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Vehicles" subtitle={<>As the declarations list them. Running costs are on the <Link className="text-accent hover:underline" href="/car">Car</Link> page.</>}>
        <div className={table.wrap}>
          <table className={table.table}>
            <thead>
              <tr className={table.head}>
                <th className={table.th}>#</th>
                <th className={table.th}>Vehicle</th>
                <th className={table.th}>VIN</th>
                <th className={table.th}>Garaged</th>
                <th className={table.th}>Lienholder</th>
              </tr>
            </thead>
            <tbody>
              {p.vehicles.map((x) => (
                <tr key={x.n} className={table.tr}>
                  <td className={table.td}>{x.n}</td>
                  <td className={table.td}>{vehicleName(x)}</td>
                  <td className={`${table.td} num text-fg-2`}>{x.vin ?? "—"}</td>
                  <td className={table.td}>{x.garaged ?? "—"}</td>
                  <td className={table.td}>{x.lienholder ?? "None"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Who's covered">
        <Facts
          rows={[
            ["Named insured", p.namedInsured.join("; ") || null],
            ["Other drivers", p.drivers.join("; ") || "None listed"],
          ]}
        />
      </Card>
    </div>
  );
}

function AutoPolicyFacts({ v }: { v: AutoView }) {
  const p = v.policy;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="The declarations">
        <Facts
          rows={[
            ["Insurer", p.insurer],
            ["Policy number", p.policyNumber],
            ["Term", `${termText(p.periodStart, p.periodEnd)} (${p.termMonths} months), from 12:01 a.m. local time`],
            ["Issued", p.issuedDate ? shortDate(p.issuedDate) : null],
            ["Packet", p.renewal ? "Renewal" : "New business"],
            ["Contract", p.contractType],
            ["Amendments", p.amendments],
            ["Endorsements", p.unitEndorsements],
            ["Service line", p.servicePhone],
            ["Renewal letter", v.renewal ? `${v.renewal.file}${v.renewal.renewal.date ? `, dated ${shortDate(v.renewal.renewal.date)}` : ""}` : null],
            ["File", v.file],
          ]}
        />
      </Card>
      <Card title="Documents in the packet" subtitle="The packet's other pages found in the statements folder: the contract and the notices that come with it.">
        {v.forms.length === 0 ? (
          <p className="text-sm text-muted">No other pages of the packet on file.</p>
        ) : (
          <ul className="divide-y divide-line">
            {v.forms.map((f) => (
              <li key={f.file} className="flex flex-wrap items-baseline gap-x-3 py-2 first:pt-0 last:pb-0">
                <span className="min-w-0 flex-1 text-sm text-fg">{f.title}</span>
                {f.code && <span className="num text-xs text-muted">{f.code}</span>}
                <span className="block w-full truncate text-xs text-faint" title={f.file}>
                  {f.file}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
