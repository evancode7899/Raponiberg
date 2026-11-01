import { applies, guessProduct, productById, PROGRAMS, type CardProduct } from "./catalog.ts";
import { optimize } from "./optimizer.ts";
import { addDays, daysBetween } from "./periods.ts";
import { inAppUses, lineTotals, perkLines, sortCredits, isSpendRow, type Holding, type Sorted } from "./perks.ts";
import { buildPools, estimateEarn, postedForCard, type EarnedRow } from "./rewards.ts";
import { centsPerPoint, type CardPerksSettings } from "./settings.ts";
import type { ActItem, CardAccount, CardPerksReport, CardRewards, CardScore, EarnLine, PerkLine, PerkRow, StatementRewards } from "./types.ts";

/**
 * The Card perks page, for one calendar year: each credit card's annual fee against the
 * rewards it earned, the perks it paid and the issuer offers it gave, with nothing marked
 * by hand. Perks come from the statements' credits and, for in-app perks, the household's
 * charges (lib/cardPerks/perks.ts); rewards from the statements' printed balances,
 * reconciled against what the spending should have earned (rewards.ts); and which card
 * each purchase should have gone on (optimizer.ts).
 */

/** A card with no statement for this long (from an issuer that sends one every cycle) is taken as no longer held. */
const STALE_DAYS = 60;

export type CardPerksInput = {
  settings: CardPerksSettings;
  accounts: CardAccount[];
  /** Every row on the credit card accounts. */
  rows: PerkRow[];
  /** Charges on the household's other accounts at in-app perks' merchants (an Uber ride paid from a debit card). */
  householdRows: PerkRow[];
  snapshots: StatementRewards[];
  today: string;
  year?: number;
};

type Prepared = {
  account: CardAccount;
  product: CardProduct | null;
  productSource: CardScore["productSource"];
  hidden: boolean;
  held: Holding;
  rows: PerkRow[];
  sorted: Sorted;
  spend: PerkRow[];
  earned: EarnedRow[];
};

const inYear = (date: string, year: number) => date.startsWith(`${year}-`);

/** Two lines for one perk whose terms changed mid-year (a $20 credit that became $25) read as one. */
function mergeLines(lines: PerkLine[]): PerkLine[] {
  const out: PerkLine[] = [];
  for (const l of lines) {
    const same = out.find((x) => x.name === l.name && x.cadence === l.cadence);
    if (!same) {
      out.push(l);
      continue;
    }
    same.periods = same.periods.map((p, i) => (p.status === "NOT_OFFERED" ? l.periods[i]! : p));
    same.amountCents = l.amountCents;
    same.how = l.how;
    // Over the periods kept: a period both versions offer (an annual credit whose terms changed mid-year) counts once.
    Object.assign(same, lineTotals(same.periods));
  }
  return out;
}

export function buildCardPerks(input: CardPerksInput): CardPerksReport {
  const { settings, today } = input;
  const thisYear = Number(today.slice(0, 4));
  const year = input.year ?? thisYear;

  const rowsBy = new Map<string, PerkRow[]>();
  for (const r of [...input.rows].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) rowsBy.set(r.accountId, [...(rowsBy.get(r.accountId) ?? []), r]);

  const prepared: Prepared[] = input.accounts
    .filter((a) => a.statements.length)
    .map((account) => {
      const choice = settings.cards[account.id];
      const chosen = choice?.productId === "none" ? null : productById(choice?.productId);
      const guessed = choice?.productId ? null : guessProduct(account);
      const product = chosen ?? guessed;
      const through = account.statements.at(-1)!.end;
      const held = { from: account.statements[0]!.start, through, open: !account.closed && (!!account.skipsIdle || daysBetween(through, today) <= STALE_DAYS) };
      const rows = rowsBy.get(account.id) ?? [];
      const sorted = sortCredits(product, rows);
      const spend = rows.filter((r) => isSpendRow(r) && !sorted.notSpend.has(r.id));
      const program = PROGRAMS[product?.program ?? "none"];
      return {
        account,
        product,
        productSource: chosen ? "CHOSEN" : guessed ? "AUTO" : "UNKNOWN",
        hidden: choice?.hidden ?? false,
        held,
        rows,
        sorted,
        spend,
        earned: product ? estimateEarn(product, program, spend) : [],
      };
    });

  const years = [...new Set([thisYear, ...prepared.flatMap((p) => p.account.statements.flatMap((s) => [Number(s.start.slice(0, 4)), Number(s.end.slice(0, 4))]))])].sort((a, b) => b - a);

  // Expected rewards per statement, for reconciling against the printed balances.
  const expected = new Map<string, number>();
  const statementAccount = new Map<string, string>();
  for (const p of prepared) {
    for (const s of p.account.statements) statementAccount.set(s.id, p.account.id);
    for (const e of p.earned) expected.set(e.statementId, (expected.get(e.statementId) ?? 0) + e.units);
  }
  const cpp = (p: Prepared) => centsPerPoint(settings, p.product?.program ?? "none");
  const pools = buildPools({
    year,
    cards: prepared.map((p) => ({ accountId: p.account.id, program: PROGRAMS[p.product?.program ?? "none"], centsPerPoint: cpp(p), statements: p.account.statements })),
    snapshots: input.snapshots,
    expected,
    redemptions: prepared.flatMap((p) => p.sorted.credits.filter((c) => c.kind === "REDEMPTION").map((c) => ({ rowId: c.id, accountId: p.account.id, date: c.date, amountCents: c.amountCents }))),
  });

  const withProduct = prepared.filter((p): p is Prepared & { product: CardProduct } => p.product != null);
  const inApp = inAppUses(
    withProduct.map((p) => ({ accountId: p.account.id, product: p.product, held: p.held })),
    [...input.rows, ...input.householdRows],
    [...new Set([year - 1, year, thisYear])],
  );

  const shown = prepared.filter((p) => p.held.from <= `${year}-12-31` && (p.held.open || p.held.through >= `${year}-01-01`));
  const cards: CardScore[] = [];
  const hidden: CardPerksReport["hidden"] = [];
  for (const p of shown) {
    if (p.hidden) hidden.push({ accountId: p.account.id, accountName: p.account.name });
    else cards.push(score(p, year));
  }

  function rewardsFor(p: Prepared, y: number): CardRewards {
    const program = PROGRAMS[p.product?.program ?? "none"];
    const rate = program.kind === "CASH" ? 1 : cpp(p);
    const exp = p.earned.filter((e) => inYear(e.date, y)).reduce((t, e) => t + e.units, 0);
    const redeemedCents = p.sorted.credits.filter((c) => c.kind === "REDEMPTION" && inYear(c.date, y)).reduce((t, c) => t + c.amountCents, 0);
    const pool = pools.find((x) => x.accountIds.includes(p.account.id));
    const last = pool?.balances.filter((b) => b.date <= `${y}-12-31`).at(-1);
    const balance = last ? { value: last.balance, date: last.date, statementId: last.statementId } : null;
    if (program.kind === "NONE") return { kind: "NONE", expected: 0, earned: 0, fromStatements: 0, source: "NONE", valueCents: 0, redeemedCents, balance: null };
    let earned = exp;
    let fromStatements = 0;
    if (pool) {
      const { posted, proven, covered } = postedForCard(pool, p.account.id, y, expected, statementAccount);
      const uncovered = p.account.statements.filter((s) => inYear(s.end, y) && !covered.has(s.id)).reduce((t, s) => t + (expected.get(s.id) ?? 0), 0);
      earned = posted + uncovered;
      fromStatements = proven;
    }
    earned = Math.max(0, Math.round(earned));
    fromStatements = Math.min(earned, Math.max(0, Math.round(fromStatements)));
    const source = fromStatements === 0 ? "ESTIMATE" : fromStatements >= earned - 1 ? "STATEMENTS" : "MIXED";
    return { kind: program.kind, expected: Math.round(exp), earned, fromStatements, source, valueCents: Math.round(earned * rate), redeemedCents, balance };
  }

  function score(p: Prepared, y: number): CardScore {
    const program = PROGRAMS[p.product?.program ?? "none"];
    const ySpend = p.spend.filter((r) => inYear(r.date, y));
    const charges = -ySpend.filter((r) => r.amountCents < 0).reduce((t, r) => t + r.amountCents, 0);
    const refunds = ySpend.filter((r) => r.amountCents > 0).reduce((t, r) => t + r.amountCents, 0);

    const earnBy = new Map<string, EarnLine>();
    for (const e of p.earned) {
      if (!inYear(e.date, y)) continue;
      const l = earnBy.get(e.label) ?? { id: e.ruleId, label: e.label, rate: e.rate, spendCents: 0, units: 0, capped: e.capped };
      earnBy.set(e.label, { ...l, spendCents: l.spendCents + e.spendCents, units: l.units + e.units });
    }
    const earn = [...earnBy.values()].map((l) => ({ ...l, units: Math.round(l.units) })).sort((a, b) => b.units - a.units);
    const rewards = rewardsFor(p, y);
    const perks = p.product ? mergeLines(perkLines({ accountId: p.account.id, product: p.product, held: p.held, rows: p.rows, sorted: p.sorted, inApp, year: y, today })) : [];

    const feeRows = p.sorted.feeRows.filter((r) => inYear(r.date, y));
    const lastFee = p.sorted.feeRows.filter((r) => r.amountCents < 0).at(-1);
    const nextDue = p.held.open && lastFee ? addDays(lastFee.date, 365) : null;
    const credits = p.sorted.credits.filter((c) => inYear(c.date, y));
    const perksValue = perks.reduce((t, l) => t + l.usedCents, 0);
    const offers = credits.filter((c) => c.kind === "OFFER").reduce((t, c) => t + c.amountCents, 0);
    const feeCents = -feeRows.reduce((t, r) => t + r.amountCents, 0);
    const used = perks.reduce((t, l) => t + l.usedCents, 0);
    const missed = perks.reduce((t, l) => t + l.missedCents, 0);

    // Keep or cancel: the year to the latest statement.
    const to = p.held.through;
    const from = addDays(to, -364);
    const inWindow = (d: string) => d >= from && d <= to;
    const rate = program.kind === "CASH" ? 1 : program.kind === "NONE" ? 0 : cpp(p);
    const winRewards = p.earned.filter((e) => inWindow(e.date)).reduce((t, e) => t + e.units, 0) * rate;
    const winPerks =
      p.sorted.perkCredits.filter((c) => inWindow(c.on)).reduce((t, c) => t + c.row.amountCents, 0) +
      [...inApp].filter(([k, e]) => k.startsWith(`${p.account.id}|`) && inWindow(e.date)).reduce((t, [k]) => {
        const perk = p.product?.perks.find((x) => x.id === k.split("|")[1]);
        return t + (perk?.amountCents ?? 0);
      }, 0);
    const winOffers = p.sorted.credits.filter((c) => c.kind === "OFFER" && inWindow(c.date)).reduce((t, c) => t + c.amountCents, 0);
    const winFee = -p.sorted.feeRows.filter((r) => inWindow(r.date)).reduce((t, r) => t + r.amountCents, 0);

    return {
      accountId: p.account.id,
      accountName: p.account.name,
      last4: /(\d{4})\D*$/.exec(p.account.name)?.[1] ?? null,
      product: p.product,
      productSource: p.productSource,
      program,
      centsPerPoint: cpp(p),
      held: p.held,
      statementsInYear: p.account.statements.filter((s) => inYear(s.end, y)).length,
      spend: { chargesCents: charges, refundsCents: refunds, netCents: charges - refunds },
      earn,
      hiddenEarn: (p.product?.earn ?? []).filter((r) => r.portal && applies(r, `${y}-01-01`, `${y}-12-31`)).map((r) => `${r.label} (${r.rate}×)`),
      rewards,
      perks,
      credits,
      fee: { cents: feeCents, rows: feeRows.map((r) => ({ id: r.id, date: r.date, amountCents: r.amountCents })), termsCents: p.product?.annualFeeCents ?? 0, nextDue },
      perksValueCents: perksValue,
      perksAllowanceCents: perks.reduce((t, l) => t + l.allowanceCents, 0),
      offersCents: offers,
      netCents: rewards.valueCents + perksValue + offers - feeCents,
      remainingCents: perks.reduce((t, l) => t + l.remainingCents, 0),
      missedCents: missed,
      captureRate: used + missed > 0 ? used / (used + missed) : null,
      trailing: p.product ? { from, to, valueCents: Math.round(winRewards + winPerks + winOffers), feeCents: winFee } : null,
    };
  }

  // What to use before it resets: this year's open periods on cards still held.
  const act: ActItem[] = [];
  for (const p of withProduct) {
    if (!p.held.open || p.hidden) continue;
    const lines = year === thisYear ? (cards.find((c) => c.accountId === p.account.id)?.perks ?? []) : mergeLines(perkLines({ accountId: p.account.id, product: p.product, held: p.held, rows: p.rows, sorted: p.sorted, inApp, year: thisYear, today }));
    for (const l of lines) {
      const open = l.periods.find((x) => x.status === "OPEN");
      if (!open) continue;
      act.push({ accountId: p.account.id, perkId: l.id, name: l.name, card: p.product.name, leftCents: open.allowanceCents - open.usedCents, ends: open.end, daysLeft: daysBetween(today, open.end), how: l.how, neverUsed: l.neverUsed });
    }
  }
  act.sort((a, b) => Number(a.neverUsed) - Number(b.neverUsed) || a.daysLeft - b.daysLeft || b.leftCents - a.leftCents);

  const optimizer = optimize(
    withProduct.filter((p) => !p.hidden && shown.includes(p)).map((p) => ({ accountId: p.account.id, product: p.product, held: p.held, centsPerPoint: cpp(p) })),
    shown.filter((p) => !p.hidden).flatMap((p) => p.spend.filter((r) => inYear(r.date, year) && r.amountCents < 0)),
    today,
  );

  // Where the rewards came from, in cents of value.
  const mix = new Map<string, number>();
  for (const c of cards) {
    const rate = c.rewards.kind === "CASH" ? 1 : c.centsPerPoint;
    for (const l of c.earn) {
      const label = l.label.replace(/ (past the cap)$/, "");
      mix.set(label, (mix.get(label) ?? 0) + l.units * rate);
    }
  }
  const rewardsMix = [...mix].map(([label, v]) => ({ label, valueCents: Math.round(v) })).filter((x) => x.valueCents > 0).sort((a, b) => b.valueCents - a.valueCents);

  const sum = (f: (c: CardScore) => number) => cards.reduce((t, c) => t + f(c), 0);
  const used = sum((c) => c.perksValueCents);
  const missed = sum((c) => c.missedCents);
  return {
    year,
    years,
    today,
    cards: cards.sort((a, b) => Number(b.held.open) - Number(a.held.open) || b.netCents - a.netCents),
    hidden,
    pools,
    act,
    optimizer,
    rewardsMix,
    totals: {
      feesCents: sum((c) => c.fee.cents),
      rewardsValueCents: sum((c) => c.rewards.valueCents),
      perksValueCents: used,
      offersCents: sum((c) => c.offersCents),
      netCents: sum((c) => c.netCents),
      remainingCents: sum((c) => c.remainingCents),
      missedCents: missed,
      spendCents: sum((c) => c.spend.netCents),
      captureRate: used + missed > 0 ? used / (used + missed) : null,
      openPerks: act.length,
    },
  };
}

