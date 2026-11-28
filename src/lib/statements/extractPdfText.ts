import { PDFParse } from "pdf-parse";
import { renderLayout, rowsFromItems, type PositionedItem } from "./pdfLayout.ts";

/**
 * Documents whose plain text loses which amount belongs to which row. For these the
 * positioned layout is appended (see pdfLayout.ts); every other document's text, and so
 * its content fingerprint, is unchanged.
 */
const NEEDS_LAYOUT: RegExp[][] = [
  [/Earnings Statement/, /ADP, Inc\./],
  // Elan card statements: a credit's "CR" prints apart from its amount (parsers/elanCard.ts).
  [/Elan Financial Services/, /Account ending in: \d{4}/],
];

/** Plain text of every page, concatenated, for feeding to the extraction model. */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let text: string;
  try {
    text = (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
  if (NEEDS_LAYOUT.some((res) => res.every((re) => re.test(text)))) {
    text = `${text}\n\n${renderLayout(rowsFromItems(await positionedItems(buffer)))}\n`;
  }
  return text;
}

/**
 * Every text item with its page and position (the EOB reader assigns amounts to columns by it).
 * `unmirror`: some PDFs draw right-aligned values mirrored (a negative horizontal scale, so
 * "$1,000" comes out "000,1$"); with it, such a run is turned back round and placed where it
 * shows on the page (it runs leftward from its origin). Off by default, so the layouts other
 * readers rely on, and the fingerprints made from them, don't change.
 */
export async function positionedItems(buffer: Buffer, opts: { unmirror?: boolean } = {}): Promise<PositionedItem[]> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // verbosity 0: text extraction doesn't need the standard font files pdf.js warns about.
  const doc = await getDocument({ data: new Uint8Array(buffer), verbosity: 0 }).promise;
  try {
    const out: PositionedItem[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      for (const it of content.items) {
        if (!("str" in it)) continue;
        const mirrored = opts.unmirror && it.transform[0] < 0;
        out.push({ page: p, x: mirrored ? it.transform[4] - it.width : it.transform[4], y: it.transform[5], width: it.width, str: mirrored ? [...it.str].reverse().join("") : it.str });
      }
    }
    return out;
  } finally {
    await doc.destroy();
  }
}
