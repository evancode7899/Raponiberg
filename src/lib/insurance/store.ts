import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";
import type { InsuranceDocsFile } from "./types.ts";

/**
 * data/insurance-documents.json: the life insurance documents found in the statements
 * folder as last read (the parsed facts, never the PDFs), plus a note of every other PDF
 * seen there so a scan doesn't open it again. Gitignored and backed up with the rest of
 * data/. Kept apart from the scanner so the statement import can read it without
 * loading the PDF libraries. No Book figure reads it, so it isn't part of the Book's
 * data stamp (book/cache.ts).
 */

export function insuranceDocsFile(): string {
  return process.env.INSURANCE_DOCUMENTS_FILE || path.join(dataDir(), "insurance-documents.json");
}

/** The last scan, or null before the first. A damaged file reads as none: the next scan rebuilds it. */
export function readInsuranceDocs(file = insuranceDocsFile()): InsuranceDocsFile | null {
  if (!existsSync(file)) return null;
  try {
    const f = JSON.parse(readFileSync(file, "utf8")) as InsuranceDocsFile;
    return f && typeof f.files === "object" && f.files ? f : null;
  } catch {
    return null;
  }
}

/** Writes the scan atomically (a reader never sees half a file). */
export function writeInsuranceDocs(f: InsuranceDocsFile, file = insuranceDocsFile()): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(f, null, 1));
  renameSync(tmp, file);
}

/** Content hashes of the insurance documents on file: the folder scan leaves them out of the statement import. */
export function insuranceHashes(f = readInsuranceDocs()): Set<string> {
  return new Set(Object.values(f?.files ?? {}).flatMap((e) => (e.doc || e.error ? [e.sha] : [])));
}
