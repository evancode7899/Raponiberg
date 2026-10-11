import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { isDemo } from "@/lib/dataDir";
import { refreshTaxDocs } from "@/lib/taxdocs/scan";
import { readTaxDocs, taxDocsDir } from "@/lib/taxdocs/store";
import { summarizeTaxDocs } from "@/lib/taxdocs/summary";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The tax documents folder (TAX_DOCS_DIR) as last scanned: per year, what was read. */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(summarizeTaxDocs(isDemo() ? null : readTaxDocs()));
}

/**
 * Reads the tax documents folder again: filed returns, W-2s, 1099s, K-1s. PDFs read before
 * (same bytes, same parser version) aren't opened again. The figures land in
 * data/tax-documents.json, which every tax figure picks up on the next request.
 */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isDemo()) return NextResponse.json({ error: "The demo has no tax documents folder." }, { status: 400 });
  if (!taxDocsDir()) {
    return NextResponse.json({ error: "No tax documents folder is set up. Add TAX_DOCS_DIR (the folder with your filed returns, one subfolder per year) to .env and restart." }, { status: 400 });
  }
  try {
    const f = await refreshTaxDocs();
    if (!f) return NextResponse.json({ error: `Tax documents folder not found: ${taxDocsDir()}` }, { status: 400 });
    return NextResponse.json(summarizeTaxDocs(f));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
