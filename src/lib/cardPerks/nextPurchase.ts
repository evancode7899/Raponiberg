import { SPEND_TYPES, spendType } from "./optimizer.ts";
import type { PerkRow, WalletTip } from "./types.ts";

/**
 * The next purchase: which held card to reach for, from a few words ("whole foods",
 * "flights", "uber"). The words are read the way the optimizer reads a statement row: a
 * kind of purchase by name, else the category the words suggest, else the merchant patterns
 * (airlines, hotels, gas, streaming…). Its answer is the wallet tip for that kind.
 */

/** Words that say which spending category a purchase falls in, for the kinds that go by category. */
const CATEGORY_WORDS: [RegExp, string][] = [
  [/dining|restaurant|coffee|cafe|café|\bbar\b|takeout|take-out|lunch|dinner|brunch|doordash|grubhub|seamless/i, "Dining"],
  [/grocer|supermarket|whole foods|trader joe|stop ?& ?shop|wegmans|safeway|kroger|aldi/i, "Groceries"],
  [/transit|train|subway|metro|\bbus\b|parking|toll|commut/i, "Transportation"],
  [/shop|amazon|online|etsy|ebay|wayfair/i, "Shopping & gifts"],
];

export function purchaseType(words: string): (typeof SPEND_TYPES)[number] | null {
  const t = words.trim();
  if (t.length < 2) return null;
  const lower = t.toLowerCase();
  const named = SPEND_TYPES.find((x) => x.key !== "other" && (x.key === lower || x.label.toLowerCase().startsWith(lower)));
  if (named) return named;
  const category = CATEGORY_WORDS.find(([re]) => re.test(t))?.[1] ?? "";
  // The online-shopping test wants a web merchant's name in the text, as a statement prints it.
  const payee = category === "Shopping & gifts" && !/\.COM|AMAZON|AMZN|ETSY|EBAY|WAYFAIR/i.test(t) ? `${t.toUpperCase()} .COM` : t.toUpperCase();
  return spendType({ payee, detail: null, category } as PerkRow);
}

/** The tip for the next purchase: the kind's own, else the "everything else" one. */
export function nextPurchase(words: string, tips: readonly WalletTip[]): { type: (typeof SPEND_TYPES)[number]; tip: WalletTip } | null {
  const type = purchaseType(words);
  if (!type) return null;
  const tip = tips.find((x) => x.key === type.key) ?? tips.find((x) => x.key === "other");
  return tip ? { type, tip } : null;
}
