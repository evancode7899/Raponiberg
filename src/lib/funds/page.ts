import type { Prisma, PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cachedReport } from "../book/cache.ts";
import type { Book } from "../book/load.ts";
import { storedDocumentFiles } from "../ingest/importFiles.ts";
import { LP_CAPITAL_PARSER_ID } from "../ingest/parsers/lpCapitalStatement.ts";
import { extractPdfText } from "../statements/extractPdfText.ts";
import { FUND_READER_VERSION, parseFundDoc } from "./parse.ts";
import { buildLpFunds, type FundWire, type LpAccount, type LpFund } from "./report.ts";
import { readFundDocs, writeFundDocs } from "./store.ts";
import type { FundDocsFile, FundFileEntry, FundSource } from "./types.ts";

type Db = PrismaClient | Prisma.TransactionClient;

export type FundsPage = {
  funds: LpFund[];
  /** Fund documents that couldn't be read. */
  errors: { title: string; error: string }[];
};

/** Supporting paperwork no household file names is filed under this (ingest/parsers/supporting.ts). */
const UNNAMED_FUND = "Private fund";

type BookPart = {
  docs: FundSource[];
  accounts: LpAccount[];
  wires: FundWire[];
  funds: { statementName: string; institution: string }[];
};

/** The Book's side: which documents are a fund's, its accounts, and the bank's wires to and from each manager. */
function bookPartOf(book: Book): BookPart {
  const managers = new Set<string>([UNNAMED_FUND, ...book.household.funds.map((f) => f.institution)]);
  for (const d of book.documents) if (d.parserId === LP_CAPITAL_PARSER_ID) managers.add(d.institution);
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

/**
 * Reads each fund document's stored file once into data/fund-documents.json; a document
 * already read by this reader version (same file hash) isn't opened again.
 */
async function readDocs(db: Db, ids: string[], knownFunds: string[]): Promise<FundDocsFile> {
  const previous = readFundDocs();
  const files: Record<string, FundFileEntry> = {};
  const stored = await storedDocumentFiles(db, ids);
  let changed = !previous || Object.keys(previous.files).some((id) => !ids.includes(id));
  for (const d of stored) {
    const old = previous?.files[d.id];
    if (old && old.sha === d.fileHash && old.version === FUND_READER_VERSION) {
      files[d.id] = old;
      continue;
    }
    changed = true;
    const entry: FundFileEntry = { sha: d.fileHash, version: FUND_READER_VERSION, doc: null };
    try {
      entry.doc = parseFundDoc(await extractPdfText(readFileSync(path.resolve(process.cwd(), d.filePath))), knownFunds);
    } catch (e) {
      entry.error = e instanceof Error ? e.message : String(e);
    }
    files[d.id] = entry;
  }
  const out: FundDocsFile = { version: 1, files };
  if (changed) writeFundDocs(out);
  return out;
}

// Concurrent requests share one read (on globalThis: each route is bundled separately).
const g = globalThis as unknown as { __pfFundDocs?: Promise<FundDocsFile> | null };

/** The LP view as GET /api/investments/funds serves it. */
export async function loadFundsPage(db: Db, book?: Book): Promise<FundsPage> {
  const part = await bookPart(db, book);
  g.__pfFundDocs ??= readDocs(
    db,
    part.docs.map((d) => d.documentId),
    part.funds.map((f) => f.statementName),
  ).finally(() => {
    g.__pfFundDocs = null;
  });
  const file = await g.__pfFundDocs;
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
