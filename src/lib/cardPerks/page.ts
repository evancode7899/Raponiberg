import { blockersFor } from "../book/blockers.ts";
import type { Book } from "../book/load.ts";
import { refs, type BlockerRef } from "../book/reports/blockerRef.ts";
import { buildCardPerks, type CardAccount, type CardPerksReport } from "./report.ts";
import type { CardPerksSettings } from "./settings.ts";

export type CardPerksPage = CardPerksReport & { blockers: BlockerRef[] };

/**
 * The Card perks page's report, as GET /api/card-perks serves it: every credit card
 * account with the span its statements cover, scored for one calendar year, and the
 * cash-flow findings on those cards in that year (a missing statement can hide a credit).
 */
export function cardPerksPage(book: Book, settings: CardPerksSettings, year?: number): CardPerksPage {
  const cards = book.accounts.filter((a) => a.type === "CREDIT_CARD");
  const ids = new Set(cards.map((a) => a.id));
  const span = new Map<string, { from: string; through: string }>();
  for (const s of book.statements) {
    if (!ids.has(s.accountId) || s.isSummary || s.status !== "COMMITTED") continue;
    const x = span.get(s.accountId);
    span.set(s.accountId, { from: !x || s.periodStart < x.from ? s.periodStart : x.from, through: !x || s.periodEnd > x.through ? s.periodEnd : x.through });
  }
  const accounts: CardAccount[] = cards.map((a) => ({ id: a.id, name: a.name, institution: a.institution, archived: a.archived, from: span.get(a.id)?.from ?? null, through: span.get(a.id)?.through ?? null }));
  const report = buildCardPerks({ settings, accounts, rows: book.rows.filter((r) => ids.has(r.accountId) && !r.pending), today: book.today, year });
  const from = `${report.year}-01-01`;
  const to = `${report.year}-12-31` < book.horizon.cashFlow ? `${report.year}-12-31` : book.horizon.cashFlow;
  const blockers = from <= to && report.cards.length ? refs(blockersFor(book, { affects: "CASH_FLOW", from, to, accountIds: report.cards.map((c) => c.accountId) })) : [];
  return { ...report, blockers };
}
