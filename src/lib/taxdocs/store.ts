import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";
import type { TaxDocsFile } from "./types.ts";

/**
 * The tax documents reader's version: bump when a parser changes what it reads, and every
 * PDF is read again on the next scan. Kept here (not in scan.ts) so the integrity checks
 * can compare a stored scan against it without loading the PDF libraries.
 */
export const TAX_DOCS_VERSION = 2;

/**
 * data/tax-documents.json: what the tax documents folder held when last scanned (the
 * parsed figures, never the PDFs). Gitignored and backed up with the rest of data/. Kept
 * apart from the scanner so the Book can read it without loading the PDF libraries.
 */

/** The folder holding the filed returns and the forms behind them (TAX_DOCS_DIR), or null when not set up. */
export function taxDocsDir(env: Record<string, string | undefined> = process.env): string | null {
  const d = env.TAX_DOCS_DIR?.trim();
  return d ? path.resolve(d) : null;
}

export function taxDocsFile(): string {
  return process.env.TAX_DOCUMENTS_FILE || path.join(dataDir(), "tax-documents.json");
}

/** The scanned documents, or null before the first scan. A damaged file reads as none: the next scan rebuilds it. */
export function readTaxDocs(file = taxDocsFile()): TaxDocsFile | null {
  if (!existsSync(file)) return null;
  try {
    const f = JSON.parse(readFileSync(file, "utf8")) as TaxDocsFile;
    return Array.isArray(f.docs) ? f : null;
  } catch {
    return null;
  }
}

/** Writes the scan atomically (a reader never sees half a file). */
export function writeTaxDocs(f: TaxDocsFile, file = taxDocsFile()): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(f, null, 1));
  renameSync(tmp, file);
}
