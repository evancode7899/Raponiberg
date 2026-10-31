import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";
import type { TaxDocsFile } from "./types.ts";

/**
 * The tax documents reader's version: bump when a parser changes what it reads, and every
 * PDF is read again on the next scan. Kept here (not in scan.ts) so the integrity checks
 * can compare a stored scan against it without loading the PDF libraries.
 */
export const TAX_DOCS_VERSION = 3;

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

/** The scanned documents, or null before the first scan. A damaged file reads as none here (the scanner rebuilds it); the Book reads it with readTaxDocsChecked. */
export function readTaxDocs(file = taxDocsFile()): TaxDocsFile | null {
  return readTaxDocsChecked(file).docs;
}

/**
 * The scanned documents, and why the file can't be read when it's damaged. The Book
 * reports that as a finding (check data.readable) instead of reading it as "never scanned":
 * a finished year's W-2s and filed return are its figures of record, and their silent
 * absence would put the ledger's figures in their place unchecked.
 */
export function readTaxDocsChecked(file = taxDocsFile()): { docs: TaxDocsFile | null; error?: string } {
  if (!existsSync(file)) return { docs: null };
  try {
    const f = JSON.parse(readFileSync(file, "utf8")) as TaxDocsFile;
    if (Array.isArray(f.docs)) return { docs: f };
    return { docs: null, error: `The tax documents scan (${path.basename(file)}) is damaged: it has no list of documents. Scan the tax documents folder again (Statements).` };
  } catch (e) {
    return { docs: null, error: `The tax documents scan (${path.basename(file)}) can't be read: ${e instanceof Error ? e.message : String(e)}. Scan the tax documents folder again (Statements).` };
  }
}

/** Writes the scan atomically (a reader never sees half a file). */
export function writeTaxDocs(f: TaxDocsFile, file = taxDocsFile()): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(f, null, 1));
  renameSync(tmp, file);
}
