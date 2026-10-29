"use client";

import { Badge, btn, Card, Drawer, table } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import type { CardPerksPage } from "@/lib/cardPerks/page";
import type { CardScore } from "@/lib/cardPerks/types";
import { formatUsdCents, usd0 } from "@/lib/formatMoney";
import { useState } from "react";
import { CardFace, fmtCpp, fmtDate, fmtMonth, fmtRate, fmtRewards, Meter, money, pct, SectionTitle, shortName, SourceTag } from "./parts";

const rowProof = (id: string, cents: number) => ({ descriptor: { report: "row" as const, rowId: id }, shownCents: cents });

function Verdict({ c }: { c: CardScore }) {
  if (c.program.kind === "NONE" && !c.fee.cents) return <Badge>No rewards</Badge>;
  if (!c.fee.cents) return <Badge tone={c.netCents > 0 ? "pos" : "neutral"}>No fee</Badge>;
  if (c.netCents >= 0) return <Badge tone="pos">Pays for itself</Badge>;
  return <Badge tone="neg">Short {usd0(-c.netCents)}</Badge>;
}

export function OverviewTab({ r, goCredits }: { r: CardPerksPage; goCredits: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const card = r.cards.find((c) => c.accountId === open);
  const now = r.act.filter((a) => !a.neverUsed);
  const unused = r.act.filter((a) => a.neverUsed);
  return (
    <>
      {r.act.length > 0 && (
        <Card
          tone="overview"
          title="Use before it resets"
          subtitle="Credits open right now on the cards you hold, soonest deadline first."
          actions={
            <button type="button" className={btn.link} onClick={goCredits}>
              All credits →
            </button>
          }
        >
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {now.map((a) => (
              <li key={`${a.accountId}|${a.perkId}`} className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2" title={a.how}>
                <div className={`num flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-md text-center leading-none ${a.daysLeft <= 7 ? "bg-neg-soft text-neg" : a.daysLeft <= 31 ? "bg-warn-soft text-warn" : "bg-surface-2 text-fg-2"}`}>
                  <span className="text-base font-semibold">{a.daysLeft}</span>
                  <span className="text-[9px] uppercase">day{a.daysLeft === 1 ? "" : "s"}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-fg">{a.name}</div>
                  <div className="truncate text-[11px] text-muted">
                    {a.card.replace(/ from American Express/, "")} · ends {fmtDate(a.ends)}
                  </div>
                </div>
                <span className="num text-sm font-semibold text-accent">{formatUsdCents(a.leftCents)}</span>
              </li>
            ))}
          </ul>
          {unused.length > 0 && (
            <p className="mt-2 text-[11px] text-muted">
              Also open, but unused all year: {unused.map((a) => `${a.name} (${formatUsdCents(a.leftCents)})`).join(" · ")}.
            </p>
          )}
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {r.cards.map((c) => (
          <CardTile key={c.accountId} c={c} onOpen={() => setOpen(c.accountId)} />
        ))}
      </div>
      {r.hidden.length > 0 && <p className="text-xs text-muted">Left off this page (Setup): {r.hidden.map((h) => h.accountName).join(", ")}.</p>}

      <Drawer open={!!card} onClose={() => setOpen(null)} title={card ? shortName(card) : ""} subtitle={card ? `${card.accountName} · ${r.year}` : undefined} width="40rem">
        {card && <CardDetail c={card} year={r.year} />}
      </Drawer>
    </>
  );
}

function CardTile({ c, onOpen }: { c: CardScore; onOpen: () => void }) {
  const gave = c.rewards.valueCents + c.perksValueCents + c.offersCents;
  const scale = Math.max(gave, c.fee.cents, 1);
  const seg = (v: number) => `${(v / scale) * 100}%`;
  const t = c.trailing;
  return (
    <section className={`flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-[var(--shadow)] ${c.held.open ? "" : "opacity-80"}`}>
      <div className="flex items-start gap-4">
        <div className="w-36 shrink-0">
          <CardFace c={c} />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Verdict c={c} />
            {!c.held.open && <Badge>Closed</Badge>}
            {c.held.open && !c.statementsInYear && <Badge title="No statement this year: the issuer sends none for a cycle without activity.">Idle this year</Badge>}
            {c.productSource === "UNKNOWN" && <Badge tone="warn" title="No catalog card matches the account name: pick one on Setup.">Pick the card on Setup</Badge>}
          </div>
          <div className={`num text-2xl font-semibold ${c.netCents > 0 ? "text-pos" : c.netCents < 0 ? "text-neg" : "text-muted"}`}>{money(c.netCents)}</div>
          <div className="text-[11px] text-muted">
            net in the year · {c.program.name}
            {c.program.kind === "POINTS" && ` at ${fmtCpp(c.centsPerPoint)}`}
          </div>
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-3" title="What it gave back">
          <div className="h-full bg-accent" style={{ width: seg(c.rewards.valueCents) }} />
          <div className="h-full bg-pos" style={{ width: seg(c.perksValueCents) }} />
          <div className="h-full bg-info" style={{ width: seg(c.offersCents) }} />
        </div>
        {c.fee.cents > 0 && (
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-surface-3" title="Annual fee">
            <div className="h-full bg-neg" style={{ width: seg(c.fee.cents) }} />
          </div>
        )}
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-accent" />
            Rewards {usd0(c.rewards.valueCents)}
          </span>
          {c.perksValueCents > 0 && (
            <span>
              <span className="mr-1 inline-block h-2 w-2 rounded-full bg-pos" />
              Perks {usd0(c.perksValueCents)}
            </span>
          )}
          {c.offersCents > 0 && (
            <span>
              <span className="mr-1 inline-block h-2 w-2 rounded-full bg-info" />
              Offers {usd0(c.offersCents)}
            </span>
          )}
          {c.fee.cents > 0 && (
            <span>
              <span className="mr-1 inline-block h-2 w-2 rounded-full bg-neg" />
              Fee {usd0(c.fee.cents)}
            </span>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <div>
          <dt className="text-muted">Rewards</dt>
          <dd className="num font-medium text-fg">{c.program.kind === "NONE" ? "—" : fmtRewards(c.rewards.kind, c.rewards.earned, true)}</dd>
          <dd>
            <SourceTag source={c.rewards.source} />
          </dd>
        </div>
        <div>
          <dt className="text-muted">Perk capture</dt>
          {c.captureRate == null ? (
            <dd className="text-faint">{c.perks.length ? "Nothing due yet" : "No perks"}</dd>
          ) : (
            <>
              <dd className="num font-medium text-fg">
                {pct(c.captureRate)} <span className="text-muted">· {money(c.perksValueCents)} used</span>
              </dd>
              <dd className="pt-1">
                <Meter used={c.captureRate} of={1} tone={c.captureRate >= 0.75 ? "pos" : c.captureRate >= 0.4 ? "warn" : "neg"} />
              </dd>
            </>
          )}
        </div>
        <div>
          <dt className="text-muted">Spending</dt>
          <dd className="num font-medium text-fg">{usd0(c.spend.netCents)}</dd>
        </div>
        <div>
          <dt className="text-muted">{c.rewards.balance ? "Balance on the statements" : "Annual fee"}</dt>
          <dd className="num font-medium text-fg">
            {c.rewards.balance ? fmtRewards(c.rewards.kind, c.rewards.balance.value, true) : c.fee.termsCents ? usd0(c.fee.termsCents) : "None"}
          </dd>
          {c.rewards.balance && <dd className="text-[11px] text-muted">as of {fmtDate(c.rewards.balance.date)}</dd>}
        </div>
      </dl>

      {t && (c.fee.termsCents > 0 || t.feeCents > 0) && (
        <p className={`rounded-md px-2.5 py-1.5 text-[11px] leading-relaxed ${t.valueCents >= t.feeCents ? "bg-pos-soft text-fg-2" : "bg-warn-soft text-fg-2"}`}>
          <span className="font-semibold">{t.valueCents >= t.feeCents ? "Worth keeping" : "Worth a second look"}:</span> in the 12 months to {fmtDate(t.to)} it gave{" "}
          <span className="num font-semibold">{usd0(t.valueCents)}</span> for a <span className="num font-semibold">{usd0(t.feeCents || c.fee.termsCents)}</span> fee.
          {c.fee.nextDue && ` Next fee around ${fmtMonth(c.fee.nextDue)}.`}
        </p>
      )}

      <button type="button" className={`${btn.secondary} mt-auto self-start`} onClick={onOpen}>
        Details
      </button>
    </section>
  );
}

function CardDetail({ c, year }: { c: CardScore; year: number }) {
  const kind = c.rewards.kind;
  return (
    <div className="space-y-5 text-sm">
      <div className="flex items-start gap-4">
        <div className="w-40 shrink-0">
          <CardFace c={c} />
        </div>
        <ul className="space-y-1 text-xs text-fg-2">
          <li>
            {c.product ? c.product.name : "Not in the card list"} {c.productSource === "AUTO" && <span className="text-muted">(from the account name)</span>}
          </li>
          <li>
            Statements {fmtDate(c.held.from)} to {fmtDate(c.held.through)}
            {!c.held.open && " · closed"}
          </li>
          <li>{c.program.statementNote}</li>
          {c.product?.note && <li className="text-muted">{c.product.note}</li>}
        </ul>
      </div>

      {c.program.kind !== "NONE" && (
        <div>
          <SectionTitle aside={<SourceTag source={c.rewards.source} />}>Rewards in {year}</SectionTitle>
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr className={table.head}>
                  <th className={table.th}>Earned on</th>
                  <th className={table.thR}>Rate</th>
                  <th className={table.thR}>Spending</th>
                  <th className={table.thR}>Expected</th>
                </tr>
              </thead>
              <tbody>
                {c.earn.map((l) => (
                  <tr key={l.label} className={table.tr}>
                    <td className={table.td}>{l.label}</td>
                    <td className={table.tdR}>{fmtRate(kind, l.rate)}</td>
                    <td className={table.tdR}>{usd0(l.spendCents)}</td>
                    <td className={table.tdR}>{fmtRewards(kind, l.units)}</td>
                  </tr>
                ))}
                <tr className="border-t border-line-strong font-medium">
                  <td className={table.td} colSpan={3}>
                    Expected from spending
                  </td>
                  <td className={table.tdR}>{fmtRewards(kind, c.rewards.expected)}</td>
                </tr>
                <tr className="font-semibold">
                  <td className={table.td} colSpan={3}>
                    Earned (statements where they print it)
                  </td>
                  <td className={table.tdR}>{fmtRewards(kind, c.rewards.earned)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {c.hiddenEarn.length > 0 && <p className="mt-1.5 text-[11px] text-muted">Not visible on a statement line: {c.hiddenEarn.join(", ")}. The printed balances catch them.</p>}
          {c.rewards.redeemedCents > 0 && <p className="mt-1 text-[11px] text-muted">Cashed in as statement credits this year: {formatUsdCents(c.rewards.redeemedCents)} (already counted when earned).</p>}
        </div>
      )}

      {c.perks.length > 0 && (
        <div>
          <SectionTitle>Perks</SectionTitle>
          <ul className="divide-y divide-line rounded-md border border-line">
            {c.perks.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-fg">{p.name}</div>
                  <div className="text-[11px] text-muted">{p.how}</div>
                </div>
                <div className="w-28 shrink-0 text-right">
                  <div className="num text-xs">
                    {formatUsdCents(p.usedCents)} <span className="text-muted">/ {usd0(p.allowanceCents)}</span>
                  </div>
                  <Meter used={p.usedCents} of={p.allowanceCents} tone={p.missedCents > 0 ? (p.usedCents > 0 ? "warn" : "neg") : "pos"} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(c.credits.some((x) => x.kind !== "PERK") || c.fee.rows.length > 0) && (
        <div>
          <SectionTitle>Fees, offers and cashed-in rewards</SectionTitle>
          <ul className="space-y-1 text-xs">
            {c.fee.rows.map((f) => (
              <li key={f.id} className="flex justify-between gap-3">
                <span className="text-fg-2">
                  <span className="num text-muted">{f.date}</span> {f.amountCents < 0 ? "Annual fee" : "Annual fee reversed"}
                </span>
                <ProofValue proof={rowProof(f.id, f.amountCents)} className="num">
                  {formatUsdCents(f.amountCents)}
                </ProofValue>
              </li>
            ))}
            {c.credits
              .filter((x) => x.kind === "OFFER" || x.kind === "REDEMPTION")
              .map((x) => (
                <li key={x.id} className="flex justify-between gap-3">
                  <span className="min-w-0 truncate text-fg-2" title={x.payee}>
                    <span className="num text-muted">{x.date}</span> {x.payee}{" "}
                    <span className="text-[10px] uppercase text-muted">{x.kind === "OFFER" ? "offer / bonus" : "rewards cashed in"}</span>
                  </span>
                  <ProofValue proof={rowProof(x.id, x.amountCents)} className={`num shrink-0 ${x.kind === "REDEMPTION" ? "text-muted" : ""}`}>
                    {formatUsdCents(x.amountCents)}
                  </ProofValue>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
