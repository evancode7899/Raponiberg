import { inflateRawSync } from "node:zlib";

/**
 * Just enough of .xlsx to read a simple log kept in Excel: each worksheet as a grid of
 * cell values (strings and numbers; dates come through as Excel serial numbers, formulas
 * as their last calculated value). An .xlsx is a zip of XML parts, so this reads the zip's
 * central directory, inflates the parts it needs and pulls the cells out of the sheet XML.
 * No styles, no merged cells, no formulas evaluated: the importer only needs the values.
 */

export type Sheet = { name: string; rows: (string | number | null)[][] };

function unzip(buf: Buffer): Map<string, Buffer> {
  // End of central directory: the last 22+ bytes, signature 0x06054b50.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not an .xlsx file (no zip directory found)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Damaged .xlsx file (bad zip directory)");
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!/\.(xml|rels)$/.test(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compressed);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, inflateRawSync(data));
    else throw new Error(`Unsupported .xlsx compression (method ${method})`);
  }
  return files;
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");

/** All the text runs inside an element (<t>…</t>, possibly several for rich text). */
const textOf = (xml: string) => decode([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));

/** "AB12" → 27 (zero-based column). */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function readXlsx(bytes: Buffer): Sheet[] {
  const files = unzip(bytes);
  const shared = [...(files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!));

  // Sheet names and their parts, in workbook order.
  const workbook = files.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const rels = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/Id="([^"]+)"/.exec(m[0])?.[1] ?? "", /Target="([^"]+)"/.exec(m[0])?.[1] ?? ""]));
  const order = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const name = decode(/name="([^"]*)"/.exec(m[0])?.[1] ?? "Sheet");
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1] ?? "";
    const t = target.get(rid) ?? "";
    return { name, part: t.startsWith("/") ? t.slice(1) : `xl/${t.replace(/^\.\//, "")}` };
  });
  const parts = order.length ? order : [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort().map((part, i) => ({ name: `Sheet${i + 1}`, part }));

  return parts.flatMap(({ name, part }) => {
    const xml = files.get(part)?.toString("utf8");
    if (!xml) return [];
    const rows: (string | number | null)[][] = [];
    for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowNum = Number(/\br="(\d+)"/.exec(r[1]!)?.[1] ?? rows.length + 1) - 1;
      const cells: (string | number | null)[] = [];
      for (const c of (r[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]!;
        const body = c[2] ?? "";
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const col = ref ? columnIndex(ref) : cells.length;
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value: string | number | null = null;
        if (type === "s" && v != null) value = shared[Number(v)] ?? null;
        else if (type === "inlineStr") value = textOf(body);
        else if (type === "str" || type === "e") value = v != null ? decode(v) : null;
        else if (type === "b") value = v === "1" ? 1 : 0;
        else if (v != null && v !== "") value = Number.isFinite(Number(v)) ? Number(v) : decode(v);
        while (cells.length < col) cells.push(null);
        cells[col] = value;
      }
      while (rows.length < rowNum) rows.push([]);
      rows[rowNum] = cells;
    }
    return [{ name, rows }];
  });
}

/** An Excel date serial (1900 system) → YYYY-MM-DD. */
export function excelSerialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
}
