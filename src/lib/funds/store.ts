import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";
import type { FundDocsFile } from "./types.ts";

/**
 * data/fund-documents.json: what each imported private-fund document says (capital call
 * notices, capital statements), read once from the stored file, by document id. Gitignored
 * and backed up with the rest of data/. No Book figure reads it, so it isn't part of the
 * Book's data stamp (book/cache.ts); a lost file is rebuilt from the stored documents.
 */

export function fundDocsFile(): string {
  return process.env.FUND_DOCUMENTS_FILE || path.join(dataDir(), "fund-documents.json");
}

/** The last read, or null before the first. A damaged file reads as none: the next read rebuilds it. */
export function readFundDocs(file = fundDocsFile()): FundDocsFile | null {
  if (!existsSync(file)) return null;
  try {
    const f = JSON.parse(readFileSync(file, "utf8")) as FundDocsFile;
    return f && typeof f.files === "object" && f.files ? f : null;
  } catch {
    return null;
  }
}

/** Writes atomically (a reader never sees half a file). */
export function writeFundDocs(f: FundDocsFile, file = fundDocsFile()): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(f, null, 1));
  renameSync(tmp, file);
}
