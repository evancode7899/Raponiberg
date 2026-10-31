"use client";

import { Callout, Card, StatCell, StatGrid } from "@/components/ui/kit";
import { accessBridge, ACCESS_AGE, type FireAnalysis } from "@/lib/fire/fire";
import type { Forecast } from "@/lib/forecast/forecast";
import type { OutlookSeeds } from "@/lib/profile/basePay";
import type { AnnualProfileReport } from "@/lib/profile/buildAnnualProfile";
import type { Outlook } from "@/lib/profile/outlook";
import { useMemo } from "react";
import { LongTermView } from "./LongTermView";
import { short } from "./ui";
import { unswept } from "@/lib/book/proof/clearance";

/** The forecast with the walk-away year applied, and the check that taxable money lasts until 59½. */
export function PlanTab({ f, r, s, full, base, forecast }: { f: FireAnalysis; r: AnnualProfileReport; s: OutlookSeeds; full: Outlook; base: Outlook; forecast: Forecast }) {
  return (
    <>
      <LongTermView r={r} s={s} full={full} base={base} plan={f.plan} pay={forecast.pay} schedule={forecast.schedule} fiYear={f.fi?.year ?? null} />
      <AccessCard f={f} />
    </>
  );
}

/** Retiring early means living on taxable money until 401(k)s and IRAs open at 59½. */
function AccessCard({ f }: { f: FireAnalysis }) {
  const { plan } = f;
  const walkAway = plan.walkAwayYear ?? f.fi?.year ?? null;
  const b = useMemo(() => (walkAway ? accessBridge(plan, walkAway) : null), [plan, walkAway]);
  if (!walkAway) return null;
  return (
    <Card
      title="Bridging to 59½"
      subtitle={`401(k)s and IRAs pay out penalty-free from age 59½. Retiring earlier, you live on liquid (taxable) money first. ${
        plan.walkAwayYear ? `Uses your walk-away year, ${walkAway}.` : `No walk-away year set, so this assumes you stop at FI in ${walkAway}.`
      }`}
    >
      {!b ? (
        <p className="text-xs text-muted">Add birth years in Settings › Household to see when you reach 59½.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <StatGrid cols={4}>
            <StatCell proof={unswept("Liquid, Jan 1 …")} label={`Liquid, Jan 1 ${walkAway}`} value={short(b.liquidAtWalkAway)} sub="cash + taxable investments" />
            <StatCell proof={unswept("Retirement & other")} label="Retirement & other" value={short(b.illiquidAtWalkAway)} sub="401(k), IRA, HSA…" />
            <StatCell proof={unswept("Liquid lasts until")}
              label="Liquid lasts until"
              value={b.liquidOutYear ? String(b.liquidOutYear) : "never runs out"}
              sub={b.liquidOutYear ? `age ${b.liquidOutYear - plan.birthYear!}` : "in the 60 years shown"}
            />
            <StatCell proof={unswept("Penalty-free access")} label="Penalty-free access" value={String(b.accessYear)} sub={`age ${ACCESS_AGE} (59½ during ${b.accessYear - 1})`} />
          </StatGrid>
          {b.gapYears > 0 ? (
            <Callout tone="warn" title={`${b.gapYears} year${b.gapYears === 1 ? "" : "s"} paid from retirement accounts before 59½`}>
              The plan draws on 401(k)/IRA money from {b.liquidOutYear} to {b.accessYear - 1}. Done naively that costs a 10% penalty plus tax. The usual FIRE routes: a{" "}
              <strong>Roth conversion ladder</strong> (convert each year, withdraw the conversion five years later), <strong>72(t) SEPP</strong> equal payments, or the{" "}
              <strong>Rule of 55</strong> on the 401(k) of the job you leave in or after the year you turn 55. Or keep more in taxable accounts while working.
            </Callout>
          ) : (
            <Callout tone="good" title="Liquid money covers the years before 59½">
              Taxable savings fund retirement until penalty-free access, so no early-withdrawal tricks are needed in this plan.
            </Callout>
          )}
        </div>
      )}
    </Card>
  );
}
