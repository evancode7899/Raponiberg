import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir, isDemo } from "../dataDir.ts";
import { extractPdfText } from "../statements/extractPdfText.ts";
import { RECEIPT_READER_VERSION, receiptFacts, type ReceiptFileFacts } from "./receipts.ts";

/**
 * Reads the HSA receipts folder (HSA_RECEIPTS_DIR) into data/hsa-receipts.json: each
 * file's date and the amounts printed in it (receipts.ts), never the file itself. A file
 * unchanged since the last scan (same modified time and size) isn't opened again, so
 * after the first scan a page load only stats the folder. Gitignored and backed up with
 * the rest of data/; the Book never reads it.
 */

const RECEIPT_EXT = /\.(pdf|png|jpe?g|heic|heif|gif|webp|tiff?)$/i;

type Entry = ReceiptFileFacts & { stamp: string; version: number };
type ScanFile = { version: 1; dir: string; files: Record<string, Entry> };

/** The receipts folder (HSA_RECEIPTS_DIR), or null when not set up. The demo has its own, never the real one. */
export function hsaReceiptsDir(env: Record<string, string | undefined> = process.env): string | null {
  if (isDemo(env)) return path.join(dataDir(env), "hsa-receipts");
  const d = env.HSA_RECEIPTS_DIR?.trim();
  return d ? path.resolve(d) : null;
}

export function hsaReceiptsScanFile(): string {
  return process.env.HSA_RECEIPTS_FILE || path.join(dataDir(), "hsa-receipts.json");
}

function readScan(file: string): ScanFile | null {
  if (!existsSync(file)) return null;
  try {
    const f = JSON.parse(readFileSync(file, "utf8")) as ScanFile;
    return f && typeof f.files === "object" && f.files ? f : null;
  } catch {
    return null;
  }
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.isFile() && RECEIPT_EXT.test(e.name) ? [p] : [];
  });
}

async function scan(dir: string, out: string): Promise<ReceiptFileFacts[]> {
  const previous = readScan(out);
  const prev = previous?.dir === dir ? previous.files : {};
  const files: Record<string, Entry> = {};
  let changed = !previous || previous.dir !== dir;
  for (const abs of walk(dir)) {
    const rel = path.relative(dir, abs).split(path.sep).join("/");
    const s = statSync(abs);
    const stamp = `${s.mtimeMs}:${s.size}`;
    const old = prev[rel];
    if (old && old.stamp === stamp && old.version === RECEIPT_READER_VERSION) {
      files[rel] = old;
      continue;
    }
    changed = true;
    let text: string | null = null;
    if (/\.pdf$/i.test(rel)) {
      try {
        text = await extractPdfText(readFileSync(abs));
      } catch {
        /* unreadable PDF: kept as a dated file with no text */
      }
    }
    files[rel] = { ...receiptFacts(rel, text), stamp, version: RECEIPT_READER_VERSION };
  }
  if (Object.keys(prev).some((rel) => !(rel in files))) changed = true;
  if (changed) {
    const tmp = `${out}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, dir, files } satisfies ScanFile, null, 1));
    renameSync(tmp, out);
  }
  return Object.values(files).map(({ stamp: _s, version: _v, ...facts }) => facts);
}

// Concurrent requests share one scan (on globalThis: each route is bundled separately).
const g = globalThis as unknown as { __pfHsaReceiptScan?: Promise<ReceiptFileFacts[]> | null };

/** The receipts folder as it is now: null when it isn't set up or doesn't exist. */
export async function scanHsaReceipts(dir = hsaReceiptsDir()): Promise<{ dir: string; files: ReceiptFileFacts[] } | null> {
  if (!dir) return null;
  try {
    if (!statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  g.__pfHsaReceiptScan ??= scan(dir, hsaReceiptsScanFile()).finally(() => {
    g.__pfHsaReceiptScan = null;
  });
  return { dir, files: await g.__pfHsaReceiptScan };
}

/** A receipt's absolute path, or null when `rel` isn't a receipt inside the folder (no climbing out of it). */
export function receiptPath(rel: string, dir = hsaReceiptsDir()): string | null {
  if (!dir || !RECEIPT_EXT.test(rel)) return null;
  const abs = path.resolve(dir, rel);
  const inside = path.relative(dir, abs);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) return null;
  return existsSync(abs) ? abs : null;
}
