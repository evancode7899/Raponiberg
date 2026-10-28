"use client";

import { Badge, btn, Card, table } from "@/components/ui/kit";
import type { CardPerksPage } from "@/lib/cardPerks/page";
import type { CardScore } from "@/lib/cardPerks/report";
import { pointsKey, type CardPerksSettings } from "@/lib/cardPerks/settings";
import { formatUsdCents, usd0 } from "@/lib/formatMoney";
import { fmtAmount, fmtCpp, fmtPoints, Meter, NumberInput, type Save } from "./parts";

const FEE_SOURCE = { STATEMENTS: "charged on the statements", TERMS: "the card's fee (none charged on file this year)", NONE: "no annual fee" } as const;

function Verdict({ c }: { c: CardScore }) {
  if (c.fee.cents === 0) return <Badge tone={c.netCents > 0 ? "pos" : "neutral"}>No fee</Badge>;
  if (c.netCents >= 0) return <Badge tone="pos">Pays for itself</Badge>;
  return <Badge tone="neg">Short {usd0(-c.netCents)}</Badge>;
}

export function ScorecardTab({ r, settings, save, goPerks }: { r: CardPerksPage; settings: CardPerksSettings; save: Save; goPerks: () => void }) {
  const t = r.totals;
  return (
    <>
      <Card title="Scorecard" subtitle={`What each card cost in ${r.year} and what it gave back. Net value = points value + credits used − annual fee.`}>
        <div className={table.wrap}>
          <table className={table.table} style={{ minWidth: "52rem" }}>
            <thead>
              <tr className={table.head}>
                <th className={table.th}>Card</th>
                <th className={table.thR}>Spending</th>
                <th className={table.thR}>Points earned</th>
                <th className={table.thR}>Points value</th>
                <th className={table.thR}>Credits used</th>
                <th className={table.thR}>Annual fee</th>
                <th className={table.thR}>Net value</th>
                <th className={table.th} />
              </tr>
            </thead>
            <tbody>
              {r.cards.map((c) => (
                <tr key={c.accountId} className={table.tr}>
                  <td className={table.td}>
                    <div className="font-medium text-fg">{c.setup.name}</div>
                    <div className="text-[11px] text-muted">{c.accountName}</div>
                  </td>
                  <td className={table.tdR}>{usd0(c.spend.netCents)}</td>
                  <td className={table.tdR} title={c.points.entered == null ? "Estimated from spending" : "As entered"}>
                    {fmtPoints(c.points.earned)}
                    {c.points.entered == null && <span className="text-faint"> est.</span>}
                  </td>
                  <td className={table.tdR}>{usd0(c.points.valueCents)}</td>
                  <td className={table.tdR}>{usd0(c.creditsCents)}</td>
                  <td className={table.tdR}>{c.fee.cents ? `−${usd0(c.fee.cents)}` : "—"}</td>
                  <td className={`${table.tdR} font-semibold ${c.netCents >= 0 ? "text-pos" : "text-neg"}`}>{usd0(c.netCents)}</td>
                  <td className={table.td}>
                    <Verdict c={c} />
                  </td>
                </tr>
              ))}
              {r.cards.length > 1 && (
                <tr className="border-t-[3px] border-double border-line-strong font-semibold">
                  <td className={table.td}>All cards</td>
                  <td className={table.tdR}>{usd0(t.spendCents)}</td>
                  <td className={table.tdR}>{fmtPoints(t.points)}</td>
                  <td className={table.tdR}>{usd0(t.pointsValueCents)}</td>
                  <td className={table.tdR}>{usd0(t.creditsCents)}</td>
                  <td className={table.tdR}>{t.feesCents ? `−${usd0(t.feesCents)}` : "—"}</td>
                  <td className={`${table.tdR} ${t.netCents >= 0 ? "text-pos" : "text-neg"}`}>{usd0(t.netCents)}</td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {r.cards.map((c) => (
        <CardDetail key={c.accountId} c={c} year={r.year} settings={settings} save={save} goPerks={goPerks} />
      ))}
    </>
  );
}

function CardDetail({ c, year, settings, save, goPerks }: { c: CardScore; year: number; settings: CardPerksSettings; save: Save; goPerks: () => void }) {
  const value = c.returnedCents;
  const scale = Math.max(value, c.fee.cents, 1);
  const credits = c.creditsCents;
  const setPoints = (n: number | null) => {
    const pointsEarned = { ...settings.pointsEarned };
    if (n == null) delete pointsEarned[pointsKey(c.accountId, year)];
    else pointsEarned[pointsKey(c.accountId, year)] = Math.round(n);
    void save({ ...settings, pointsEarned });
  };
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {c.setup.name} <Verdict c={c} />
          {c.guessed && (
            <Badge tone="info" title="No setup saved for this card: the catalog card its name suggests is used. Confirm or change it on Setup.">
              {c.setup.productId ? "Suggested" : "Not set up"}
            </Badge>
          )}
        </span>
      }
      subtitle={`${c.accountName} · statements ${c.from ?? "?"} to ${c.through ?? "?"}`}
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between text-xs">
              <span className="font-medium text-fg-2">What it gave back</span>
              <span className="num font-semibold text-fg">{usd0(value)}</span>
            </div>
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-3">
              <div className="h-full bg-accent" style={{ width: `${(c.points.valueCents / scale) * 100}%` }} title={`Points ${usd0(c.points.valueCents)}`} />
              <div className="h-full bg-pos" style={{ width: `${(credits / scale) * 100}%` }} title={`Credits ${usd0(credits)}`} />
            </div>
            <div className="flex items-baseline justify-between text-xs">
              <span className="font-medium text-fg-2">What it cost</span>
              <span className="num font-semibold text-fg">{usd0(c.fee.cents)}</span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-full bg-surface-3">
              <div className="h-full bg-neg" style={{ width: `${(c.fee.cents / scale) * 100}%` }} />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
              <span>
                <span className="mr-1 inline-block h-2 w-2 rounded-full bg-accent" />
                Points {usd0(c.points.valueCents)}
              </span>
              <span>
                <span className="mr-1 inline-block h-2 w-2 rounded-full bg-pos" />
                Credits {usd0(credits)}
              </span>
              <span>
                <span className="mr-1 inline-block h-2 w-2 rounded-full bg-neg" />
                Fee: {FEE_SOURCE[c.fee.source]}
              </span>
            </div>
            {c.fee.cents > 0 && (
              <p className="text-xs text-fg-2">
                Credits alone cover <span className="num font-semibold">{Math.round((credits / c.fee.cents) * 100)}%</span> of the fee
                {c.remainingCents > 0 && (
                  <>
                    ; <span className="num font-semibold">{usd0(c.remainingCents)}</span> more is still available this year
                  </>
                )}
                .
              </p>
            )}
          </div>

          <div>
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Points on spending</h3>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr className={table.head}>
                    <th className={table.th}>Category</th>
                    <th className={table.thR}>Rate</th>
                    <th className={table.thR}>Spending</th>
                    <th className={table.thR}>Points</th>
                  </tr>
                </thead>
                <tbody>
                  {c.earn.map((l) => (
                    <tr key={l.label} className={table.tr}>
                      <td className={table.td}>{l.label}</td>
                      <td className={table.tdR}>{+l.rate.toFixed(2)}×</td>
                      <td className={table.tdR}>{usd0(l.spendCents)}</td>
                      <td className={table.tdR}>{l.points.toLocaleString("en-US")}</td>
                    </tr>
                  ))}
                  {!c.earn.length && (
                    <tr className={table.tr}>
                      <td className={`${table.td} text-muted`} colSpan={4}>
                        No spending on this card in {year}.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>Points actually posted in {year}:</span>
              <NumberInput
                className="w-32"
                value={c.points.entered}
                onChange={setPoints}
                suffix="pts"
                placeholder={c.points.estimated.toLocaleString("en-US")}
                ariaLabel={`Points posted on ${c.setup.name} in ${year}`}
              />
              <span>
                {c.points.entered == null ? "blank uses the estimate" : `estimate was ${fmtPoints(c.points.estimated)}`} · worth {fmtCpp(c.centsPerPoint)} each
              </span>
            </div>
          </div>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Perks used</h3>
            {c.perks.length > 0 && (
              <button type="button" className={btn.link} onClick={goPerks}>
                Track by period →
              </button>
            )}
          </div>
          {c.perks.length ? (
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr className={table.head}>
                    <th className={table.th}>Perk</th>
                    <th className={table.thR}>Used</th>
                    <th className={table.thR}>Of</th>
                    <th className={table.th}>Utilization</th>
                    <th className={table.thR}>Missed</th>
                  </tr>
                </thead>
                <tbody>
                  {c.perks.map((p) => (
                    <tr key={p.id} className={table.tr}>
                      <td className={table.td}>{p.name}</td>
                      <td className={table.tdR}>{fmtAmount(p.unit, p.used)}</td>
                      <td className={`${table.tdR} text-muted`}>{fmtAmount(p.unit, p.allowance)}</td>
                      <td className={`${table.td} w-24`}>
                        <Meter used={p.used} of={p.allowance} tone={p.missed > 0 ? (p.used > 0 ? "warn" : "neg") : "pos"} />
                      </td>
                      <td className={`${table.tdR} ${p.missed ? "text-neg" : "text-faint"}`}>{p.missed ? fmtAmount(p.unit, p.missed) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-muted">No recurring perks set up for this card. Add them on Setup.</p>
          )}
          {c.credits.some((x) => x.kind !== "PERK") && (
            <div className="mt-3 space-y-1">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Other statement credits</h3>
              <ul className="space-y-0.5 text-xs">
                {c.credits
                  .filter((x) => x.kind !== "PERK")
                  .map((x) => (
                    <li key={x.id} className="flex justify-between gap-3">
                      <span className="min-w-0 truncate text-fg-2" title={x.payee}>
                        <span className="num text-muted">{x.date}</span> {x.payee}
                      </span>
                      <span className={`num shrink-0 ${x.kind === "REDEMPTION" ? "text-faint" : "text-fg"}`} title={x.kind === "REDEMPTION" ? "Points cashed in: already counted as points, so not added again" : "Counted as value"}>
                        {formatUsdCents(x.amountCents)}
                        {x.kind === "REDEMPTION" && " (redeemed)"}
                      </span>
                    </li>
                  ))}
              </ul>
              <p className="text-[11px] text-muted">If one of these is a perk, add a pattern that matches it on Setup.</p>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
