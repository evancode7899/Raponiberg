"use client";

import type { Api } from "@/components/ledger/useApi";
import { Card } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import type { ProofDescriptor } from "@/lib/book/proof";
import { monthLabel } from "@/lib/dates/display";
import { formatPercentRatio, formatUsdFromCents, NA } from "@/lib/formatMoney";
import type { Value } from "@/lib/restatements";
import type { Why } from "@/lib/restatementWhy";
import { useEffect, useState } from "react";

type Answer = {
  monthEnd: { month: string; takenAt: string } | null;
  compared?: number;
  movedCount?: number;
  moved?: { descriptor: ProofDescriptor; describes: string | null; was: Value; now: Value }[];
  why?: Why[];
};

const text = (v: Value) => ("cents" in v ? formatUsdFromCents(Math.round(v.cents)) : "ratio" in v ? formatPercentRatio(v.ratio, 2) : v.text);

/**
 * The restatement log (lib/restatements.ts): figures that moved after the last month-end, what
 * each was then (as recorded that month, never worked out again) and is now, and what the audit
 * log says changed since. Each figure opens its proof, which says the same for that figure.
 */
export function Restatements({ api }: { api: Api }) {
  const [a, setA] = useState<Answer | null>(null);
  useEffect(() => {
    api
      .call<Answer>("/api/proof/restatements")
      .then(setA)
      .catch(() => setA(null));
  }, [api]);
  if (!a || !("monthEnd" in a)) return null;
  if (!a.monthEnd)
    return (
      <Card title="Moved since the month-end" subtitle="The restatement log starts with this month. From the next month-end on, every figure that moves after a month closes shows here: what it was then, what it is now, and what changed.">
        {null}
      </Card>
    );
  const month = monthLabel(a.monthEnd.month);
  return (
    <Card
      title={`Moved since the ${month} month-end`}
      subtitle={`Each figure as recorded when ${month} closed, never worked out again with what's known now. ${(a.compared ?? 0).toLocaleString()} figures compared.`}
    >
      {!a.movedCount ? (
        <p className="text-xs text-pos">No figure moved since the {month} month-end.</p>
      ) : (
        <>
          <p className="mb-2 text-xs text-fg-2">
            {a.movedCount.toLocaleString()} moved{a.why?.length ? `; since then: ${a.why.map((w) => `${w.count.toLocaleString()} ${w.words}`).join(", ")}` : "; the audit log records no change since, so a new version of the app worked them out differently"}.
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1 pr-3 font-medium">Figure</th>
                <th className="py-1 pr-3 text-right font-medium">At the month-end</th>
                <th className="py-1 text-right font-medium">Now</th>
              </tr>
            </thead>
            <tbody>
              {a.moved!.map((m, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="py-1 pr-3 text-fg-2">{m.describes ?? NA}</td>
                  <td className="num py-1 pr-3 text-right text-muted" data-not-figure="what the figure was at the month-end, as recorded then">
                    {text(m.was)}
                  </td>
                  <td className="num py-1 text-right">
                    <ProofValue proof={{ descriptor: m.descriptor, shownCents: "cents" in m.now ? m.now.cents : null, ...("cents" in m.now ? {} : { shown: m.now }) }}>{text(m.now)}</ProofValue>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {a.movedCount > (a.moved?.length ?? 0) && <p className="mt-1 text-xs text-muted">…and {(a.movedCount - (a.moved?.length ?? 0)).toLocaleString()} more, smaller moves.</p>}
        </>
      )}
    </Card>
  );
}
