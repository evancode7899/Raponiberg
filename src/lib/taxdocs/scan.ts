import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseBrokerage1099, parseInt1099, parseK1, parseR1099, parseSa5498 } from "./forms.ts";
import { readPdf } from "./pdf.ts";
import { parseReturns } from "./returns.ts";
import { readTaxDocs, taxDocsDir, writeTaxDocs } from "./store.ts";
import type { TaxDoc, TaxDocKind, TaxDocParsed, TaxDocsFile } from "./types.ts";
import { parseW2 } from "./w2.ts";

/**
 * The tax documents folder → data/tax-documents.json. The folder is TAX_DOCS_DIR (the
 * owner's filed returns and the forms behind them, one subfolder per year); nothing is
 * copied out of it. A PDF already read with this parser version is not read again.
 */

/** Bump when a parser changes what it reads: every PDF is then read again on the next scan. */
export const TAX_DOCS_VERSION = 1;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.isFile() && /\.pdf$/i.test(e.name) ? [p] : [];
  });
}

/** What a PDF is, from its text (and its file name for worksheets and previews). */
export function classify(text: string, file: string): TaxDocKind | "RETURN" {
  const name = path.basename(file);
  if (/WORKSHEET|WKSHT/i.test(name)) return "OTHER";
  if (/Statement of [Rr]emuneration|Canada Revenue Agency|T1 CONDENSED|\bT4\b.*\b20\d\d\b|Agence du revenu|TAX FORM T4|CPP contributions|Protected B\s+when completed/i.test(text)) return "FOREIGN";
  if (/U\.S\. Individual Income Tax Return|CT-1040|IT-201|IT-203\b/.test(text) && /adjusted gross income/i.test(text)) return "RETURN";
  if (/Wage and Tax Statement/i.test(text) && /W-2/.test(text)) return "W2";
  if (/TAX REPORTING STATEMENT/.test(text) && /1099-DIV/.test(text)) return "1099_BROKERAGE";
  if (/Schedule K-1/.test(text) && /Form 1065|Partner/.test(text)) return "K1";
  if (/Form 5498-SA/.test(text)) return "5498_SA";
  if (/FORM 1099-R|Form 1099-R/.test(text)) return "1099_R";
  if (/Form 1099-INT/.test(text)) return "1099_INT";
  if (/1099-INT/i.test(name) && text.trim().length < 200) return "1099_INT";
  return "OTHER";
}

/** The tax year: the folder named for it, else a year in the file name. */
export function docYear(rel: string): number | null {
  const parts = rel.split("/");
  for (const p of parts.slice(0, -1).reverse()) if (/^(19|20)\d\d$/.test(p)) return Number(p);
  const m = /\b(20\d\d)\b|(20\d\d)[-_ ]/.exec(parts.at(-1)!);
  return m ? Number(m[1] ?? m[2]) : null;
}

type Parsed = { parsed: TaxDocParsed; names: string[]; warnings: string[]; suffix: string };

async function parseFile(buffer: Buffer, rel: string): Promise<Parsed[]> {
  const pdf = await readPdf(buffer);
  const kind = classify(pdf.text, rel);
  if (kind === "RETURN") {
    const rets = parseReturns(pdf.rows, pdf.text);
    if (!rets.length) return [{ parsed: { kind: "OTHER" }, names: [], warnings: ["Looks like a return, but no form lines were read."], suffix: "" }];
    const kindOf = { FEDERAL: "RETURN_FEDERAL", CT: "RETURN_CT", NY: "RETURN_NY" } as const;
    return rets.map((ret) => ({
      parsed: { kind: kindOf[ret.jurisdiction], ret },
      names: [],
      warnings: ret.jurisdiction === "FEDERAL" && ret.federal?.agi == null ? ["The adjusted gross income line wasn't read."] : [],
      // One PDF can hold the federal and the state return: each is its own document.
      suffix: rets.length > 1 ? `#${ret.jurisdiction}` : "",
    }));
  }
  if (kind === "W2") {
    const { w2, warnings } = parseW2(pdf.rows);
    return [{ parsed: { kind, w2 }, names: [w2.employee], warnings, suffix: "" }];
  }
  if (kind === "1099_BROKERAGE") {
    const { f1099, warnings } = parseBrokerage1099(pdf.text);
    return [{ parsed: { kind, f1099 }, names: [f1099.recipient], warnings, suffix: "" }];
  }
  if (kind === "1099_INT") {
    if (pdf.text.replace(/--\s*\d+ of \d+\s*--/g, "").trim().length < 50) {
      return [{ parsed: { kind: "OTHER" }, names: [], warnings: ["This 1099-INT is a scanned image with no text; its interest is taken from the bank statements instead."], suffix: "" }];
    }
    const { int, warnings } = parseInt1099(pdf.rows, pdf.text);
    return [{ parsed: { kind, int }, names: [int.recipient], warnings, suffix: "" }];
  }
  if (kind === "1099_R") {
    const { r, warnings } = parseR1099(pdf.rows, pdf.text);
    return [{ parsed: { kind, r }, names: [r.recipient], warnings, suffix: "" }];
  }
  if (kind === "5498_SA") {
    const { sa, warnings } = parseSa5498(pdf.rows);
    return [{ parsed: { kind, sa }, names: [sa.recipient].filter(Boolean), warnings, suffix: "" }];
  }
  if (kind === "K1") {
    const { k1, warnings } = parseK1(pdf.rows, pdf.text);
    return [{ parsed: { kind, k1 }, names: [k1.partner], warnings, suffix: "" }];
  }
  return [{ parsed: { kind: kind as "FOREIGN" | "OTHER" }, names: [], warnings: [], suffix: "" }];
}

/**
 * Reads every PDF in the folder. Identical files (the same return saved twice) are one
 * document; returns that were rejected, previews, or older prints of the same year's
 * return are marked superseded.
 */
export async function scanTaxDocs(folder: string, previous: TaxDocsFile | null = readTaxDocs()): Promise<TaxDocsFile> {
  const known = new Map<string, TaxDoc[]>();
  if (previous?.version === TAX_DOCS_VERSION) {
    for (const d of previous.docs) {
      const base = d.id.split("#")[0]!;
      known.set(base, [...(known.get(base) ?? []), d]);
    }
  }
  const files = walk(folder).sort();
  const docs = new Map<string, TaxDoc>();
  const errors: TaxDocsFile["errors"] = [];
  for (const abs of files) {
    const rel = path.relative(folder, abs).split(path.sep).join("/");
    try {
      const buffer = readFileSync(abs);
      const sha = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
      const existing = [...docs.values()].filter((d) => d.id.split("#")[0] === sha);
      if (existing.length) {
        for (const d of existing) d.duplicates.push(rel);
        continue;
      }
      const reuse = known.get(sha);
      const parsed: Parsed[] = reuse
        ? reuse.map((d) => ({ parsed: d.parsed, names: d.names, warnings: d.warnings, suffix: d.id.slice(16) }))
        : await parseFile(buffer, rel);
      for (const p of parsed) {
        const id = sha + p.suffix;
        docs.set(id, { id, file: rel, duplicates: [], year: docYear(rel), kind: p.parsed.kind, superseded: null, names: p.names.filter(Boolean), parsed: p.parsed, warnings: p.warnings });
      }
    } catch (e) {
      errors.push({ file: rel, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // A file saved both in its year's folder and loose at the top belongs to the year's folder.
  for (const d of docs.values()) {
    const inYear = [d.file, ...d.duplicates].find((f) => docYear(f) != null && f.includes("/"));
    if (inYear && inYear !== d.file) {
      d.duplicates = [d.file, ...d.duplicates.filter((f) => f !== inYear)];
      d.file = inYear;
      d.year = docYear(inYear);
    }
  }
  markSuperseded([...docs.values()]);
  return { version: TAX_DOCS_VERSION, scannedAt: new Date().toISOString(), folder, docs: [...docs.values()], errors };
}

function markSuperseded(docs: TaxDoc[]) {
  for (const d of docs) {
    if (/reject/i.test(d.file)) d.superseded = "Rejected e-file; the accepted return is filed separately.";
  }
  const returns = docs.filter((d) => d.parsed.kind.startsWith("RETURN_") && !d.superseded);
  const groups = new Map<string, TaxDoc[]>();
  for (const d of returns) groups.set(`${d.year}|${d.kind}`, [...(groups.get(`${d.year}|${d.kind}`) ?? []), d]);
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const printed = (d: TaxDoc) => (d.parsed.kind.startsWith("RETURN_") ? ((d.parsed as { ret: { printedOn: string | null } }).ret.printedOn ?? "") : "");
    // The filed copy beats a preview; among the rest, the latest print wins.
    const ranked = [...group].sort((a, b) => Number(/preview/i.test(a.file)) - Number(/preview/i.test(b.file)) || printed(b).localeCompare(printed(a)));
    for (const d of ranked.slice(1)) d.superseded = /preview/i.test(d.file) ? "Filing preview; the filed copy is in another folder." : `Older copy; the return printed ${printed(ranked[0]!) || "later"} is used.`;
  }
}

/** Scans the configured folder and saves the result; null when no folder is configured or it's missing. */
export async function refreshTaxDocs(): Promise<TaxDocsFile | null> {
  const folder = taxDocsDir();
  if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) return null;
  const f = await scanTaxDocs(folder);
  writeTaxDocs(f);
  return f;
}
