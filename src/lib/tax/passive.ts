import type { K1Form } from "../taxdocs/types.ts";
import { completeK1, k1Items } from "./k1.ts";
import { k1DetailFor, type K1DetailsFile } from "./k1DetailStore.ts";

/**
 * The passive-loss limit (Form 8582) for the household's partnerships. A passive activity's
 * loss is deductible only against passive income; what the year can't use is suspended and
 * carried to the next year, activity by activity, until there is passive income to absorb
 * it or the interest is given up entirely (a final K-1), when it is released in full. A
 * publicly traded partnership stands alone: its loss offsets only its own later income.
 *
 * Partnerships are the only passive activities the app knows, so a year's limit needs only
 * its K-1s and what earlier years left suspended.
 */

export type PassiveActivity = {
  /** The partnership (its EIN, or its name without one): what a suspended loss follows from year to year. */
  key: string;
  /** The year's net income (loss negative) from the activity, before the limit. */
  net: number;
  publiclyTraded: boolean;
  /** A final K-1: the interest is given up, and every suspended loss is released. */
  final: boolean;
};

export type PassiveOutcome = {
  /** The loss carried in from earlier years (positive). */
  carryIn: number;
  /** What the year puts on the return for the activity: its income, less the losses allowed against it. */
  allowed: number;
  /** The loss carried to next year (positive). */
  suspended: number;
};

/** One year's limit: each activity's outcome, by key. Activities with only a carried-in loss are included. */
export function passiveLimit(activities: PassiveActivity[], carryIn: Record<string, number>): Record<string, PassiveOutcome> {
  const all: PassiveActivity[] = [...activities];
  for (const key of Object.keys(carryIn)) if (carryIn[key]! > 0 && !all.some((a) => a.key === key)) all.push({ key, net: 0, publiclyTraded: false, final: false });
  const out: Record<string, PassiveOutcome> = {};
  const pooled: { key: string; total: number }[] = [];
  for (const a of all) {
    const carry = carryIn[a.key] ?? 0;
    const total = a.net - carry;
    if (a.final && total < 0) out[a.key] = { carryIn: carry, allowed: total, suspended: 0 };
    else if (a.publiclyTraded) out[a.key] = { carryIn: carry, allowed: Math.max(0, total), suspended: Math.max(0, -total) };
    else pooled.push({ key: a.key, total });
    if (!out[a.key]) out[a.key] = { carryIn: carry, allowed: 0, suspended: 0 };
  }
  // Losses released by a final K-1 are deductible in full, and what they leave of the year's passive income is still there for the others.
  const income = pooled.filter((p) => p.total > 0).reduce((s, p) => s + p.total, 0);
  const losers = pooled.filter((p) => p.total < 0);
  const loss = -losers.reduce((s, p) => s + p.total, 0);
  for (const p of pooled.filter((x) => x.total >= 0)) out[p.key] = { ...out[p.key]!, allowed: p.total, suspended: 0 };
  // Each loss is allowed in proportion to its share of the year's losses (Form 8582 Part VII); the last takes the rounding.
  let left = Math.min(income, loss);
  losers.forEach((p, i) => {
    const used = i === losers.length - 1 ? left : Math.min(left, Math.round((Math.min(income, loss) * -p.total) / loss));
    left -= used;
    out[p.key] = { ...out[p.key]!, allowed: used ? -used : 0, suspended: -p.total - used };
  });
  return out;
}

type Docs = { year: number; k1s: { form: K1Form; personId: string | null }[] };

/**
 * What each finished year left suspended, from the first K-1 on file: `carryInto(year)` is
 * the loss each partnership brings into that year. Built from the K-1s and the details
 * file alone, year after year, so every later year's return starts from the same figures.
 */
export function passiveCarryforwards(years: Docs[], details: K1DetailsFile | { error: string } | null | undefined): (year: number) => Record<string, number> {
  const sorted = [...years].filter((y) => y.k1s.length).sort((a, b) => a.year - b.year);
  const after = new Map<number, Record<string, number>>();
  let carry: Record<string, number> = {};
  for (const y of sorted) {
    const acts: PassiveActivity[] = [];
    for (const k of y.k1s) {
      const detail = k1DetailFor(details, k.form.ein, y.year);
      const owner = detail?.owner ?? k.personId;
      if (owner == null) continue;
      const form = completeK1(k.form);
      const items = k1Items(form, detail);
      const key = passiveKey(form);
      // A loss from before the app's records comes in with the partnership's first K-1.
      if (detail?.openingSuspendedLoss && carry[key] == null) carry = { ...carry, [key]: detail.openingSuspendedLoss };
      if (items.passive) acts.push({ key, net: items.activity, publiclyTraded: form.publiclyTraded, final: form.final });
    }
    const result = passiveLimit(acts, carry);
    carry = Object.fromEntries(Object.entries(result).filter(([, o]) => o.suspended > 0).map(([key, o]) => [key, o.suspended]));
    after.set(y.year, carry);
  }
  return (year) => {
    const before = sorted.filter((y) => y.year < year).at(-1);
    return before ? (after.get(before.year) ?? {}) : {};
  };
}

export const passiveKey = (form: Pick<K1Form, "ein" | "partnership">) => form.ein ?? form.partnership;
