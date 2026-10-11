import { PDFParse } from "pdf-parse";
import { rowsFromItems, type LayoutRow, type PositionedItem } from "../statements/pdfLayout.ts";

/**
 * A tax document as text plus positioned rows. Tax forms print their labels and amounts
 * as separate text runs (a W-2 box's amount sits under its label; a return's line value
 * sits right of its line number), so the parsers read positions, not the plain text.
 */
export type PdfPages = { text: string; rows: LayoutRow[]; pages: number };

/**
 * Some state forms embed a font whose codes are the characters shifted down by 29 (space
 * prints as \u0003, "00" as \u0013\u0013, "Wages" as ":DJHV"). Text carrying those control
 * codes is decoded: the codes themselves, and every word in it made only of the shifted
 * range (no lowercase), which is how the font's words come out.
 */
export function unshift(s: string): string {
  if (!/[\u0001-\u001f]/.test(s)) return s;
  const shift = (w: string) => [...w].map((ch) => String.fromCharCode(ch.charCodeAt(0) + 29)).join("");
  return s
    .replace(/[\u0001-\u001f]/g, (ch) => shift(ch))
    .split(" ")
    .map((w) => (/^[!-^]+$/.test(w) && /[A-Z:;<=>?@[\\\]^]/.test(w) && !/^\d+\.?$/.test(w) ? shift(w) : w))
    .join(" ");
}

export async function readPdf(buffer: Buffer): Promise<PdfPages> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let text: string;
  try {
    text = (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ data: new Uint8Array(buffer), verbosity: 0 }).promise;
  try {
    const items: PositionedItem[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      for (const it of content.items) {
        if (!("str" in it)) continue;
        items.push({ page: p, x: it.transform[4], y: it.transform[5], width: it.width, str: unshift(it.str) });
      }
    }
    return { text, rows: rowsFromItems(items), pages: doc.numPages };
  } finally {
    await doc.destroy();
  }
}
