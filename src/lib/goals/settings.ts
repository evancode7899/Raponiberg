import { GROUP_ORDER, type AccountGroup } from "../ledger/loadLedger.ts";
import { asObject, asString, isNum } from "../settingsStore.ts";

/**
 * The owner's savings goals. A goal names what it's for, how much (a fixed amount, or
 * months of spending for an emergency fund), by when, and which accounts fund it.
 * Progress is always read from those accounts' balances in the Book; nothing here is a
 * balance.
 *
 * How a goal uses its accounts:
 *  - SET_ASIDE (a bucket: emergency fund, down payment): it claims money, so two goals
 *    never count the same dollar. Goals are listed in priority order: when two draw on the
 *    same account, the earlier one claims first. A share caps how much of an account's
 *    balance the goal may claim (50% of the brokerage to the down payment, the rest free
 *    for the next goal), so one account can feed several goals at once.
 *  - TRACK (a milestone: "$1M net worth"): it counts the accounts' whole balances and claims
 *    nothing, so the same money still funds the bucket goals.
 */
export type Goal = {
  id: string;
  name: string;
  kind: "AMOUNT" | "EMERGENCY_FUND";
  /** AMOUNT: the target in cents. */
  targetCents: number | null;
  /** EMERGENCY_FUND: months of typical spending. */
  months: number | null;
  /** YYYY-MM-DD, or null for "whenever". */
  targetDate: string | null;
  /** Funded by every account in these groups… */
  groups: AccountGroup[];
  /** …plus these accounts. */
  accountIds: string[];
  funding: GoalFunding;
  /** SET_ASIDE: the most this goal may claim of an account's balance (0–1, by account id); absent means all of it. */
  shares: Record<string, number>;
};

export type GoalFunding = "SET_ASIDE" | "TRACK";

export type GoalSettings = { version: 1; goals: Goal[] };

export const GOALS_KEY = "goals.v1";

const date = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

export function normalizeGoals(raw: unknown): GoalSettings {
  const r = asObject(raw);
  const list: unknown[] = Array.isArray(r.goals) ? r.goals : [];
  const goals: Goal[] = list.slice(0, 50).flatMap((g) => {
    const o = asObject(g);
    const id = asString(o.id, 40);
    const kind = o.kind === "EMERGENCY_FUND" ? "EMERGENCY_FUND" : "AMOUNT";
    if (!id) return [];
    return [
      {
        id,
        name: asString(o.name, 80) || "Untitled goal",
        kind,
        targetCents: kind === "AMOUNT" && isNum(o.targetCents) && o.targetCents > 0 ? Math.round(o.targetCents) : null,
        months: kind === "EMERGENCY_FUND" && isNum(o.months) && o.months > 0 && o.months <= 36 ? o.months : kind === "EMERGENCY_FUND" ? 6 : null,
        targetDate: date(o.targetDate),
        groups: (Array.isArray(o.groups) ? o.groups : []).filter((x): x is AccountGroup => GROUP_ORDER.includes(x as AccountGroup) && x !== "Credit cards"),
        accountIds: (Array.isArray(o.accountIds) ? o.accountIds : []).filter((x): x is string => typeof x === "string").slice(0, 50),
        funding: o.funding === "TRACK" ? "TRACK" : "SET_ASIDE",
        shares: Object.fromEntries(
          Object.entries(asObject(o.shares))
            .filter((e): e is [string, number] => isNum(e[1]) && e[1] >= 0 && e[1] < 1 && e[0].length <= 40)
            .slice(0, 50),
        ),
      },
    ];
  });
  return { version: 1, goals };
}
