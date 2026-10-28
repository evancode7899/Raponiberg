"use client";

import { Badge, btn, Callout, Card, Field, selectCls, table } from "@/components/ui/kit";
import { CADENCE_INFO, CADENCES, CARD_PRODUCTS, productById, type Cadence, type PerkUnit } from "@/lib/cardPerks/catalog";
import type { CardPerksPage } from "@/lib/cardPerks/page";
import { setupFromProduct, type CardPerksSettings, type CardSetup, type EarnRule, type Perk } from "@/lib/cardPerks/settings";
import { CATEGORIES } from "@/lib/classifier/taxonomy";
import { useState } from "react";
import { fmtCpp, NumberInput, textCls, type Save } from "./parts";

const SPENDING = CATEGORIES.filter((c) => c.kind === "EXPENSE" && c.group !== "Money movement" && c.group !== "Financial").map((c) => c.name);

type Row = { accountId: string; accountName: string; guessed: boolean; setup: CardSetup };
type Form = { centsPerPoint: number; rows: Row[] };

const toForm = (r: CardPerksPage, s: CardPerksSettings): Form => ({
  centsPerPoint: s.centsPerPoint,
  rows: [
    ...r.cards.map((c) => ({ accountId: c.accountId, accountName: c.accountName, guessed: c.guessed, setup: c.setup })),
    ...r.hidden.flatMap((h) => (s.cards[h.accountId] ? [{ accountId: h.accountId, accountName: h.accountName, guessed: false, setup: s.cards[h.accountId]! }] : [])),
  ],
});

let seq = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${(seq++).toString(36)}`;

export function SetupTab({ r, settings, save }: { r: CardPerksPage; settings: CardPerksSettings; save: Save }) {
  const [f, setF] = useState(() => toForm(r, settings));
  const [dirty, setDirty] = useState(false);
  // New data from the server resets the form (adjusted during render, not in an effect).
  const [seen, setSeen] = useState({ r, settings });
  if (seen.r !== r || seen.settings !== settings) {
    setSeen({ r, settings });
    setF(toForm(r, settings));
    setDirty(false);
  }
  const edit = (accountId: string, change: (s: CardSetup) => CardSetup) => {
    setF((x) => ({ ...x, rows: x.rows.map((row) => (row.accountId === accountId ? { ...row, setup: change(row.setup) } : row)) }));
    setDirty(true);
  };
  const submit = async () => {
    const cards = { ...settings.cards };
    for (const row of f.rows) cards[row.accountId] = row.setup;
    if (await save({ ...settings, centsPerPoint: f.centsPerPoint, cards })) setDirty(false);
  };
  const saveButton = (
    <button type="button" className={btn.primary} onClick={submit} disabled={!dirty && !f.rows.some((x) => x.guessed)}>
      {f.rows.some((x) => x.guessed) && !dirty ? "Confirm suggestions" : "Save"}
    </button>
  );

  return (
    <>
      <Callout tone="info" title="Check each card against your issuer">
        The card list is a starting point, last checked {CARD_PRODUCTS[0]!.asOf}. Issuers change fees and credits often, so compare each card&apos;s fee and perks with its benefits page
        and edit anything that differs. Your changes are saved in the database (and its backups), not in the code.
      </Callout>
      <Card title="Point value" subtitle="What a point is worth to you, in cents. 1¢ is cash-back value; transfer partners can be worth more. Each card can override it." actions={saveButton}>
        <div className="max-w-xs">
          <Field label="Cents per point" hint={`Currently ${fmtCpp(settings.centsPerPoint)}.`}>
            <NumberInput
              value={f.centsPerPoint}
              onChange={(v) => {
                setF((x) => ({ ...x, centsPerPoint: v ?? 1 }));
                setDirty(true);
              }}
              suffix="¢"
              ariaLabel="Cents per point"
            />
          </Field>
        </div>
      </Card>
      {f.rows.map((row) => (
        <CardEditor key={row.accountId} row={row} edit={(change) => edit(row.accountId, change)} saveButton={saveButton} />
      ))}
    </>
  );
}

function CardEditor({ row, edit, saveButton }: { row: Row; edit: (change: (s: CardSetup) => CardSetup) => void; saveButton: React.ReactNode }) {
  const s = row.setup;
  const product = productById(s.productId);
  const setRule = (id: string, change: Partial<EarnRule>) => edit((x) => ({ ...x, earnRules: x.earnRules.map((r) => (r.id === id ? { ...r, ...change } : r)) }));
  const setPerk = (id: string, change: Partial<Perk>) => edit((x) => ({ ...x, perks: x.perks.map((p) => (p.id === id ? { ...p, ...change } : p)) }));
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {row.accountName}
          {row.guessed && <Badge tone="info">{s.productId ? "Suggested from the account name" : "Not set up"}</Badge>}
          {s.hidden && <Badge>Hidden</Badge>}
        </span>
      }
      actions={saveButton}
    >
      <div className="space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6">
          <Field label="Card" className="lg:col-span-2">
            <select
              className={selectCls}
              value={s.productId ?? ""}
              onChange={(e) => {
                const p = productById(e.target.value);
                edit((x) => ({ ...setupFromProduct(p, x.name), centsPerPoint: x.centsPerPoint, hidden: x.hidden }));
              }}
            >
              <option value="">Other card (set up by hand)</option>
              {CARD_PRODUCTS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Name on this page" className="lg:col-span-2">
            <input className={textCls} value={s.name} onChange={(e) => edit((x) => ({ ...x, name: e.target.value }))} />
          </Field>
          <Field label="Annual fee">
            <NumberInput value={s.annualFeeCents} onChange={(v) => edit((x) => ({ ...x, annualFeeCents: Math.round(v ?? 0) }))} scale={100} prefix="$" ariaLabel="Annual fee" />
          </Field>
          <Field label="Cents per point" hint="Blank: the page-wide value.">
            <NumberInput value={s.centsPerPoint} onChange={(v) => edit((x) => ({ ...x, centsPerPoint: v }))} suffix="¢" placeholder="default" ariaLabel="Cents per point for this card" />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5 text-fg-2">
            <input type="checkbox" checked={s.hidden} onChange={(e) => edit((x) => ({ ...x, hidden: e.target.checked }))} />
            Leave this card off the page
          </label>
          {product && (
            <button type="button" className={btn.link} onClick={() => edit((x) => ({ ...setupFromProduct(product, x.name), centsPerPoint: x.centsPerPoint, hidden: x.hidden }))}>
              Reset fee, earn rates and perks to the card list ({product.asOf})
            </button>
          )}
        </div>

        <div>
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Points per dollar</h3>
          <p className="mb-2 text-[11px] text-muted">
            The first rule a purchase matches sets its rate, by its category in the ledger or a pattern in its description (a regular expression, like <code>DELTA|UNITED AIR</code>).
            Bookings through the issuer&apos;s travel portal can&apos;t be told apart on a statement; enter the points actually posted on the Scorecard to correct the estimate.
          </p>
          <div className={table.wrap}>
            <table className={table.table} style={{ minWidth: "40rem" }}>
              <thead>
                <tr className={table.head}>
                  <th className={table.th}>Rule</th>
                  <th className={table.th}>Category</th>
                  <th className={table.th}>Or description matching</th>
                  <th className={table.thR}>Points / $</th>
                  <th className={table.th} />
                </tr>
              </thead>
              <tbody>
                {s.earnRules.map((r) => (
                  <tr key={r.id} className={table.tr}>
                    <td className={table.td}>
                      <input className={textCls} value={r.label} onChange={(e) => setRule(r.id, { label: e.target.value })} aria-label="Rule name" />
                    </td>
                    <td className={table.td}>
                      <select className={`${selectCls} w-full`} value={r.categories[0] ?? ""} onChange={(e) => setRule(r.id, { categories: e.target.value ? [e.target.value] : [] })} aria-label="Category">
                        <option value="">Any (pattern only)</option>
                        {SPENDING.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={table.td}>
                      <input className={`${textCls} font-mono`} value={r.pattern} onChange={(e) => setRule(r.id, { pattern: e.target.value })} aria-label="Description pattern" />
                    </td>
                    <td className={`${table.td} w-24`}>
                      <NumberInput value={r.rate} onChange={(v) => setRule(r.id, { rate: v ?? 0 })} suffix="×" ariaLabel="Points per dollar" />
                    </td>
                    <td className={table.td}>
                      <button type="button" className={btn.ghost} aria-label={`Remove ${r.label}`} onClick={() => edit((x) => ({ ...x, earnRules: x.earnRules.filter((y) => y.id !== r.id) }))}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
                <tr className={table.tr}>
                  <td className={`${table.td} text-fg-2`} colSpan={3}>
                    Everything else
                  </td>
                  <td className={`${table.td} w-24`}>
                    <NumberInput value={s.baseRate} onChange={(v) => edit((x) => ({ ...x, baseRate: v ?? 1 }))} suffix="×" ariaLabel="Points per dollar on everything else" />
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
          <button
            type="button"
            className={`${btn.secondary} mt-2`}
            onClick={() => edit((x) => ({ ...x, earnRules: [...x.earnRules, { id: newId("rule"), label: "Bonus category", categories: ["Dining"], pattern: "", rate: 2 }] }))}
          >
            + Earn rule
          </button>
        </div>

        <div>
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Recurring perks</h3>
          <p className="mb-2 text-[11px] text-muted">
            Each perk resets every period. A statement credit matching its pattern counts toward it automatically; leave the pattern blank for perks that never reach the statement
            (in-app credits, bonus points) and mark them used on the Perk tracker.
          </p>
          <div className={table.wrap}>
            <table className={table.table} style={{ minWidth: "52rem" }}>
              <thead>
                <tr className={table.head}>
                  <th className={table.th}>Perk</th>
                  <th className={table.th}>Resets</th>
                  <th className={table.th}>In</th>
                  <th className={table.thR}>Each period</th>
                  <th className={table.th}>Statement credit matching</th>
                  <th className={table.th} />
                </tr>
              </thead>
              <tbody>
                {s.perks.map((p) => (
                  <tr key={p.id} className={table.tr}>
                    <td className={table.td}>
                      <input className={textCls} value={p.name} onChange={(e) => setPerk(p.id, { name: e.target.value })} aria-label="Perk name" />
                    </td>
                    <td className={table.td}>
                      <select className={selectCls} value={p.cadence} onChange={(e) => setPerk(p.id, { cadence: e.target.value as Cadence })} aria-label="Resets">
                        {CADENCES.map((c) => (
                          <option key={c} value={c}>
                            {CADENCE_INFO[c].label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={table.td}>
                      <select className={selectCls} value={p.unit} onChange={(e) => setPerk(p.id, { unit: e.target.value as PerkUnit })} aria-label="Unit">
                        <option value="USD">Dollars</option>
                        <option value="POINTS">Points</option>
                      </select>
                    </td>
                    <td className={`${table.td} w-32`}>
                      <NumberInput
                        value={p.amount}
                        onChange={(v) => setPerk(p.id, { amount: Math.round(v ?? 0) })}
                        scale={p.unit === "USD" ? 100 : 1}
                        prefix={p.unit === "USD" ? "$" : undefined}
                        suffix={p.unit === "POINTS" ? "pts" : undefined}
                        ariaLabel="Amount each period"
                      />
                    </td>
                    <td className={table.td}>
                      <input
                        className={`${textCls} font-mono`}
                        value={p.pattern}
                        placeholder={p.unit === "USD" ? "blank: marked by hand" : "marked by hand"}
                        disabled={p.unit === "POINTS"}
                        onChange={(e) => setPerk(p.id, { pattern: e.target.value })}
                        aria-label="Statement credit pattern"
                      />
                    </td>
                    <td className={table.td}>
                      <button type="button" className={btn.ghost} aria-label={`Remove ${p.name}`} onClick={() => edit((x) => ({ ...x, perks: x.perks.filter((y) => y.id !== p.id) }))}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
                {!s.perks.length && (
                  <tr className={table.tr}>
                    <td className={`${table.td} text-muted`} colSpan={6}>
                      No perks yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            className={`${btn.secondary} mt-2`}
            onClick={() => edit((x) => ({ ...x, perks: [...x.perks, { id: newId("perk"), name: "New perk", cadence: "MONTHLY", unit: "USD", amount: 1_000, pattern: "", note: "" }] }))}
          >
            + Perk
          </button>
        </div>
      </div>
    </Card>
  );
}
