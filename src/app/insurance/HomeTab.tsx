"use client";

import { derivedTarget, type DerivedFigure } from "@/lib/book/derived/types";
import { Badge, Card, EmptyState, StatCell, StatGrid, table } from "@/components/ui/kit";
import { NA, usd0 } from "@/lib/formatMoney";
import { limitKey } from "@/lib/book/derived/insurance";
import type { HomeView } from "@/lib/insurance/cover";
import type { InsurancePage } from "@/lib/insurance/page";
import type { Coverage } from "@/lib/insurance/types";
import { useState } from "react";
import { CoverPayments, CoverStatusBadge, Facts, Fig, longDate, PolicyPicker, shortDate, SubTabs, termText, TermsOnFile, until, useViewParam } from "./parts";

/** Insurance › Home: renters, homeowners or condo policies, from each term's declarations page. */

const VIEWS = ["coverage", "policy", "payments"] as const;

const LINE_LABEL: Record<HomeView["policy"]["line"], string> = { RENTERS: "Renters", HOMEOWNERS: "Homeowners", CONDO: "Condo unit owners", OTHER: "Home" };

export function HomeTab({ data, figs }: { data: InsurancePage; figs: readonly DerivedFigure[] }) {
  const [view, setView] = useViewParam(VIEWS, "coverage");
  const [picked, setPicked] = useState<string | null>(null);
  const v = data.homes.find((h) => h.policy.policyNumber === picked) ?? data.homes[0] ?? null;
  if (!v) {
    return (
      <EmptyState title="No home policy found">
        {data.scanned
          ? "Save your renters, homeowners or condo policy's declarations page (the PDF the insurer sends with each renewal) anywhere in your statements folder, and open this page again."
          : "The statements folder wasn't found. Set STATEMENTS_DIR, then save the declarations page there."}
      </EmptyState>
    );
  }
  const p = v.policy;
  const pn = p.policyNumber;
  const main = (list: Coverage[], code: string) => list.findIndex((c) => c.code === code);
  const personal = main(p.property, "B") >= 0 ? main(p.property, "B") : main(p.property, "A");
  const liability = main(p.liability, "L");
  return (
    <>
      <PolicyPicker options={data.homes.map((h) => ({ value: h.policy.policyNumber, label: `${LINE_LABEL[h.policy.line]} ••${h.policy.policyNumber.slice(-4)}` }))} value={pn} onChange={setPicked} />
      <Card tone="overview" title={`${p.form} · ${p.insurer}`} subtitle={[`Policy ${pn}`, p.premises.join(", ")].filter(Boolean).join(" · ")} actions={<CoverStatusBadge status={v.status} end={p.periodEnd} />}>
        <p className="text-sm text-fg-2">
          {LINE_LABEL[p.line]} insurance for {p.namedInsured.join(" and ") || "the named insured"}, {termText(p.periodStart, p.periodEnd)}.
          {v.status === "IN_FORCE" && ` ${p.autoRenews ? "Renews automatically" : "Ends"} ${longDate(p.periodEnd)}, ${until(data.today, p.periodEnd)}.`}
          {p.billing && ` ${p.billing}.`}
        </p>
      </Card>

      <StatGrid cols={4}>
        <StatCell proof={derivedTarget("insurance", figs, "home-premium", pn)} label="Premium" value={usd0(p.totalPremiumCents)} sub={p.termMonths ? `For the ${p.termMonths}-month term` : "For the term"} />
        <StatCell proof={derivedTarget("insurance", figs, "limit", limitKey(pn, "P", personal))} label={personal >= 0 ? p.property[personal]!.name : "Property"} value={personal >= 0 ? p.property[personal]!.limit : NA} sub={p.lossSettlement[0] ?? undefined} />
        <StatCell proof={derivedTarget("insurance", figs, "limit", limitKey(pn, "L", liability))} label="Personal liability" value={liability >= 0 ? p.liability[liability]!.limit : NA} sub={liability >= 0 && p.liability[liability]!.per ? p.liability[liability]!.per! : undefined} />
        <StatCell proof={derivedTarget("insurance", figs, "limit", limitKey(pn, "D", 0))} label="Deductible" value={p.deductibles[0]?.text ?? NA} sub={p.deductibles[0] ? p.deductibles[0].name : undefined} />
      </StatGrid>

      <SubTabs
        tabs={[
          { id: "coverage" as const, label: "Coverage" },
          { id: "policy" as const, label: "Policy" },
          { id: "payments" as const, label: "Payments", count: v.payments.length },
        ]}
        value={view}
        onChange={setView}
      />
      {view === "coverage" && <HomeCoverage v={v} figs={figs} />}
      {view === "policy" && <HomePolicy v={v} figs={figs} />}
      {view === "payments" && (
        <>
          <StatGrid cols={3}>
            <StatCell proof={derivedTarget("insurance", figs, "paid-term", pn)} label="Paid this term" value={usd0(v.paidTermCents)} sub={`${v.payments.filter((x) => x.term === p.periodStart).length} payments found in the statements`} />
            <StatCell proof={derivedTarget("insurance", figs, "home-premium", pn)} label="Term premium" value={usd0(p.totalPremiumCents)} sub="As the declarations print it" />
            <StatCell proof={derivedTarget("insurance", figs, "annual", `HOME|${pn}`)} label="A year of cover" value={usd0(v.annualCents)} sub="At this term's rate" />
          </StatGrid>
          <Card title="Premiums in the statements" subtitle={`Charges to ${p.insurer} on your bank and card statements, newest first, each under the term it paid for. Click an amount for the statement row.`}>
            <CoverPayments payments={v.payments} terms={v.terms} accounts={data.accounts} insurer={p.insurer} />
          </Card>
        </>
      )}
    </>
  );
}

function CoverageTable({ list, group, pn, figs }: { list: Coverage[]; group: string; pn: string; figs: readonly DerivedFigure[] }) {
  const rows = list.map((c, i) => ({ c, i }));
  const section = (title: string | null, items: typeof rows) =>
    items.length > 0 && (
      <>
        {title && (
          <tr>
            <td colSpan={3} className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
              {title}
            </td>
          </tr>
        )}
        {items.map(({ c, i }) => (
          <tr key={i} className={table.tr}>
            <td className={`${table.td} w-10 text-muted`}>{c.code ?? ""}</td>
            <td className={table.td}>
              {c.name}
              {c.per && <span className="ml-2 text-xs text-muted">{c.per.toLowerCase()}</span>}
            </td>
            {/* Some limits are words ("10% of Coverage B amount / $750 per item"): they wrap rather than push the column off the card. */}
            <td className={`${table.tdR} max-w-[14rem] whitespace-normal`}>
              <Fig figs={figs} figure="limit" k={limitKey(pn, group, i)} />
            </td>
          </tr>
        ))}
      </>
    );
  return (
    <div className={table.wrap}>
      <table className={table.table}>
        <thead>
          <tr className={table.head}>
            <th className={table.th}>Code</th>
            <th className={table.th}>Coverage</th>
            <th className={table.thR}>Limit</th>
          </tr>
        </thead>
        <tbody>
          {section(null, rows.filter((r) => !r.c.additional))}
          {section("Additional coverages", rows.filter((r) => r.c.additional))}
        </tbody>
      </table>
    </div>
  );
}

function HomeCoverage({ v, figs }: { v: HomeView; figs: readonly DerivedFigure[] }) {
  const p = v.policy;
  const pn = p.policyNumber;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="Section I · Property" subtitle="Your belongings and the cost of living elsewhere after a covered loss. Additional coverages are included at these limits.">
        <CoverageTable list={p.property} group="P" pn={pn} figs={figs} />
      </Card>
      <div className="flex flex-col gap-4">
        <Card title="Section II · Liability" subtitle="If you're held responsible for someone's injury or damage to their property.">
          <CoverageTable list={p.liability} group="L" pn={pn} figs={figs} />
        </Card>
        <Card title="Deductibles and loss settlement" subtitle="What you pay first on a Section I claim, and how a loss is valued.">
          <div className={table.wrap}>
            <table className={table.table}>
              <tbody>
                {p.deductibles.map((d, i) => (
                  <tr key={d.name} className={table.tr}>
                    <td className={table.td}>{d.name}</td>
                    <td className={table.tdR}>
                      <Fig figs={figs} figure="limit" k={limitKey(pn, "D", i)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Facts
            rows={[
              ["Loss settlement", p.lossSettlement.join("; ") || null],
              ["Inflation index", p.inflationIndex ? `${p.inflationIndex} (limits follow it at renewal)` : null],
            ]}
          />
        </Card>
      </div>
    </div>
  );
}

function HomePolicy({ v, figs }: { v: HomeView; figs: readonly DerivedFigure[] }) {
  const p = v.policy;
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="The declarations">
          <Facts
            rows={[
              ["Insurer", p.insurer],
              ["Policy", p.form],
              ["Policy number", p.policyNumber],
              ["Named insured", p.namedInsured.join("; ") || null],
              ["Residence", p.premises.join(", ") || null],
              ["Term", `${termText(p.periodStart, p.periodEnd)}${p.termMonths ? ` (${p.termMonths} months)` : ""}, from 12:01 a.m. at the residence`],
              ["Renewal", p.autoRenews ? "Renews automatically at the premiums, rules and forms then in effect" : null],
              ["Billing", p.billing],
              ["Amount due now", p.amountDue],
              ["Discounts", p.discounts.join("; ") || null],
              ["Agent", [p.agent.name, p.agent.phone].filter(Boolean).join(", ") || null],
              ["Prepared", p.preparedDate ? shortDate(p.preparedDate) : null],
              ["File", v.file],
            ]}
          />
        </Card>
        <Card title="Forms and endorsements" subtitle="The policy's contract is these forms; a new or changed one comes with the renewal.">
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr className={table.head}>
                  <th className={table.th}>Form</th>
                  <th className={table.th}>Name</th>
                </tr>
              </thead>
              <tbody>
                {p.forms.map((f) => (
                  <tr key={f.code} className={table.tr}>
                    <td className={`${table.td} num`}>{f.code}</td>
                    <td className={table.td}>
                      {f.name}
                      {f.isNew && (
                        <span className="ml-2">
                          <Badge tone="info">new form attached</Badge>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
      <Card title="Terms on file" subtitle="Each term's premium, from the declarations in the statements folder.">
        <TermsOnFile line="HOME" policyNumber={p.policyNumber} terms={v.terms} figs={figs} />
      </Card>
    </>
  );
}
