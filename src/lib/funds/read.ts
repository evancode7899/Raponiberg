import type { Prisma, PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { householdPatterns } from "../household/householdFile.ts";
import { storedDocumentFiles, storedDocumentIndex } from "../ingest/importFiles.ts";
import { LP_CAPITAL_PARSER_ID } from "../ingest/parsers/lpCapitalStatement.ts";
import { extractPdfText } from "../statements/extractPdfText.ts";
import { FUND_READER_VERSION, parseFundDoc } from "./parse.ts";
import { readFundDocs, writeFundDocs } from "./store.ts";
import type { FundCall, FundDocsFile, FundFileEntry } from "./types.ts";

type Db = PrismaClient | Prisma.TransactionClient;

/** Supporting paperwork no household file names is filed under this (ingest/parsers/supporting.ts). */
export const UNNAMED_FUND = "Private fund";

/**
 * The institutions fund documents are filed under: the household file's funds, the
 * unnamed-fund folder, and whoever a capital statement on file was read for.
 */
export function fundManagers(funds: { institution: string }[], documents: { parserId: string; institution: string }[]): Set<string> {
  const managers = new Set<string>([UNNAMED_FUND, ...funds.map((f) => f.institution)]);
  for (const d of documents) if (d.parserId === LP_CAPITAL_PARSER_ID) managers.add(d.institution);
  return managers;
}

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

/** What the fund documents with these ids say, reading any not read yet. */
export function fundDocsFor(db: Db, ids: string[], knownFunds: string[]): Promise<FundDocsFile> {
  g.__pfFundDocs ??= readDocs(db, ids, knownFunds).finally(() => {
    g.__pfFundDocs = null;
  });
  return g.__pfFundDocs;
}

/**
 * Brings data/fund-documents.json up to date with the documents on file, before the
 * transfer matcher reads the notices in it (transfers/fundContributions.ts): a notice
 * imported a moment ago hasn't been opened by the fund view yet. Nothing is written for a
 * household with no fund documents.
 */
export async function refreshFundDocs(db: Db): Promise<void> {
  const household = householdPatterns();
  const documents = await storedDocumentIndex(db);
  const managers = fundManagers(household.funds, documents);
  const ids = documents.filter((d) => managers.has(d.institution)).map((d) => d.id);
  if (ids.length === 0 && !readFundDocs()) return;
  await fundDocsFor(db, ids, household.funds.map((f) => f.statementName));
}

/** The capital call notices read so far. */
export function fundCallsOnFile(): FundCall[] {
  return Object.values(readFundDocs()?.files ?? {}).flatMap((e) => (e.doc?.kind === "CALL" ? [e.doc] : []));
}
