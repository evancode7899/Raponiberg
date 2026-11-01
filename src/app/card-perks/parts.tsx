"use client";

import type { RewardKind } from "@/lib/cardPerks/catalog";
import type { CardScore, PeriodStatus } from "@/lib/cardPerks/types";
import { cardKey, cardPerksDerived, optKey, perkKey } from "@/lib/book/derived/cardPerks";
import { cellKey, derivedTarget } from "@/lib/book/derived/types";
import type { ProofRef } from "@/components/ui/proof/context";
import type { CardPerksPage } from "@/lib/cardPerks/page";
import { useMemo } from "react";
import { formatUsdCents, usd0 } from "@/lib/formatMoney";
import type { ReactNode } from "react";

export const fmtPoints = (n: number) => `${Math.round(n).toLocaleString("en-US")} pts`;
export const fmtCpp = (cpp: number) => `${+cpp.toFixed(2)}¢`;
/** Rewards in their own unit: points, or cents of cash back shown as dollars. */
export const fmtRewards = (kind: RewardKind, n: number, whole = false) => (kind === "CASH" ? (whole ? usd0(n) : formatUsdCents(n)) : kind === "POINTS" ? fmtPoints(n) : "—");
/** A rate: "4×" for points, "3%" for cash back. */
export const fmtRate = (kind: RewardKind, rate: number) => (kind === "CASH" ? `${+rate.toFixed(2)}%` : `${+rate.toFixed(2)}×`);
export const fmtDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export const fmtMonth = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
/** Dollars, saying $0 rather than a dash where the sentence needs a number. */
export const money = (cents: number) => (cents === 0 ? "$0" : usd0(cents));
export const pct = (r: number | null) => (r == null ? "—" : `${Math.round(r * 100)}%`);

/** What the card list says a card offers (its fee, rates, credit amounts): its terms, not a figure of yours. */
export const TERMS = "the card's terms, from the card list";

/** The page's figures for its year (lib/book/derived/cardPerks.ts), as proofs. */
export function useCardFigures(r: CardPerksPage) {
  const list = useMemo(() => cardPerksDerived(r), [r]);
  const y = r.year;
  const at = (figure: string, key: string): ProofRef => derivedTarget("card-perks", list, figure, key);
  return {
    year: (figure: string) => at(figure, String(y)),
    card: (accountId: string, what: string) => at("card", cardKey(y, accountId, what)),
    perk: (accountId: string, perkId: string, what: string) => at("perk", perkKey(y, accountId, perkId, what)),
    period: (accountId: string, perkId: string, period: string) => at("period", perkKey(y, accountId, perkId, period)),
    act: (accountId: string, perkId: string) => at("act", perkKey(y, accountId, perkId, "left")),
    opt: (row: string, col: string) => at("optimizer", optKey(y, row, col)),
    mix: (label: string) => at("mix", cellKey(y, label, "value")),
    pool: (pool: string, row: string, col: string) => at("pool", cellKey(y, `${pool}|${row}`, col)),
  };
}
export type CardFigures = ReturnType<typeof useCardFigures>;

/** A card's short name: the product's, without the issuer's boilerplate. */
export const shortName = (c: Pick<CardScore, "product" | "accountName">) =>
  (c.product?.name ?? c.accountName)
    .replace(/^The /, "")
    .replace(/ from American Express| Card from American Express/, "")
    .replace(/^American Express /, "Amex ");

export const STATUS: Record<PeriodStatus, { label: string; cls: string; hint: string }> = {
  USED: { label: "Used", cls: "bg-pos text-white border-pos", hint: "Used in full" },
  PARTIAL: { label: "Partly used", cls: "bg-warn-soft text-warn border-warn/50", hint: "Only part of it was used" },
  MISSED: { label: "Missed", cls: "bg-neg-soft text-neg border-neg/40", hint: "The period is over and the statements show no use" },
  OPEN: { label: "Available now", cls: "bg-accent-soft text-accent border-accent ring-1 ring-accent/40", hint: "Under way: still yours to use" },
  AWAITING: { label: "Awaiting statement", cls: "bg-info-soft text-info border-info/40", hint: "Over, but the statement that would show the credit isn't in yet" },
  FUTURE: { label: "Coming up", cls: "bg-surface-2 text-faint border-line", hint: "Hasn't started" },
  NOT_HELD: { label: "Card not held", cls: "border-dashed border-line text-faint", hint: "Before the card's first statement or after it closed" },
  NOT_OFFERED: { label: "Not offered", cls: "border-transparent text-faint opacity-40", hint: "The card didn't offer this then" },
};

/** A credit card's face, colored like the product. */
const FACES: Record<string, string> = {
  "amex-gold": "linear-gradient(135deg,#b8893a 0%,#e6c66f 45%,#a8792c 100%)",
  "amex-platinum": "linear-gradient(135deg,#8a8f98 0%,#d8dbe0 45%,#7c818a 100%)",
  "amex-green": "linear-gradient(135deg,#3f6b4a,#7fa483)",
  "amex-blue-cash-everyday": "linear-gradient(135deg,#1d4fa3 0%,#4f8be0 60%,#1a3f86 100%)",
  "amex-blue-cash-preferred": "linear-gradient(135deg,#0f2f6b,#2f6fd0)",
  "chase-freedom-unlimited": "linear-gradient(135deg,#0d3a75 0%,#2a6bc0 70%,#0b2f60 100%)",
  "chase-freedom-flex": "linear-gradient(135deg,#123d6e,#3a7cc4)",
  "chase-sapphire-preferred": "linear-gradient(135deg,#0d2c5a,#2b5ea6)",
  "chase-sapphire-reserve": "linear-gradient(135deg,#0b1a33,#2a3e63)",
  "capital-one-quicksilver": "linear-gradient(135deg,#6f7480 0%,#c9ccd2 50%,#666b76 100%)",
  "capital-one-platinum": "linear-gradient(135deg,#26303f,#4a5668)",
  "capital-one-savor": "linear-gradient(135deg,#5a2a20,#a4553f)",
  "capital-one-venture": "linear-gradient(135deg,#21324f,#3d5683)",
  "capital-one-venture-x": "linear-gradient(135deg,#111827,#374151)",
  "bilt-blue": "linear-gradient(135deg,#1c3f8f 0%,#3767c9 60%,#16336f 100%)",
  "bilt-obsidian": "linear-gradient(135deg,#0b0b0d,#2a2a30)",
  "bilt-palladium": "linear-gradient(135deg,#5d6066,#b4b7bd)",
  "bilt-mastercard": "linear-gradient(135deg,#0b0b0d,#2a2a30)",
};
const LIGHT_FACES = new Set(["amex-gold", "amex-platinum", "capital-one-quicksilver", "bilt-palladium"]);

export function CardFace({ c, small = false, children }: { c: CardScore; small?: boolean; children?: ReactNode }) {
  const id = c.product?.id ?? "";
  const dark = LIGHT_FACES.has(id);
  return (
    <div
      className={`relative overflow-hidden rounded-xl shadow-md ${small ? "h-10 w-16" : "aspect-[1.586] w-full max-w-[17rem]"} ${dark ? "text-[#1b1b1b]" : "text-white"}`}
      style={{ background: FACES[id] ?? "linear-gradient(135deg,#4b5563,#9ca3af)" }}
      aria-hidden={small}
    >
      <div className="pointer-events-none absolute -right-8 -top-10 h-32 w-32 rounded-full bg-white/15 blur-xl" />
      {!small && (
        <div className="relative flex h-full flex-col justify-between p-3.5">
          <div className="flex items-start justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider opacity-80">{c.product?.issuer ?? c.accountName}</span>
            <span className="h-5 w-7 rounded-[4px] bg-gradient-to-br from-yellow-200/90 to-yellow-500/80 shadow-inner" />
          </div>
          <div>
            <div className={`font-semibold leading-tight ${shortName(c).length > 18 ? "text-[13px]" : "text-[15px]"}`}>{shortName(c)}</div>
            <div className="num mt-1 flex items-center justify-between text-xs opacity-85">
              <span>•••• {c.last4 ?? "····"}</span>
              {children}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** A thin bar: used out of available. */
export function Meter({ used, of, tone = "pos" }: { used: number; of: number; tone?: "pos" | "warn" | "neg" | "accent" }) {
  const p = of > 0 ? Math.min(100, Math.round((used / of) * 100)) : 0;
  const bar = { pos: "bg-pos", warn: "bg-warn", neg: "bg-neg", accent: "bg-accent" }[tone];
  return (
    <div className="h-1.5 w-full min-w-12 overflow-hidden rounded-full bg-surface-3" role="meter" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full ${bar}`} style={{ width: `${p}%` }} />
    </div>
  );
}

/** Where a rewards figure came from. */
export function SourceTag({ source }: { source: CardScore["rewards"]["source"] }) {
  const s = {
    STATEMENTS: { t: "From statements", c: "text-pos", h: "Every cycle this year is proven by the rewards balance the statements print." },
    MIXED: { t: "Partly from statements", c: "text-info", h: "Proven by the statements' rewards balances where they print one; estimated from spending elsewhere." },
    ESTIMATE: { t: "Estimated", c: "text-muted", h: "The statements print no rewards balance for these cycles, so this is what the spending earns at the card's rates." },
    NONE: { t: "No rewards", c: "text-faint", h: "This card earns no rewards." },
  }[source];
  return (
    <span className={`text-[11px] font-medium ${s.c}`} title={s.h}>
      {s.t}
    </span>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">{children}</h3>
      {aside}
    </div>
  );
}
