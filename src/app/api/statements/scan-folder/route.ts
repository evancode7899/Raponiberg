import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import { findNewFolderFiles, importStatementFiles, statementsFolder } from "@/lib/ingest/importFiles";
import { refreshTaxDocs } from "@/lib/taxdocs/scan";
import { taxDocsDir } from "@/lib/taxdocs/store";
import { summarizeTaxDocs } from "@/lib/taxdocs/summary";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Where the folder scan looks, so the Import tab can show it. */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ folder: statementsFolder() });
}

/**
 * Scans the statements folder (STATEMENTS_DIR, default "../Statements") for PDFs
 * whose bytes aren't imported yet and imports them like an upload, then reads the tax
 * documents folder (TAX_DOCS_DIR) again when one is set up. Body: { review?: boolean }.
 */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as { review?: unknown };
  let scan: Awaited<ReturnType<typeof findNewFolderFiles>>;
  try {
    scan = await findNewFolderFiles(prisma);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return NextResponse.json(
      { error: code === "ENOENT" ? `Statements folder not found: ${statementsFolder()} (set STATEMENTS_DIR to change it)` : `Could not scan folder: ${e instanceof Error ? e.message : e}` },
      { status: 400 },
    );
  }
  const result = await importStatementFiles(prisma, scan.files, { review: body.review === true });
  // The tax documents folder is the other source: its returns and forms are read on the same click.
  let taxDocuments: ReturnType<typeof summarizeTaxDocs> | { error: string } | null = null;
  if (taxDocsDir()) {
    try {
      const f = await refreshTaxDocs();
      taxDocuments = f ? summarizeTaxDocs(f) : { error: `Tax documents folder not found: ${taxDocsDir()}` };
    } catch (e) {
      taxDocuments = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return NextResponse.json({ folder: scan.folder, scanned: scan.total, ...result, taxDocuments });
}
