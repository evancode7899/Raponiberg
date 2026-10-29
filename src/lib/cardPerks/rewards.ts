import { applies, type CardProduct, type EarnRule, type Program } from "./catalog.ts";
import { addDays, regex } from "./periods.ts";
import type { PerkRow, Reconciliation, RewardsPool, StatementRewards } from "./types.ts";

/**
 * Rewards: what each purchase should earn under its card's rules, and the statements'
 * printed rewards balances reconciled against it, stretch by stretch.
 *
 * A purchase earns the first rule it matches, up to the rule's yearly spending cap; a
 * refund takes back what its purchase earned. Points (or cents of cash back) are summed
 * per statement, since issuers post a cycle's rewards when it closes. Between two printed
 * balances, the cycles that closed in the stretch should have added their expected
 * rewards: the balance's rise (plus any redemption the statements show) is what actually
 * posted, and the difference is a welcome offer, a bonus or an estimate that missed. When
 * the balance fell, points left it (a transfer, a redemption): the statements can't say
 * how many were earned, so the estimate stands and the redemption is what's left over.
 */

export type EarnedRow = { rowId: string; accountId: string; statementId: string; date: string; ruleId: string; label: string; rate: number; spendCents: number; units: number; capped: boolean };

type Compiled = { rule: EarnRule; re: RegExp | null };

/** The rule a row matches on a product, at the row's date; null for the base rate. */
export function matchRule(rules: Compiled[], row: Pick<PerkRow, "payee" | "detail" | "category" | "date">): EarnRule | null {
  const text = `${row.payee} ${row.detail ?? ""}`;
  for (const { rule, re } of rules) {
    if (rule.portal || !applies(rule, row.date, row.date)) continue;
    const byCat = !!rule.categories?.length && rule.categories.includes(row.category);
    const byText = !!re && re.test(text);
    if (rule.requireBoth ? byCat && byText : byCat || byText) return rule;
  }
  return null;
}

export const compileRules = (p: CardProduct): Compiled[] => p.earn.map((rule) => ({ rule, re: regex(rule.pattern) }));

/**
 * What each spending row earns on its card. `rows` are the card's purchases (negative)
 * and merchant refunds (positive), oldest first; caps reset each calendar year.
 */
export function estimateEarn(product: CardProduct, program: Program, rows: PerkRow[]): EarnedRow[] {
  if (program.kind === "NONE") return [];
  const rules = compileRules(product);
  const used = new Map<string, number>();
  const out: EarnedRow[] = [];
  for (const r of rows) {
    const rule = matchRule(rules, r);
    const spend = -r.amountCents;
    const base = { rowId: r.id, accountId: r.accountId, statementId: r.statementId, date: r.date };
    if (!rule) {
      out.push({ ...base, ruleId: "base", label: "Everything else", rate: product.baseRate, spendCents: spend, units: (spend / 100) * product.baseRate, capped: false });
      continue;
    }
    if (rule.capCents == null || spend <= 0) {
      out.push({ ...base, ruleId: rule.id, label: rule.label, rate: rule.rate, spendCents: spend, units: (spend / 100) * rule.rate, capped: false });
      continue;
    }
    const k = `${r.date.slice(0, 4)}|${rule.id}`;
    const room = Math.max(0, rule.capCents - (used.get(k) ?? 0));
    const inCap = Math.min(spend, room);
    used.set(k, (used.get(k) ?? 0) + spend);
    out.push({ ...base, ruleId: rule.id, label: rule.label, rate: rule.rate, spendCents: inCap, units: (inCap / 100) * rule.rate, capped: false });
    if (spend > inCap) out.push({ ...base, ruleId: rule.id, label: `${rule.label} (past the cap)`, rate: product.baseRate, spendCents: spend - inCap, units: ((spend - inCap) / 100) * product.baseRate, capped: true });
  }
  return out;
}

type PoolCard = { accountId: string; program: Program; centsPerPoint: number; statements: { id: string; start: string; end: string }[] };

/**
 * The printed balances grouped into the balances they are (a Membership Rewards account
 * shared by two cards is one pool), each reconciled stretch by stretch.
 * `expected` is each statement's expected rewards; `redemptions` the statement credits
 * that cashed rewards in (their dollars are rewards units for a cash back program).
 */
export function buildPools(input: {
  /** The year whose stretches `year` adds up. */
  year?: number;
  cards: PoolCard[];
  snapshots: StatementRewards[];
  expected: Map<string, number>;
  redemptions: { rowId: string; accountId: string; date: string; amountCents: number }[];
}): RewardsPool[] {
  const byAccount = new Map(input.cards.map((c) => [c.accountId, c]));
  const snaps = input.snapshots.filter((s) => byAccount.get(s.accountId)?.program.id === s.program);
  const dateOf = (s: StatementRewards) => s.asOf ?? s.statementEnd;

  // Group the cards: each card alone, except a shared program's cards, which are one
  // balance unless they ever print different balances on the same day.
  const groups: string[][] = [];
  const programs = new Map<string, PoolCard[]>();
  for (const c of input.cards) {
    if (c.program.kind === "NONE") continue;
    if (!c.program.pooled) groups.push([c.accountId]);
    else programs.set(c.program.id, [...(programs.get(c.program.id) ?? []), c]);
  }
  for (const cards of programs.values()) {
    const ids = cards.map((c) => c.accountId);
    const seen = new Map<string, number>();
    const conflict = snaps.some((s) => {
      if (!ids.includes(s.accountId)) return false;
      const d = dateOf(s);
      const b = seen.get(d);
      seen.set(d, s.balance);
      return b != null && b !== s.balance;
    });
    if (conflict) for (const id of ids) groups.push([id]);
    else groups.push(ids);
  }

  const pools: RewardsPool[] = [];
  for (const ids of groups) {
    const first = byAccount.get(ids[0]!)!;
    const program = first.program;
    const mine = snaps.filter((s) => ids.includes(s.accountId)).sort((a, b) => dateOf(a).localeCompare(dateOf(b)) || a.statementEnd.localeCompare(b.statementEnd));
    // One balance per day: the latest statement to print it.
    const balances: RewardsPool["balances"] = [];
    const snapByDate = new Map<string, StatementRewards>();
    for (const s of mine) snapByDate.set(dateOf(s), s);
    for (const [date, s] of [...snapByDate].sort(([a], [b]) => a.localeCompare(b))) balances.push({ date, balance: s.balance, statementId: s.statementId, accountId: s.accountId });

    const statements = ids.flatMap((id) => byAccount.get(id)!.statements.map((st) => ({ ...st, accountId: id })));
    const units = program.kind === "CASH";
    const stretches: Reconciliation[] = [];
    let prev: { date: string; balance: number } | null = null;
    for (const b of balances) {
      const s = snapByDate.get(b.date)!;
      if (s.earned != null && s.previous != null && ids.length === 1) {
        // The statement prints the cycle's own figures: nothing to infer.
        const own = statements.find((st) => st.id === s.statementId);
        const expected = input.expected.get(s.statementId) ?? 0;
        const from = own ? addDays(own.start, -1) : (prev?.date ?? b.date);
        const redemptionRows = input.redemptions.filter((r) => ids.includes(r.accountId) && r.date > from && r.date <= b.date);
        stretches.push({
          from,
          to: b.date,
          opening: s.previous,
          closing: s.balance,
          expected: Math.round(expected),
          posted: s.earned,
          redeemed: s.redeemed ?? 0,
          difference: Math.round(s.earned - expected),
          basis: "PRINTED",
          statementIds: [s.statementId],
          closingStatementId: s.statementId,
          redemptionRowIds: redemptionRows.map((r) => r.rowId),
        });
      } else if (prev) {
        const inStretch = statements.filter((st) => st.end > prev!.date && st.end <= b.date);
        const expected = inStretch.reduce((t, st) => t + (input.expected.get(st.id) ?? 0), 0);
        const redemptionRows = input.redemptions.filter((r) => ids.includes(r.accountId) && r.date > prev!.date && r.date <= b.date);
        // Cash back cashed in is the same dollars leaving the balance; points cashed in can't be counted in points.
        const knownRedeemed = units ? redemptionRows.reduce((t, r) => t + r.amountCents, 0) : 0;
        const gross = b.balance - prev.balance + knownRedeemed;
        const fell = gross < 0 || (expected >= 200 && gross < expected * 0.5);
        const posted = fell ? Math.round(expected) : gross;
        stretches.push({
          from: prev.date,
          to: b.date,
          opening: prev.balance,
          closing: b.balance,
          expected: Math.round(expected),
          posted,
          redeemed: fell ? Math.max(0, Math.round(prev.balance + expected - b.balance)) : knownRedeemed,
          difference: Math.round(posted - expected),
          basis: fell ? "INFERRED" : "BALANCES",
          statementIds: inStretch.map((st) => st.id),
          closingStatementId: b.statementId,
          redemptionRowIds: redemptionRows.map((r) => r.rowId),
        });
      }
      prev = { date: b.date, balance: b.balance };
    }
    if (balances.length) pools.push({ key: ids.join("+"), program, centsPerPoint: first.centsPerPoint, accountIds: ids, balances, stretches, year: { posted: 0, expected: 0, redeemed: 0 } });
  }
  for (const p of pools) {
    const mine = p.stretches.filter((s) => input.year != null && s.to.startsWith(`${input.year}-`));
    p.year = { posted: mine.reduce((t, s) => t + s.posted, 0), expected: mine.reduce((t, s) => t + s.expected, 0), redeemed: mine.reduce((t, s) => t + s.redeemed, 0) };
  }
  return pools;
}

/**
 * A card's share of what posted in its pool's stretches ending in `year`, split by each
 * card's expected rewards in the stretch; and the statements the stretches cover.
 */
export function postedForCard(pool: RewardsPool, accountId: string, year: number, expected: Map<string, number>, statementAccount: Map<string, string>): { posted: number; proven: number; covered: Set<string> } {
  let posted = 0;
  let proven = 0;
  const covered = new Set<string>();
  for (const s of pool.stretches) {
    for (const id of s.statementIds) covered.add(id);
    if (!s.to.startsWith(`${year}-`)) continue;
    const mine = s.statementIds.filter((id) => statementAccount.get(id) === accountId).reduce((t, id) => t + (expected.get(id) ?? 0), 0);
    const all = s.statementIds.reduce((t, id) => t + (expected.get(id) ?? 0), 0);
    const share = all > 0 ? mine / all : statementAccount.get(s.closingStatementId) === accountId ? 1 : 0;
    posted += s.posted * share;
    if (s.basis !== "INFERRED") proven += s.posted * share;
  }
  return { posted, proven, covered };
}
