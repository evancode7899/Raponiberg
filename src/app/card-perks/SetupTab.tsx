"use client";

import { btn, Card, Field, inputCls, selectCls, table } from "@/components/ui/kit";
import { CARD_PRODUCTS, CATALOG_AS_OF, guessProduct, PROGRAMS, type ProgramId } from "@/lib/cardPerks/catalog";
import type { CardPerksPage } from "@/lib/cardPerks/page";
import type { CardPerksSettings } from "@/lib/cardPerks/settings";
import { usd0 } from "@/lib/formatMoney";
import { useState } from "react";
import type { Save } from "./CardPerksClient";
import { CardFace, fmtCpp, shortName } from "./parts";

const POINT_PROGRAMS = (Object.keys(PROGRAMS) as ProgramId[]).filter((id) => PROGRAMS[id].kind === "POINTS");

export function SetupTab({ r, settings, save }: { r: CardPerksPage; settings: CardPerksSettings; save: Save }) {
  const [f, setF] = useState(settings);
  const [seen, setSeen] = useState(settings);
  if (seen !== settings) {
    setSeen(settings);
    setF(settings);
  }
  const dirty = JSON.stringify(f) !== JSON.stringify(settings);
  const setCard = (id: string, change: Partial<{ productId: string | null; hidden: boolean }>) =>
    setF((x) => {
      const cur = x.cards[id] ?? { productId: null, hidden: false };
      const next = { ...cur, ...change };
      const cards = { ...x.cards };
      if (!next.productId && !next.hidden) delete cards[id];
      else cards[id] = next;
      return { ...x, cards };
    });
  const rows = [...r.cards.map((c) => ({ id: c.accountId, name: c.accountName, card: c })), ...r.hidden.map((h) => ({ id: h.accountId, name: h.accountName, card: undefined }))];
  const used = new Set(r.cards.map((c) => c.program.id));
  const saveButton = (
    <button type="button" className={btn.primary} disabled={!dirty} onClick={() => void save(f)}>
      Save
    </button>
  );
  return (
    <>
      <Card
        title="Which card is which"
        subtitle={`Each account is matched to a card from its name. Fees, rates and credits come from the card list (checked ${CATALOG_AS_OF}); everything used, earned or missed comes from the statements, so there's nothing to mark here.`}
        actions={saveButton}
      >
        <div className={table.wrap}>
          <table className={table.table} style={{ minWidth: "40rem" }}>
            <thead>
              <tr className={table.head}>
                <th className={table.th}>Account</th>
                <th className={table.th}>Card</th>
                <th className={table.thR}>Fee</th>
                <th className={table.th}>Show</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const choice = f.cards[row.id];
                const auto = guessProduct({ name: row.name, institution: row.card?.product?.issuer ?? null }) ?? (row.card?.productSource === "AUTO" ? row.card.product : null);
                const product = choice?.productId === "none" ? null : (CARD_PRODUCTS.find((p) => p.id === choice?.productId) ?? auto);
                return (
                  <tr key={row.id} className={table.tr}>
                    <td className={table.td}>
                      <div className="flex items-center gap-2.5">
                        {row.card && <CardFace c={row.card} small />}
                        <span className="font-medium text-fg">{row.name}</span>
                      </div>
                    </td>
                    <td className={table.td}>
                      <select
                        className={`${selectCls} w-full`}
                        value={choice?.productId ?? ""}
                        onChange={(e) => setCard(row.id, { productId: e.target.value || null })}
                        aria-label={`Card for ${row.name}`}
                      >
                        <option value="">{auto ? `${auto.name} (from the account name)` : "Not recognized: pick one"}</option>
                        {CARD_PRODUCTS.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                        <option value="none">Not in this list (no perks or rewards counted)</option>
                      </select>
                    </td>
                    <td className={`${table.tdR} text-muted`}>{product ? (product.annualFeeCents ? usd0(product.annualFeeCents) : "None") : "—"}</td>
                    <td className={table.td}>
                      <label className="flex items-center gap-1.5 text-xs text-fg-2">
                        <input type="checkbox" checked={!(choice?.hidden ?? false)} onChange={(e) => setCard(row.id, { hidden: !e.target.checked })} />
                        On the page
                      </label>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="What a point is worth"
        subtitle="Cents per point, used to value points next to cash back and to pick the best card. 1¢ is what most programs pay as cash or travel booked through the issuer; transfer partners can be worth more."
        actions={saveButton}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {POINT_PROGRAMS.filter((id) => used.has(id) || f.pointValues[id] != null).map((id) => (
            <Field key={id} label={PROGRAMS[id].name} hint={`Default ${fmtCpp(PROGRAMS[id].defaultCentsPerPoint)}.`}>
              <div className="flex items-center gap-1">
                <input
                  className={`${inputCls} num w-24 py-1 text-right text-xs`}
                  inputMode="decimal"
                  value={f.pointValues[id] ?? ""}
                  placeholder={String(PROGRAMS[id].defaultCentsPerPoint)}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    const n = Number(v);
                    setF((x) => {
                      const pointValues = { ...x.pointValues };
                      if (!v || !Number.isFinite(n) || n < 0) delete pointValues[id];
                      else pointValues[id] = n;
                      return { ...x, pointValues };
                    });
                  }}
                  aria-label={`Cents per ${PROGRAMS[id].name} point`}
                />
                <span className="text-xs text-muted">¢ per point</span>
              </div>
            </Field>
          ))}
        </div>
        {r.cards.some((c) => c.program.kind === "CASH") && (
          <p className="mt-3 text-[11px] text-muted">
            Cash back ({[...new Set(r.cards.filter((c) => c.program.kind === "CASH").map((c) => shortName(c)))].join(", ")}) is worth its face value: nothing to set.
          </p>
        )}
      </Card>
    </>
  );
}
