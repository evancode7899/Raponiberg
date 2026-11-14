import type { Prisma, PrismaClient } from "@prisma/client";
import { cachedReport } from "../book/cache.ts";
import type { Book } from "../book/load.ts";
import { fundDocsFor, fundManagers } from "./read.ts";
import { buildLpFunds, type FundWire, type LpAccount, type LpFund } from "./report.ts";
import type { FundSource } from "./types.ts";

type Db = PrismaClient | Prisma.TransactionClient;

export type FundsPage = {
  funds: LpFund[];
  /** Fund documents that couldn't be read. */
  errors: { title: string; error: string }[];
};

type BookPart = {
  docs: FundSource[];
  accounts: LpAccount[];
  wires: FundWire[];
  funds: { statementName: string; institution: string }[];
};

/** The Book's side: which documents are a fund's, its accounts, and the bank's wires to and from each manager. */
function bookPartOf(book: Book): BookPart {
  const managers = fundManagers(book.household.funds, book.documents);
  const fundAccounts = new Set(book.accounts.filter((a) => a.institution && managers.has(a.institution)).map((a) => a.id));
  const name = new Map(book.accounts.map((a) => [a.id, a.name]));
  return {
    docs: book.documents.filter((d) => managers.has(d.institution)).map((d) => ({ documentId: d.id, title: d.title })),
    accounts: book.accounts.filter((a) => fundAccounts.has(a.id)).map((a) => ({ id: a.id, name: a.name, institution: a.institution, identifiers: a.identifiers })),
    wires: book.rows
      .filter((r) => r.lane === "TRANSFER" && !r.pending && r.counterpartyInstitution && managers.has(r.counterpartyInstitution) && !fundAccounts.has(r.accountId))
      .map((r) => ({ id: r.id, date: r.bookedOn, amountCents: r.amountCents, accountName: name.get(r.accountId) ?? "", institution: r.counterpartyInstitution! })),
    funds: book.household.funds.map((f) => ({ statementName: f.statementName, institution: f.institution })),
  };
}
const bookPart = (db: Db, book?: Book): Promise<BookPart> =>
  // The sweep passes its own Book; the route reads the cached one (through JSON either way).
  book ? Promise.resolve(JSON.parse(JSON.stringify(bookPartOf(book))) as BookPart) : cachedReport(db, "lp-funds", bookPartOf).then((t) => JSON.parse(t) as BookPart);

/** The LP view as GET /api/investments/funds serves it. */
export async function loadFundsPage(db: Db, book?: Book): Promise<FundsPage> {
  const part = await bookPart(db, book);
  const file = await fundDocsFor(
    db,
    part.docs.map((d) => d.documentId),
    part.funds.map((f) => f.statementName),
  );
  const title = new Map(part.docs.map((d) => [d.documentId, d.title]));
  const docs = part.docs.flatMap((s) => {
    const doc = file.files[s.documentId]?.doc;
    return doc ? [{ source: s, doc }] : [];
  });
  return {
    funds: buildLpFunds({ docs, accounts: part.accounts, wires: part.wires, managers: part.funds }),
    errors: Object.entries(file.files).flatMap(([id, e]) => (e.error ? [{ title: title.get(id) ?? id, error: e.error }] : [])),
  };
}
