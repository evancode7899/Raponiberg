"use client";

import { ProofValue } from "@/components/ui/proof/ProofValue";
import { Badge, Callout, Card, EmptyState, NotFigure, table } from "@/components/ui/kit";
import { planLimitKey } from "@/lib/book/derived/medical";

import type { MedicalPage } from "@/lib/medical/page";
import type { HealthPlan } from "@/lib/medical/plans";
import type { LimitUse } from "@/lib/medical/report";
import type { Coverage } from "@/lib/medical/types";
import { Fragment } from "react";

import { COVERAGE_LABEL, money, shortDate, PER_LABEL, Fig } from "./parts";

// ---------------------------------------------------------------------------- plan & coverage

export function Plans({ plans, uses, problems, fig, coverage }: { plans: HealthPlan[]; uses: Record<string, LimitUse[]>; problems: MedicalPage["planProblems"]; fig: Fig; coverage: Coverage }) {
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

export const terms = (s: string) => <NotFigure why="The plan's terms, as its documents print them">{s}</NotFigure>;

export function PlanView({ p, uses, fig }: { p: HealthPlan; uses: LimitUse[]; fig: Fig }) {
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
