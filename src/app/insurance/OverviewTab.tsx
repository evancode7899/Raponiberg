"use client";

import { derivedNumber, derivedTarget, type DerivedFigure } from "@/lib/book/derived/types";
import { Badge, Card, EmptyState, StatCell, StatGrid, table, WordsCell } from "@/components/ui/kit";
import { limitKey } from "@/lib/book/derived/insurance";
import { NA, usd0 } from "@/lib/formatMoney";
import { overviewPolicies, upcomingDates, type CoverLine, type OverviewPolicy } from "@/lib/insurance/cover";
import type { InsurancePage } from "@/lib/insurance/page";
import { useMemo } from "react";
import { CoverStatusBadge, Fig, shortDate, until } from "./parts";

/** Insurance › Overview: every policy across life, home and auto, what each costs a year and what's coming up. */

const LINE: Record<CoverLine, { label: string; tab: "life" | "home" | "auto" }> = { LIFE: { label: "Life", tab: "life" }, HOME: { label: "Home", tab: "home" }, AUTO: { label: "Auto", tab: "auto" } };

export function OverviewTab({ data, figs, open }: { data: InsurancePage; figs: readonly DerivedFigure[]; open: (tab: "life" | "home" | "auto") => void }) {
  const all = useMemo(() => overviewPolicies(data.policies, data), [data]);
  if (!all.length) {
    return (
      <EmptyState title="No insurance documents found">
        {data.scanned
          ? "Save your policies' documents anywhere in your statements folder: a life policy packet, a home policy's declarations page, an auto policy's declarations page. Each shows up under its own tab."
          : "The statements folder wasn't found. Set STATEMENTS_DIR, then save your policy documents there."}
      </EmptyState>
    );
  }
  const inForce = all.filter((p) => p.status === "IN_FORCE");
  const upcoming = upcomingDates(data, all).slice(0, 8);
  return (
    <>
      <StatGrid cols={4}>
        <StatCell proof={derivedTarget("insurance", figs, "annual-total")} label="A year of cover" value={usd0(derivedNumber(figs, "annual-total") ?? 0)} sub="Every policy at its current rate" />
        <StatCell proof={derivedTarget("insurance", figs, "paid-year")} label="Premiums paid, 12 months" value={usd0(derivedNumber(figs, "paid-year") ?? 0)} sub={`Found in the statements, through ${shortDate(data.through)}`} />
        <StatCell proof={derivedTarget("insurance", figs, "life-cover")} label="Life cover" value={usd0(derivedNumber(figs, "life-cover") ?? 0)} sub="Death benefit in force today" />
        <WordsCell label="Policies in force" value={`${inForce.length} of ${all.length}`} sub={(["LIFE", "HOME", "AUTO"] as const).map((l) => `${all.filter((p) => p.line === l).length} ${LINE[l].label.toLowerCase()}`).join(" · ")} />
      </StatGrid>

      <Card title="Your policies" subtitle="Each policy found in the statements folder. Open a line's tab to dive into its coverage, documents and payments.">
        <div className={table.wrap}>
          <table className={table.table}>
            <thead>
              <tr className={table.head}>
                <th className={table.th}>Line</th>
                <th className={table.th}>Insurer</th>
                <th className={table.th}>Covers</th>
                <th className={table.th}>Status</th>
                <th className={table.th}>Next</th>
                <th className={table.thR}>A year</th>
              </tr>
            </thead>
            <tbody>
              {all.map((p) => (
                <tr key={`${p.line}|${p.key}`} className={`${table.tr} cursor-pointer hover:bg-surface-2`} onClick={() => open(LINE[p.line].tab)}>
                  <td className={table.td}>
                    <Badge tone="accent">{LINE[p.line].label}</Badge>
                  </td>
                  <td className={table.td}>
                    {p.insurer}
                    <span className="block text-xs text-muted">Policy {p.policyNumber}</span>
                  </td>
                  <td className={table.td}>{p.covers}</td>
                  <td className={table.td}>
                    <PolicyStatus p={p} data={data} />
                  </td>
                  <td className={table.td}>
                    {p.next ? (
                      <>
                        {shortDate(p.next.date)}
                        <span className="block text-xs text-muted">
                          {p.next.label}
                          {until(data.today, p.next.date) ? `, ${until(data.today, p.next.date)}` : ""}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted">{NA}</span>
                    )}
                  </td>
                  <td className={table.tdR}>{p.annualCents == null ? <span className="text-muted">{NA}</span> : <Fig figs={figs} figure="annual" k={`${p.line}|${p.key}`} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="What's covered" subtitle="The headline limits of each policy, as its documents print them.">
          <ul className="divide-y divide-line">
            {data.policies.map((v) => (
              <CoverItem key={`L${v.policy.policyNumber}`} line="Life" title={`${v.policy.insurer} · ${v.policy.insured}`} onOpen={() => open("life")} rows={[["Death benefit", <Fig key="d" figs={figs} figure="death-benefit" k={v.policy.policyNumber} />]]} />
            ))}
            {data.homes.map((v) => {
              const pn = v.policy.policyNumber;
              const at = (code: string) => v.policy.property.findIndex((c) => c.code === code);
              const own = at("B") >= 0 ? at("B") : at("A");
              const liab = v.policy.liability.findIndex((c) => c.code === "L");
              return (
                <CoverItem
                  key={`H${pn}`}
                  line="Home"
                  title={`${v.policy.insurer} · ${v.policy.form}`}
                  onOpen={() => open("home")}
                  rows={[
                    own >= 0 ? [v.policy.property[own]!.name, <Fig key="p" figs={figs} figure="limit" k={limitKey(pn, "P", own)} />] : null,
                    liab >= 0 ? ["Personal liability", <Fig key="l" figs={figs} figure="limit" k={limitKey(pn, "L", liab)} />] : null,
                    v.policy.deductibles.length ? ["Deductible", <Fig key="d" figs={figs} figure="limit" k={limitKey(pn, "D", 0)} />] : null,
                  ]}
                />
              );
            })}
            {data.autos.map((v) => {
              const pn = v.policy.policyNumber;
              const find = (re: RegExp) => v.policy.coverages.findIndex((c) => re.test(c.name));
              const rows = [
                [/^Bodily Injury/i, "Bodily injury"],
                [/^Property Damage/i, "Property damage"],
                [/^Collision/i, "Collision"],
                [/^Comprehensive/i, "Comprehensive"],
              ] as const;
              return (
                <CoverItem
                  key={`A${pn}`}
                  line="Auto"
                  title={`${v.policy.insurer} · ${v.policy.vehicles.map((x) => [x.year, x.make].filter(Boolean).join(" ")).join(", ")}`}
                  onOpen={() => open("auto")}
                  rows={rows.map(([re, label]) => (find(re) >= 0 ? [label, <Fig key={label} figs={figs} figure="limit" k={limitKey(pn, "C", find(re))} />] : null))}
                />
              );
            })}
          </ul>
        </Card>
        <Card title="Coming up" subtitle="Renewals, premiums due and the dates the contracts set, across every policy.">
          {upcoming.length === 0 ? (
            <p className="text-sm text-muted">Nothing ahead on the policies on file.</p>
          ) : (
            <ul className="divide-y divide-line">
              {upcoming.map((d) => (
                <li key={`${d.line}|${d.key}|${d.label}|${d.date}`} className="flex flex-wrap items-baseline gap-x-3 py-2 first:pt-0 last:pb-0">
                  <span className="num w-28 shrink-0 text-xs font-semibold text-fg">{shortDate(d.date)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="text-sm font-medium text-fg">{d.label}</span>
                    <span className="ml-2 text-xs text-muted">{until(data.today, d.date)}</span>
                    <span className="block text-xs text-muted">
                      {LINE[d.line].label} · {d.insurer}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function PolicyStatus({ p, data }: { p: OverviewPolicy; data: InsurancePage }) {
  if (p.line === "LIFE") {
    const v = data.policies.find((x) => x.policy.policyNumber === p.key);
    if (v?.status === "IN_FORCE") return <Badge tone="pos">In force · year {v.currentYear}</Badge>;
  }
  const end = [...data.homes, ...data.autos].find((x) => x.policy.policyNumber === p.key)?.policy.periodEnd ?? data.today;
  return <CoverStatusBadge status={p.status} end={end} />;
}

function CoverItem({ line, title, rows, onOpen }: { line: string; title: string; rows: ([string, React.ReactNode] | null)[]; onOpen: () => void }) {
  return (
    <li className="py-2.5 first:pt-0 last:pb-0">
      <button type="button" onClick={onOpen} className="mb-1.5 flex w-full items-baseline gap-2 text-left">
        <Badge tone="accent">{line}</Badge>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg hover:underline">{title}</span>
      </button>
      <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-1 text-sm">
        {rows.filter((r): r is [string, React.ReactNode] => r != null).map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="num text-fg">{value}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

