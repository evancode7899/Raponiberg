/** Em dash for exact numeric zero in displays (not rounded-to-zero values). */
export const EM_DASH = "\u2014";

function formatCurrencyAccounting(
  amountAbs: number,
  isNegative: boolean,
  minFrac: number,
  maxFrac: number,
): string {
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    signDisplay: "never",
    minimumFractionDigits: minFrac,
    maximumFractionDigits: maxFrac,
  }).format(amountAbs);
  return isNegative ? `(${formatted})` : formatted;
}

/**
 * USD in whole dollars (0 fraction digits). Exact zero → em dash; negatives → ($n).
 */
export function formatUsd(amountUsd: number): string {
  if (amountUsd === 0) {
    return EM_DASH;
  }
  return formatCurrencyAccounting(
    Math.abs(amountUsd),
    amountUsd < 0,
    0,
    0,
  );
}

/**
 * Integer cents → USD: whole dollars when there are no cents, otherwise exactly two
 * decimals ($5,056.10, never $5,056.1). Exact 0 cents → em dash.
 */
export function formatUsdCents(cents: number): string {
  if (cents === 0) {
    return EM_DASH;
  }
  const dollars = cents / 100;
  const frac = cents % 100 === 0 ? 0 : 2;
  return formatCurrencyAccounting(Math.abs(dollars), dollars < 0, frac, frac);
}

/** Integer cents → whole dollars ($1,235; negatives in parentheses). null → em dash. */
export function usd0(cents: number | null | undefined): string {
  if (cents == null) return EM_DASH;
  return formatUsd(Math.round(cents / 100));
}

/** Integer cents → short form for headlines and deltas: $916.7k, $1.24M, $820. */
export function usdCompact(cents: number | null | undefined): string {
  if (cents == null) return EM_DASH;
  const d = cents / 100;
  const a = Math.abs(d);
  const body =
    a >= 1_000_000
      ? `$${(a / 1_000_000).toFixed(2)}M`
      : a >= 10_000
        ? `$${(a / 1000).toFixed(1)}k`
        : `$${Math.round(a).toLocaleString("en-US")}`;
  return d < 0 ? `(${body})` : body;
}

/** Signed change for deltas: +$12.3k / −$4.1k. */
export function usdDelta(cents: number | null | undefined): string {
  if (cents == null) return EM_DASH;
  if (Math.round(cents / 100) === 0) return "$0";
  const body = usdCompact(Math.abs(cents));
  return cents > 0 ? `+${body}` : `−${body}`;
}

/** Axis ticks in dollars: $250k, $1.2M, −$40k. */
export function axisUsd(dollars: number): string {
  const a = Math.abs(dollars);
  const s = a >= 1_000_000 ? `$${(a / 1_000_000).toFixed(1)}M` : a >= 1000 ? `$${Math.round(a / 1000)}k` : `$${Math.round(a)}`;
  return dollars < 0 ? `−${s}` : s;
}

/**
 * Cents with fixed 2 decimals (pricing / micro-amounts). Exact 0 → em dash.
 */
export function formatUsdFromCents(cents: number): string {
  if (cents === 0) {
    return EM_DASH;
  }
  const dollars = cents / 100;
  return formatCurrencyAccounting(Math.abs(dollars), dollars < 0, 2, 2);
}

/**
 * Ratio in 0–1 space (e.g. 0.065 → 6.5%). Exact 0 → em dash; negatives → (6.5%).
 */
export function formatPercentRatio(ratio: number, maxFractionDigits = 2): string {
  if (ratio === 0) {
    return EM_DASH;
  }
  const neg = ratio < 0;
  const abs = Math.abs(ratio);
  const formatted = new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: maxFractionDigits,
    signDisplay: "never",
  }).format(abs);
  return neg ? `(${formatted})` : formatted;
}
