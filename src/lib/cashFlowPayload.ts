import type { Prisma, PrismaClient } from "@prisma/client";
import { cachedBuilt, stampTag, type Built } from "./book/cache.ts";
import type { Book } from "./book/load.ts";
import { buildSpendingReport } from "./book/reports/spending.ts";
import { leanReport, merchantsOf } from "./cashFlowParts.ts";
import { loadProfileSettings } from "./profile/settings.ts";

type Db = PrismaClient | Prisma.TransactionClient;
type Report = ReturnType<typeof buildSpendingReport> & { accounts: { id: string; name: string }[] };
const BUILT = new WeakMap<Book, Map<string, Promise<Report>>>();

/**
 * Cash flow's payload as GET /api/dashboard/cash-flow serves it, and as its page sends it with
 * the first draw (parts: cashFlowParts.ts): the whole report, the report without its merchant
 * lists ("lean") or the lists alone ("merchants"), the parts built from one report per Book.
 */
export function cashFlowPayload(db: Db, accountIds: string[] | undefined, parts: "lean" | "merchants" | null): Promise<Built> {
  const key = `cash-flow|${accountIds?.join(",") ?? ""}`;
  const build = (book: Book) => {
    const mine = BUILT.get(book) ?? new Map<string, Promise<Report>>();
    BUILT.set(book, mine);
    const hit = mine.get(key);
    if (hit) return hit;
    const made = loadProfileSettings(db).then((settings) => ({
      ...buildSpendingReport(book, settings, { accountIds }),
      accounts: book.ledger.accounts.filter((a) => !a.isInvestment).map((a) => ({ id: a.id, name: a.name })),
    }));
    mine.set(key, made);
    return made;
  };
  if (parts === "lean") return cachedBuilt(db, `${key}|lean`, async (book) => leanReport(await build(book)));
  if (parts === "merchants") return cachedBuilt(db, `${key}|merchants`, async (book) => merchantsOf(await build(book)));
  return cachedBuilt(db, key, build);
}

/** An answer sent with the page's first draw: the GET path it answers, its body and its data tag (as x-data-stamp carries it). */
export type FirstData = { path: string; body: string; stamp: string };

export const firstData = (path: string, b: Built): FirstData => ({ path, body: b.body, stamp: stampTag(b.stamp) });
