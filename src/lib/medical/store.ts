import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";
import type { MedicalDocsFile } from "./types.ts";

/**
 * data/medical-documents.json: the health coverage statements (EOBs) found in the
 * statements folder as last read (the parsed claims, never the PDFs), plus a note of every
 * other PDF seen there so a scan doesn't open it again. Gitignored and backed up with the
 * rest of data/. Kept apart from the scanner so the statement import can read it without
 * loading the PDF libraries. No Book figure reads it, so it isn't part of the Book's data
 * stamp (book/cache.ts).
 */

export function medicalDocsFile(): string {
  return process.env.MEDICAL_DOCUMENTS_FILE || path.join(dataDir(), "medical-documents.json");
}

/** The last scan, or null before the first. A damaged file reads as none: the next scan rebuilds it. */
export function readMedicalDocs(file = medicalDocsFile()): MedicalDocsFile | null {
  if (!existsSync(file)) return null;
  try {
    const f = JSON.parse(readFileSync(file, "utf8")) as MedicalDocsFile;
    return f && typeof f.files === "object" && f.files ? f : null;
  } catch {
    return null;
  }
}

/** Writes the scan atomically (a reader never sees half a file). */
export function writeMedicalDocs(f: MedicalDocsFile, file = medicalDocsFile()): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(f, null, 1));
  renameSync(tmp, file);
}

/** Content hashes of the health coverage documents on file: the folder scan leaves them out of the statement import. */
export function medicalHashes(f = readMedicalDocs()): Set<string> {
  return new Set(Object.values(f?.files ?? {}).flatMap((e) => (e.doc || e.error ? [e.sha] : [])));
}
