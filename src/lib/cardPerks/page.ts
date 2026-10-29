import type { Prisma, PrismaClient } from "@prisma/client";
import { blockersFor } from "../book/blockers.ts";
import { cachedReport } from "../book/cache.ts";
import { refs, type BlockerRef } from "../book/reports/blockerRef.ts";
import { SKIPS_IDLE_STATEMENTS } from "../book/idleCards.ts";
import { readClosedAccounts } from "../ledger/closedAccounts.ts";
import { loadJsonSetting } from "../settingsStore.ts";
import { CARD_PRODUCTS } from "./catalog.ts";
import { buildCardPerks } from "./report.ts";
import { cardRewards, type CardDoc } from "./rewardsScan.ts";
import { CARD_PERKS_KEY, normalizeCardPerks, type CardPerksSettings } from "./settings.ts";
import type { CardAccount, CardPerksReport, PerkRow, StatementRewards } from "./types.ts";

type Db = PrismaClient | Prisma.TransactionClient;

export type CardPerksPage = CardPerksReport & {
  blockers: BlockerRef[];
  /** Card statements whose rewards summary is still being read (the page asks again until 0). */
  reading: number;
};

export type CardPerksResponse = { report: CardPerksPage; settings: CardPerksSettings };

type Inputs = {
  today: string;
  accounts: CardAccount[];
  rows: PerkRow[];
  householdRows: PerkRow[];
  /** The stored card statement files, for their rewards summaries. */
  docs: CardDoc[];
  /** Card statements by the document they were read from. */
  byDocument: Record<string, { statementId: string; accountId: string; end: string }[]>;
  /** Open cash-flow findings on the cards, by year. */
  blockers: Record<string, BlockerRef[]>;
};

/** Merchants of in-app perks: their charges count from any account, not just cards. */
const IN_APP = new RegExp(
  CARD_PRODUCTS.flatMap((p) => p.perks.filter((x) => x.inApp && x.merchants).map((x) => x.merchants!)).join("|") || "$^",
  "i",
);

/**
 * The Card perks page as GET /api/card-perks serves it: the credit card accounts, their
 * statements and rows from the cached Book, joined per request to the rewards summaries
 * read from the statements (rewardsScan.ts) and the owner's choices.
 */
export async function loadCardPerksPage(db: Db, year?: number): Promise<CardPerksResponse> {
  const [settings, inputs] = await Promise.all([
    loadJsonSetting(db, CARD_PERKS_KEY, normalizeCardPerks),
    cachedReport(db, "card-perks-inputs", (book): Inputs => {
      const closed = readClosedAccounts().accounts;
      const cards = book.accounts.filter((a) => a.type === "CREDIT_CARD");
      const ids = new Set(cards.map((a) => a.id));
      const byDocument: Inputs["byDocument"] = {};
      const accounts: CardAccount[] = cards.map((a) => ({
        id: a.id,
        name: a.name,
        institution: a.institution,
        closed: a.archived || closed.some((c) => c.institution === a.institution && a.identifiers.includes(c.identifier)),
        skipsIdle: SKIPS_IDLE_STATEMENTS.some((x) => (a.institution ?? "").toUpperCase().includes(x.institution)),
        statements: book.statements
          .filter((s) => s.accountId === a.id && !s.isSummary && s.status === "COMMITTED")
          .sort((x, y) => x.periodStart.localeCompare(y.periodStart))
          .map((s) => {
            (byDocument[s.documentId] ??= []).push({ statementId: s.id, accountId: a.id, end: s.periodEnd });
            return { id: s.id, start: s.periodStart, end: s.periodEnd };
          }),
      }));
      const toRow = (r: (typeof book.rows)[number]): PerkRow => ({
        id: r.id,
        date: r.date,
        amountCents: r.amountCents,
        lane: r.lane,
        accountId: r.accountId,
        payee: r.payee,
        detail: r.detail ?? null,
        section: r.section ?? null,
        category: r.category,
        classifiedBy: r.classifiedBy,
        statementId: r.statementImportId,
      });
      const rows = book.rows.filter((r) => ids.has(r.accountId) && !r.pending && !r.reimbursement);
      const householdRows = book.rows.filter((r) => !ids.has(r.accountId) && !r.pending && r.amountCents < 0 && r.lane === "EXPENSE" && IN_APP.test(`${r.payee} ${r.detail ?? ""}`));
      const blockers: Inputs["blockers"] = {};
      const years = new Set(accounts.flatMap((a) => a.statements.map((s) => s.end.slice(0, 4))));
      for (const y of years) {
        const to = `${y}-12-31` < book.horizon.cashFlow ? `${y}-12-31` : book.horizon.cashFlow;
        if (`${y}-01-01` <= to) blockers[y] = refs(blockersFor(book, { affects: "CASH_FLOW", from: `${y}-01-01`, to, accountIds: [...ids] }));
      }
      const docs = book.documents.flatMap((d) => (byDocument[d.id] && d.file ? [{ id: d.id, fileHash: d.file.sha, filePath: d.file.path }] : []));
      return { today: book.today, accounts, rows: rows.map(toRow), householdRows: householdRows.map(toRow), docs, byDocument, blockers };
    }).then((t) => JSON.parse(t) as Inputs),
  ]);
  const rewards = cardRewards(inputs.docs);

  const snapshots: StatementRewards[] = [];
  for (const [docId, e] of Object.entries(rewards.file.docs)) {
    if (!e.rewards) continue;
    for (const s of inputs.byDocument[docId] ?? []) snapshots.push({ ...e.rewards, accountId: s.accountId, statementId: s.statementId, statementEnd: s.end });
  }
  const report = buildCardPerks({ settings, accounts: inputs.accounts, rows: inputs.rows, householdRows: inputs.householdRows, snapshots, today: inputs.today, year });
  return { report: { ...report, blockers: inputs.blockers[String(report.year)] ?? [], reading: rewards.pending }, settings };
}
