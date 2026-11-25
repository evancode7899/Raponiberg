import type { SpendingKind, SpendingReport } from "@/lib/book/reports/spending";
import { CATEGORIES } from "@/lib/classifier/taxonomy";

export { buildInsights, categoryCents, proofTarget, SPEND_CATEGORIES, totals, type Insight, type InsightProofs, type ProofOf, type ProofOptions, type Seg, type Totals } from "@/lib/insights/cashFlow";
export {
  byYear,
  mergeCategories,
  median,
  merchantMovers,
  mergeMerchants,
  monthDrillMerchants,
  monthKey,
  quietMerchants,
  shiftMonth,
  sliceRange,
  sliceStart,
  sum,
  topPayers,
  trailing,
  type MerchantTotal,
  type RangeId,
  type Slice,
} from "@/lib/book/reports/cashFlowWindows";

export type Report = SpendingReport & { accounts: { id: string; name: string }[] };
/** Fixed chart slot per category (eight slots; the rest share the neutral "Other" color). */
const CATEGORY_SLOT: Record<string, number> = {
  "Housing & utilities": 0,
  Groceries: 2,
  Transportation: 3,
  "Health & insurance": 6,
  Dining: 1,
  "Shopping & gifts": 4,
  "Travel & entertainment": 5,
};
export const categorySlot = (c: string): number | null => CATEGORY_SLOT[c] ?? null;
export const categoryGroup = (c: string) => CATEGORIES.find((x) => x.name === c)?.group ?? "Other";
export const SPEND_GROUPS = ["Essentials", "Lifestyle", "Financial"] as const;


export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The three kinds of spending, in stacking order, with what each means (spending.ts spendingKindRule). */
export const KINDS = [
  { id: "billCents", kind: "bill", label: "Bills & subscriptions", hint: "rent and steady charges from recurring merchants" },
  { id: "everydayCents", kind: "everyday", label: "Everyday", hint: "day-to-day charges under $1,500, net of their refunds" },
  { id: "bigCents", kind: "big", label: "Big & one-off", hint: "single charges of $1,500+, anything marked one-off, taxes, and big merchant refunds" },
] as const satisfies readonly { id: string; kind: SpendingKind; label: string; hint: string }[];
