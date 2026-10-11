import { PDFParse } from "pdf-parse";
import { renderLayout, rowsFromItems, type PositionedItem } from "./pdfLayout.ts";

/**
 * Documents whose plain text loses which amount belongs to which row. For these the
 * positioned layout is appended (see pdfLayout.ts); every other document's text, and so
 * its content fingerprint, is unchanged.
 */
const NEEDS_LAYOUT: RegExp[][] = [[/Earnings Statement/, /ADP, Inc\./]];

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

async function positionedItems(buffer: Buffer): Promise<PositionedItem[]> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // verbosity 0: text extraction doesn't need the standard font files pdf.js warns about.
  const doc = await getDocument({ data: new Uint8Array(buffer), verbosity: 0 }).promise;
  try {
    const out: PositionedItem[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      for (const it of content.items) {
        if (!("str" in it)) continue;
        out.push({ page: p, x: it.transform[4], y: it.transform[5], width: it.width, str: it.str });
      }
    }
    return out;
  } finally {
    await doc.destroy();
  }
}
