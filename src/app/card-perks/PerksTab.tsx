"use client";

import { btn, Card, Drawer, table } from "@/components/ui/kit";
import { CADENCE_INFO } from "@/lib/cardPerks/catalog";
import type { CardPerksPage } from "@/lib/cardPerks/page";
import type { CardScore, PerkLine, PeriodStatus } from "@/lib/cardPerks/report";
import { usageKey, type CardPerksSettings } from "@/lib/cardPerks/settings";
import { formatUsdCents } from "@/lib/formatMoney";
import { useState } from "react";
import { fmtAmount, Meter, NumberInput, STATUS, type Save } from "./parts";

const LEGEND: PeriodStatus[] = ["USED", "PARTIAL", "MISSED", "OPEN", "AWAITING", "FUTURE", "NOT_HELD"];

export function PerksTab({ r, settings, save }: { r: CardPerksPage; settings: CardPerksSettings; save: Save }) {
  const [open, setOpen] = useState<{ accountId: string; perkId: string; period: string } | null>(null);
  const card = open ? r.cards.find((c) => c.accountId === open.accountId) : undefined;
  const perk = card?.perks.find((p) => p.id === open?.perkId);
  const withPerks = r.cards.filter((c) => c.perks.length);
  return (
    <>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
        {LEGEND.map((s) => (
          <span key={s} className="flex items-center gap-1">
            <span className={`inline-block h-2.5 w-4 rounded-sm border ${STATUS[s].cls}`} />
            {STATUS[s].label}
          </span>
        ))}
        <span>· Click a period to see its credits or mark a use by hand</span>
      </div>
      {withPerks.map((c) => (
        <Card key={c.accountId} title={c.setup.name} subtitle={`${c.accountName} · statements through ${c.through ?? "?"}`}>
          <div className={table.wrap}>
            <table className={table.table} style={{ minWidth: "48rem" }}>
              <thead>
                <tr className={table.head}>
                  <th className={table.th}>Perk</th>
                  <th className={table.thR}>Each period</th>
                  <th className={table.th}>Periods in {r.year}</th>
                  <th className={table.thR}>Used</th>
                  <th className={table.thR}>Left</th>
                </tr>
              </thead>
              <tbody>
                {c.perks.map((p) => (
                  <tr key={p.id} className={table.tr}>
                    <td className={table.td}>
                      <div className="font-medium text-fg">{p.name}</div>
                      <div className="text-[11px] text-muted">
                        {CADENCE_INFO[p.cadence].label}
                        {!p.pattern && p.unit === "USD" && " · marked by hand"}
                        {p.patternError && <span className="text-neg"> · pattern isn&apos;t valid</span>}
                      </div>
                    </td>
                    <td className={table.tdR}>{fmtAmount(p.unit, p.amount)}</td>
                    <td className={table.td}>
                      <div className="flex flex-wrap gap-1">
                        {p.periods.map((x) => (
                          <button
                            key={x.key}
                            type="button"
                            onClick={() => setOpen({ accountId: c.accountId, perkId: p.id, period: x.key })}
                            title={`${x.label}: ${STATUS[x.status].label}${x.used ? ` · ${fmtAmount(p.unit, x.used)}` : ""}${x.source === "MANUAL" ? " (marked by hand)" : ""}`}
                            className={`num min-w-9 rounded border px-1.5 py-0.5 text-[10px] font-semibold outline-none hover:brightness-95 focus-visible:ring-2 focus-visible:ring-focus ${STATUS[x.status].cls}`}
                          >
                            {x.label}
                            {x.source === "MANUAL" && <span aria-hidden> ✎</span>}
                          </button>
                        ))}
                      </div>
                    </td>
                    <td className={`${table.tdR} w-36`}>
                      <div>{fmtAmount(p.unit, p.used)}</div>
                      <Meter used={p.used} of={p.allowance} tone={p.missed > 0 ? (p.used > 0 ? "warn" : "neg") : "pos"} />
                    </td>
                    <td className={`${table.tdR} ${p.remaining ? "text-accent" : "text-faint"}`}>{p.remaining ? fmtAmount(p.unit, p.remaining) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
      {!withPerks.length && <p className="text-sm text-muted">None of the cards have perks set up. Pick each card&apos;s product on Setup, or add perks by hand.</p>}

      <Drawer open={!!perk && !!card} onClose={() => setOpen(null)} title={perk?.name ?? ""} subtitle={card ? `${card.setup.name} · ${r.year}` : undefined} width="34rem">
        {perk && card && open && <PerkDetail card={card} perk={perk} focus={open.period} settings={settings} save={save} />}
      </Drawer>
    </>
  );
}

function PerkDetail({ card, perk, focus, settings, save }: { card: CardScore; perk: PerkLine; focus: string; settings: CardPerksSettings; save: Save }) {
  const mark = (period: string, v: number | null) => {
    const usage = { ...settings.usage };
    const k = usageKey(card.accountId, perk.id, period);
    if (v == null) delete usage[k];
    else usage[k] = Math.round(v);
    void save({ ...settings, usage });
  };
  const creditsById = new Map(card.credits.map((c) => [c.id, c]));
  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-muted">
        {fmtAmount(perk.unit, perk.amount)} {CADENCE_INFO[perk.cadence].label.toLowerCase()}.{" "}
        {perk.pattern ? (
          <>
            Statement credits matching <code className="rounded bg-surface-2 px-1">{perk.pattern}</code> count automatically.
          </>
        ) : (
          "This one never shows on a statement, so mark each period you used it."
        )}{" "}
        {perk.note}
      </p>
      <ul className="divide-y divide-line">
        {perk.periods.map((x) => (
          <li key={x.key} className={`space-y-1.5 py-2.5 ${x.key === focus ? "-mx-2 rounded-md bg-surface-2 px-2" : ""}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="w-16 text-sm font-medium text-fg">{x.label}</span>
                <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${STATUS[x.status].cls}`}>{STATUS[x.status].label}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <NumberInput
                  className="w-28"
                  value={x.source === "MANUAL" ? x.used : null}
                  onChange={(v) => mark(x.key, v)}
                  scale={perk.unit === "USD" ? 100 : 1}
                  prefix={perk.unit === "USD" ? "$" : undefined}
                  suffix={perk.unit === "POINTS" ? "pts" : undefined}
                  placeholder={x.detected ? String(perk.unit === "USD" ? x.detected / 100 : x.detected) : "—"}
                  ariaLabel={`${perk.name} used in ${x.label}`}
                />
                <button type="button" className={btn.secondary} onClick={() => mark(x.key, perk.amount)} disabled={x.source === "MANUAL" && x.used === perk.amount}>
                  Used
                </button>
                <button type="button" className={btn.ghost} onClick={() => mark(x.key, 0)} disabled={x.source === "MANUAL" && x.used === 0}>
                  Not used
                </button>
                {x.source === "MANUAL" && (
                  <button type="button" className={btn.link} onClick={() => mark(x.key, null)} title="Forget the use marked by hand and go by the statements">
                    Reset
                  </button>
                )}
              </div>
            </div>
            {x.rowIds.length > 0 && (
              <ul className="space-y-0.5 pl-[4.5rem] text-[11px] text-muted">
                {x.rowIds.map((id) => {
                  const c = creditsById.get(id);
                  return c ? (
                    <li key={id} className="flex justify-between gap-2">
                      <span className="truncate">
                        <span className="num">{c.date}</span> {c.payee}
                      </span>
                      <span className="num shrink-0">{formatUsdCents(c.amountCents)}</span>
                    </li>
                  ) : null;
                })}
                {x.source === "MANUAL" && <li className="text-warn">Your mark replaces these statement credits for this period.</li>}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
