import type { CardPerksReport, CardScore, PerkLine, PerkPeriod, RewardsPool } from "../../cardPerks/types.ts";
import { c, cellKey, ln, r, t, type DerivedFigure } from "./types.ts";

type Report = Pick<CardPerksReport, "year" | "totals" | "cards"> & Partial<Pick<CardPerksReport, "act" | "optimizer" | "rewardsMix" | "pools">>;

/** A card's figure (Overview tiles, its Details, Credits): key year|account|what. */
export const cardKey = (year: number, accountId: string, what: string) => cellKey(year, accountId, what);
/** A perk line's figure, or one period of it (what: used / allowance, or the period's key). */
export const perkKey = (year: number, accountId: string, perkId: string, what: string) => cellKey(year, `${accountId}|${perkId}`, what);
/** A Best card cell: a line (or "all"), and a column; a card's share of a line is line|account. */
export const optKey = (year: number, row: string, col: string) => cellKey(year, row, col);

/** What a perk period draws in the Credits grid: what was used (Used, Partly used), or what's left (Available now). */
export const periodShows = (x: Pick<PerkPeriod, "status">): "used" | "left" | null => (x.status === "USED" || x.status === "PARTIAL" ? "used" : x.status === "OPEN" ? "left" : null);

/** The Best card table shows the first three cards of a line's split. */
export const SPLIT_SHOWN = 3;

/** A rewards pool's stretches that close in the year (the Reconciliation table). */
export const poolStretches = (p: Pick<RewardsPool, "stretches">, year: number) => p.stretches.filter((s) => s.to.startsWith(`${year}-`));
/** The latest printed balance on or before the year's end. */
export const poolLast = (p: Pick<RewardsPool, "balances">, year: number) => p.balances.filter((b) => b.date <= `${year}-12-31`).at(-1);

/**
 * The Card perks page for one year (key: the year, alone or leading): the headline (net
 * value, rewards, credits used, perk capture, what's still to use) and every figure under
 * it — each card's tile and details, each perk line and period, the credits open now, the
 * Best card table and the rewards mix. Each is listed only where the page draws it.
 */
export function cardPerksDerived(rep: Report): DerivedFigure[] {
  const x = rep.totals;
  const y = rep.year;
  const key = String(y);
  const f = (figure: string, describes: string, value: DerivedFigure["value"], lines: DerivedFigure["lines"]): DerivedFigure => ({ figure, key, describes: `${describes}, ${y}`, value, lines });
  const out: DerivedFigure[] = [
    f("net-value", "Net value of the cards", c(x.netCents), [
      ln("Rewards earned", c(x.rewardsValueCents), undefined, { source: "proven" }),
      ln("Perk credits used", c(x.perksValueCents), "+", { source: "proven" }),
      ln("Offers & bonuses", c(x.offersCents), "+", { source: "proven" }),
      ln("Annual fees", c(x.feesCents), "−", { source: "proven" }),
      ln("Net value", c(x.netCents), "="),
    ]),
    f("rewards", "Rewards earned", c(x.rewardsValueCents), [ln("Card spending", c(x.spendCents), undefined, { source: "proven" }), ln("Rewards, as the statements print them (or expected where none print)", c(x.rewardsValueCents))]),
    f("credits", "Credits used: perks, offers and bonuses", c(x.perksValueCents + x.offersCents), [ln("Perk credits", c(x.perksValueCents), undefined, { source: "proven" }), ln("Offers & bonuses", c(x.offersCents), "+", { source: "proven" }), ln("Credits used", c(x.perksValueCents + x.offersCents), "=")]),
    f("capture", "Perk capture: credits used of those available", x.captureRate == null ? null : r(x.captureRate), [ln("Credits used", c(x.perksValueCents)), ln("Let lapse", c(x.missedCents)), ln("Capture", x.captureRate == null ? t("—") : r(x.captureRate))]),
    f("remaining", "Credits still to use", c(x.remainingCents), [ln("Open credits", t(String(x.openPerks))), ln("Still to use", c(x.remainingCents))]),
    // The headline's sub-lines.
    f("fees", "Annual fees charged", c(x.feesCents), rep.cards.filter((k) => k.fee.cents).map((k, i) => ln(k.accountName, c(k.fee.cents), i ? "+" : undefined, { source: "proven" }))),
    f("spend", "Card spending", c(x.spendCents), rep.cards.map((k, i) => ln(k.accountName, c(k.spend.netCents), i ? "+" : undefined, { source: "proven" }))),
    f("perks", "Perk credits used", c(x.perksValueCents), rep.cards.map((k, i) => ln(k.accountName, c(k.perksValueCents), i ? "+" : undefined, { source: "proven" }))),
    f("offers", "Offers & bonuses", c(x.offersCents), rep.cards.map((k, i) => ln(k.accountName, c(k.offersCents), i ? "+" : undefined, { source: "proven" }))),
    f("missed", "Perk credits let lapse", c(x.missedCents), rep.cards.map((k, i) => ln(k.accountName, c(k.missedCents), i ? "+" : undefined, { source: "proven" }))),
  ];
  for (const k of rep.cards) out.push(...cardFigures(y, k));
  for (const a of rep.act ?? [])
    out.push({ figure: "act", key: perkKey(y, a.accountId, a.perkId, "left"), describes: `${a.name} on ${a.card}: still to use before ${a.ends}`, value: c(a.leftCents), lines: [ln("What the open period still has: its terms less the credits found in it", c(a.leftCents))] });
  const o = rep.optimizer;
  if (o) {
    const opt = (row: string, col: string, describes: string, cents: number, lines: DerivedFigure["lines"] = [ln(describes, c(cents))]) => out.push({ figure: "optimizer", key: optKey(y, row, col), describes: `Best card, ${y}: ${describes}`, value: c(cents), lines });
    opt("all", "spend", "spending valued", o.spendCents);
    opt("all", "actual", "earned on the cards that paid", o.actualCents);
    opt("all", "missed", "the best card every time would have added", o.missedCents);
    for (const l of o.lines) {
      opt(l.key, "spend", `${l.label}: spending`, l.spendCents, l.byCard.map((b, i) => ln(b.accountId, c(b.spendCents), i ? "+" : undefined)));
      opt(l.key, "actual", `${l.label}: earned on the card that paid`, l.actualCents);
      opt(l.key, "best", `${l.label}: earned on the best card held that day`, l.bestCents);
      for (const b of l.byCard.slice(0, SPLIT_SHOWN)) opt(`${l.key}|${b.accountId}`, "spend", `${l.label}: spending on one card`, b.spendCents);
    }
  }
  for (const m of rep.rewardsMix ?? []) out.push({ figure: "mix", key: cellKey(y, m.label, "value"), describes: `Rewards from ${m.label}, ${y}`, value: c(m.valueCents), lines: [ln("Expected rewards on that spending, valued at each program's point value", c(m.valueCents))] });
  for (const p of rep.pools ?? []) out.push(...poolFigures(y, p));
  return out;
}

/** One card's tile, its details and its Credits grid, as the page draws them. */
function cardFigures(y: number, k: CardScore): DerivedFigure[] {
  const out: DerivedFigure[] = [];
  const add = (what: string, describes: string, value: DerivedFigure["value"], lines: DerivedFigure["lines"]) => out.push({ figure: "card", key: cardKey(y, k.accountId, what), describes: `${k.accountName}: ${describes}, ${y}`, value, lines });
  const cash = k.rewards.kind === "CASH";
  add("net", "net value", c(k.netCents), [
    ln("Rewards", c(k.rewards.valueCents)),
    ln("Perk credits used", c(k.perksValueCents), "+"),
    ln("Offers & bonuses", c(k.offersCents), "+"),
    ln("Annual fee", c(k.fee.cents), "−"),
    ln("Net value", c(k.netCents), "="),
  ]);
  add("rewards", "rewards, in dollars", c(k.rewards.valueCents), [ln("Rewards, as the statements print them (or expected where none print), at the program's point value", c(k.rewards.valueCents))]);
  if (k.perksValueCents || k.captureRate != null || k.perks.length) add("perks", "perk credits used", c(k.perksValueCents), k.perks.map((l, i) => ln(l.name, c(l.usedCents), i ? "+" : undefined)));
  if (k.offersCents) add("offers", "offers & bonuses", c(k.offersCents), k.credits.filter((x) => x.kind === "OFFER").map((x, i) => ln(`${x.date} ${x.payee}`, c(x.amountCents), i ? "+" : undefined, { source: "proven", link: { label: "The credit", descriptor: { report: "row", rowId: x.id } } })));
  if (k.fee.cents) add("fee", "annual fee charged", c(k.fee.cents), k.fee.rows.map((x, i) => ln(x.date, c(-x.amountCents), i ? "+" : undefined, { source: "proven", link: { label: "The fee", descriptor: { report: "row", rowId: x.id } } })));
  if (k.captureRate != null) add("capture", "perk capture", r(k.captureRate), [ln("Credits used", c(k.perksValueCents)), ln("Let lapse", c(k.missedCents)), ln("Used ÷ (used + let lapse)", r(k.captureRate), "=")]);
  add("spend", "spending (charges less refunds)", c(k.spend.netCents), [ln("Charges", c(k.spend.chargesCents)), ln("Refunds", c(k.spend.refundsCents), "−"), ln("Spending", c(k.spend.netCents), "=")]);
  // Credits: what the perks offered over the periods held, what lapsed and what's still to come.
  if (k.perks.length) {
    add("allowance", "perk credits offered over the periods held", c(k.perksAllowanceCents), k.perks.map((l, i) => ln(l.name, c(l.allowanceCents), i ? "+" : undefined)));
    if (k.missedCents) add("missed", "perk credits let lapse", c(k.missedCents), k.perks.map((l, i) => ln(l.name, c(l.missedCents), i ? "+" : undefined)));
    if (k.remainingCents) add("remaining", "perk credits still to come", c(k.remainingCents), k.perks.map((l, i) => ln(l.name, c(l.remainingCents), i ? "+" : undefined)));
  }
  if (cash && k.program.kind !== "NONE") {
    add("earned", "cash back earned", c(k.rewards.earned), [ln("Posted where the statements show it, expected elsewhere", c(k.rewards.earned))]);
    add("expected", "cash back expected from spending", c(k.rewards.expected), k.earn.map((l, i) => ln(l.label, c(l.units), i ? "+" : undefined)));
    if (k.rewards.balance) add("balance", "cash back balance the statements print", c(k.rewards.balance.value), [ln(`Printed on ${k.rewards.balance.date}`, c(k.rewards.balance.value), undefined, { source: "proven", link: { label: "The statement", descriptor: { report: "statement", statementId: k.rewards.balance.statementId } } })]);
  }
  if (k.program.kind !== "NONE") {
    if (k.rewards.redeemedCents > 0) add("redeemed", "rewards cashed in as statement credits", c(k.rewards.redeemedCents), [ln("Redemption credits on the statements", c(k.rewards.redeemedCents))]);
    for (const l of k.earn) {
      add(`earn|${l.label}|spend`, `spending earning ${l.label}`, c(l.spendCents), [ln(l.label, c(l.spendCents))]);
      if (cash) add(`earn|${l.label}|units`, `cash back expected on ${l.label}`, c(l.units), [ln("Spending × the card's rate", c(l.units))]);
    }
  }
  const tr = k.trailing;
  if (tr && (k.fee.termsCents > 0 || tr.feeCents > 0)) {
    add("trailing-value", `what it gave in the 12 months to ${tr.to}`, c(tr.valueCents), [ln(`Rewards, perk credits and offers, ${tr.from} – ${tr.to}`, c(tr.valueCents))]);
    if (tr.feeCents) add("trailing-fee", `annual fee charged in the 12 months to ${tr.to}`, c(tr.feeCents), [ln(`Fee rows, ${tr.from} – ${tr.to}`, c(tr.feeCents), undefined, { source: "proven" })]);
  }
  for (const l of k.perks) out.push(...perkFigures(y, k, l));
  return out;
}

/** A perk line's Used column, its details and each period the Credits grid draws a dollar figure in. */
function perkFigures(y: number, k: CardScore, l: PerkLine): DerivedFigure[] {
  const out: DerivedFigure[] = [
    { figure: "perk", key: perkKey(y, k.accountId, l.id, "used"), describes: `${l.name} on ${k.accountName}: used, ${y}`, value: c(l.usedCents), lines: l.periods.filter((x) => x.usedCents).map((x, i) => ln(x.label, c(x.usedCents), i ? "+" : undefined)) },
    { figure: "perk", key: perkKey(y, k.accountId, l.id, "allowance"), describes: `${l.name} on ${k.accountName}: offered over the periods held, ${y}`, value: c(l.allowanceCents), lines: l.periods.filter((x) => x.status !== "NOT_HELD" && x.status !== "NOT_OFFERED").map((x, i) => ln(x.label, c(x.allowanceCents), i ? "+" : undefined)) },
  ];
  for (const x of l.periods) {
    const shows = periodShows(x);
    if (!shows) continue;
    const cents = shows === "used" ? x.usedCents : x.allowanceCents - x.usedCents;
    out.push({
      figure: "period",
      key: perkKey(y, k.accountId, l.id, x.key),
      describes: `${l.name} on ${k.accountName}, ${x.label}: ${shows === "used" ? "used" : "still to use"}`,
      value: c(cents),
      lines:
        shows === "used"
          ? x.evidence.map((e, i) => ln(`${e.date} ${e.payee}`, c(e.kind === "SPEND" ? x.usedCents : e.amountCents), i ? "+" : undefined, { source: "proven", link: { label: "The row", descriptor: { report: "row", rowId: e.rowId } } }))
          : [ln("Offered this period (the card's terms)", c(x.allowanceCents), undefined, { source: "assumption" }), ln("Used so far", c(x.usedCents), "−"), ln("Still to use", c(cents), "=")],
    });
  }
  return out;
}

/** A rewards pool, where it's money: cash back posted, expected and cashed out, each stretch's row, and the points balance in dollars. */
function poolFigures(y: number, p: RewardsPool): DerivedFigure[] {
  const out: DerivedFigure[] = [];
  const add = (row: string, col: string, describes: string, value: DerivedFigure["value"], lines: DerivedFigure["lines"]) => out.push({ figure: "pool", key: cellKey(y, `${p.key}|${row}`, col), describes: `${p.program.name}: ${describes}, ${y}`, value, lines });
  const cash = p.program.kind === "CASH";
  const { posted, expected, redeemed } = p.year;
  const last = poolLast(p, y);
  if (last && p.program.kind === "POINTS") add("balance", "value", `the points balance on ${last.date} in dollars`, c(Math.round(last.balance * p.centsPerPoint)), [ln("Points printed", t(String(last.balance))), ln("× your point value (¢)", r(p.centsPerPoint), "×", { source: "assumption" }), ln("In dollars", c(Math.round(last.balance * p.centsPerPoint)), "=")]);
  if (expected > 0) add("year", "vs-expected", "posted against expected", r((posted - expected) / expected), [ln("Posted", t(String(posted))), ln("Expected", t(String(expected))), ln("Posted ÷ expected − 1", r((posted - expected) / expected), "=")]);
  if (!cash) return out;
  add("year", "posted", "cash back posted", c(posted), [ln("Posted in the year's stretches", c(posted))]);
  add("year", "expected", "cash back expected", c(expected), [ln("Expected from the year's spending", c(expected))]);
  if (redeemed) add("year", "redeemed", "cash back that left the balance", c(redeemed), [ln("Redeemed in the year's stretches", c(redeemed))]);
  for (const s of poolStretches(p, y)) {
    const row = `${s.from}|${s.to}`;
    add(row, "expected", `expected, ${s.from} – ${s.to}`, c(s.expected), [ln("What the cycles should have earned", c(s.expected))]);
    add(row, "posted", `posted, ${s.from} – ${s.to}`, c(s.posted), [ln("What posted", c(s.posted))]);
    if (s.difference) add(row, "difference", `posted less expected, ${s.from} – ${s.to}`, c(s.difference), [ln("Posted", c(s.posted)), ln("Expected", c(s.expected), "−"), ln("Difference", c(s.difference), "=")]);
    if (s.redeemed) add(row, "redeemed", `left the balance, ${s.from} – ${s.to}`, c(s.redeemed), [ln("Redeemed", c(s.redeemed))]);
  }
  return out;
}
