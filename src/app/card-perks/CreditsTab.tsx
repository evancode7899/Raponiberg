"use client";

import { Badge, Card, Drawer } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { CADENCE_INFO } from "@/lib/cardPerks/catalog";
import type { CardPerksPage } from "@/lib/cardPerks/page";
import type { CardScore, PerkLine, PerkPeriod, PeriodStatus } from "@/lib/cardPerks/types";
import { formatUsdCents, usd0 } from "@/lib/formatMoney";
import { useState } from "react";
import { CardFace, fmtDate, Meter, money, shortName, STATUS } from "./parts";

const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const KEY: PeriodStatus[] = ["USED", "PARTIAL", "MISSED", "OPEN", "AWAITING", "FUTURE"];
const HOW = {
  CREDIT: "Found by its statement credit",
  MERCHANT: "Found by the merchant's credit",
  SPEND: "Inferred from a charge",
} as const;

type Focus = { accountId: string; perkId: string; period: string };

export function CreditsTab({ r }: { r: CardPerksPage }) {
  const [focus, setFocus] = useState<Focus | null>(null);
  const card = r.cards.find((c) => c.accountId === focus?.accountId);
  const perk = card?.perks.find((p) => p.id === focus?.perkId);
  const withPerks = r.cards.filter((c) => c.perks.length);
  return (
    <>
      {withPerks.map((c) => (
        <PerkGrid key={c.accountId} c={c} onPick={(perkId, period) => setFocus({ accountId: c.accountId, perkId, period })} focus={focus} />
      ))}
      {!withPerks.length && <p className="text-sm text-muted">None of the cards held in {r.year} has recurring credits.</p>}
      {withPerks.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
          {KEY.map((s) => (
            <span key={s} className="flex items-center gap-1" title={STATUS[s].hint}>
              <span className={`inline-block h-2.5 w-4 rounded-sm border ${STATUS[s].cls}`} />
              {STATUS[s].label}
            </span>
          ))}
          <span>· Every period is read from the statements: credits by their description or merchant, in-app credits (Uber Cash) by a household charge there that month.</span>
        </div>
      )}
      <Drawer open={!!perk && !!card} onClose={() => setFocus(null)} title={perk?.name ?? ""} subtitle={card ? `${shortName(card)} · ${r.year}` : undefined} width="36rem">
        {perk && card && focus && <PerkDetail c={card} perk={perk} focus={focus.period} accounts={r.cards} />}
      </Drawer>
    </>
  );
}

function PerkGrid({ c, onPick, focus }: { c: CardScore; onPick: (perkId: string, period: string) => void; focus: Focus | null }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-2.5">
          <CardFace c={c} small />
          <span>{shortName(c)}</span>
          {!c.held.open && <Badge>Closed</Badge>}
        </span>
      }
      subtitle={`${c.accountName} · ${money(c.perksValueCents)} of ${usd0(c.perksAllowanceCents)} used${c.missedCents ? ` · ${usd0(c.missedCents)} let lapse` : ""}${c.remainingCents ? ` · ${usd0(c.remainingCents)} still to come` : ""}`}
    >
      <div className="overflow-x-auto">
        <div className="grid min-w-[46rem] items-center gap-x-1 gap-y-1.5" style={{ gridTemplateColumns: "minmax(11rem,15rem) repeat(12,minmax(2.25rem,1fr)) 6.5rem" }}>
          <div />
          {MONTHS.map((m, i) => (
            <div key={i} className="text-center text-[10px] font-semibold uppercase text-faint">
              {m}
            </div>
          ))}
          <div className="text-right text-[10px] font-semibold uppercase text-faint">Used</div>
          {c.perks.map((p) => (
            <PerkRowCells key={p.id} p={p} onPick={(period) => onPick(p.id, period)} focus={focus?.accountId === c.accountId && focus.perkId === p.id ? focus.period : null} />
          ))}
        </div>
      </div>
    </Card>
  );
}

function cellText(p: PerkLine, x: PerkPeriod): string {
  if (x.status === "USED") return p.detection === "IN_APP" ? "✓" : usd0(x.usedCents);
  if (x.status === "PARTIAL") return usd0(x.usedCents);
  if (x.status === "OPEN") return usd0(x.allowanceCents - x.usedCents);
  if (x.status === "MISSED") return "✕";
  if (x.status === "AWAITING") return "…";
  return "";
}

function PerkRowCells({ p, onPick, focus }: { p: PerkLine; onPick: (period: string) => void; focus: string | null }) {
  const span = CADENCE_INFO[p.cadence].months;
  return (
    <>
      <div className={`min-w-0 pr-2 ${p.neverUsed ? "opacity-60" : ""}`}>
        <div className="truncate text-[13px] font-medium text-fg" title={p.how}>
          {p.name}
        </div>
        <div className="truncate text-[11px] text-muted">
          {usd0(p.amountCents)} {CADENCE_INFO[p.cadence].label.toLowerCase()} · {p.detection === "IN_APP" ? "inferred from charges" : "statement credit"}
          {p.neverUsed && " · not used this year"}
        </div>
      </div>
      {p.periods.map((x) => (
        <button
          key={x.key}
          type="button"
          onClick={() => onPick(x.key)}
          style={{ gridColumn: `span ${span}` }}
          title={`${x.label}: ${STATUS[x.status].label}${x.usedCents ? ` · ${formatUsdCents(x.usedCents)} of ${formatUsdCents(x.allowanceCents)}` : ` · ${formatUsdCents(x.allowanceCents)}`}${x.unmatchedSpend ? ` · ${x.unmatchedSpend} charge(s) at its merchants got no credit` : ""}`}
          className={`num relative h-8 rounded-md border text-[11px] font-semibold outline-none transition hover:brightness-95 focus-visible:ring-2 focus-visible:ring-focus ${STATUS[x.status].cls} ${p.neverUsed && x.status === "MISSED" ? "opacity-50" : ""} ${focus === x.key ? "ring-2 ring-focus" : ""}`}
        >
          {span > 1 && x.status !== "NOT_OFFERED" && x.status !== "NOT_HELD" ? <span className="mr-1 font-normal opacity-70">{x.label}</span> : null}
          {cellText(p, x)}
          {x.unmatchedSpend > 0 && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-warn" aria-hidden />}
        </button>
      ))}
      <div className="pl-2 text-right">
        <div className="num text-xs font-medium">{usd0(p.usedCents)}</div>
        <Meter used={p.usedCents} of={p.allowanceCents} tone={p.missedCents > 0 ? (p.usedCents > 0 ? "warn" : "neg") : "pos"} />
      </div>
    </>
  );
}

function PerkDetail({ c, perk, focus, accounts }: { c: CardScore; perk: PerkLine; focus: string; accounts: CardScore[] }) {
  const nameOf = (id: string) => {
    const a = accounts.find((x) => x.accountId === id);
    return a ? shortName(a) : "another account";
  };
  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-muted">
        {formatUsdCents(perk.amountCents)} {CADENCE_INFO[perk.cadence].label.toLowerCase()}. {perk.how}{" "}
        {perk.detection === "IN_APP"
          ? "It never shows on a statement, so a month counts as used when the household paid that merchant (on any card) that month: each charge covers one card's credit."
          : "Counted from the statement credit the issuer posts, in the period of the charge it pays back."}
      </p>
      <ul className="divide-y divide-line">
        {perk.periods
          .filter((x) => x.status !== "NOT_OFFERED")
          .map((x) => (
            <li key={x.key} className={`space-y-1.5 py-2.5 ${x.key === focus ? "-mx-2 rounded-md bg-surface-2 px-2" : ""}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="w-16 text-sm font-medium text-fg">{x.label}</span>
                  <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${STATUS[x.status].cls}`} title={STATUS[x.status].hint}>
                    {STATUS[x.status].label}
                  </span>
                </div>
                <span className="num text-xs text-fg-2">
                  {x.usedCents ? formatUsdCents(x.usedCents) : "$0"} <span className="text-muted">of {formatUsdCents(x.allowanceCents)}</span>
                </span>
              </div>
              {x.evidence.length > 0 && (
                <ul className="space-y-0.5 pl-[4.5rem] text-[11px] text-muted">
                  {x.evidence.map((e) => (
                    <li key={e.rowId} className="flex justify-between gap-2">
                      <span className="min-w-0 truncate" title={HOW[e.kind]}>
                        <span className="num">{e.date}</span> {e.payee}
                        {e.accountId !== c.accountId && <span className="text-faint"> · on {nameOf(e.accountId)}</span>}
                      </span>
                      <ProofValue proof={{ descriptor: { report: "row", rowId: e.rowId }, shownCents: e.amountCents }} className="num shrink-0">
                        {formatUsdCents(e.amountCents)}
                      </ProofValue>
                    </li>
                  ))}
                </ul>
              )}
              {x.unmatchedSpend > 0 && (
                <p className="pl-[4.5rem] text-[11px] text-warn">
                  {x.unmatchedSpend} charge{x.unmatchedSpend === 1 ? "" : "s"} at its merchants this period got no credit: check the benefit is enrolled.
                </p>
              )}
              {x.status === "OPEN" && <p className="pl-[4.5rem] text-[11px] text-accent">Open until {fmtDate(x.end)}.</p>}
            </li>
          ))}
      </ul>
    </div>
  );
}
