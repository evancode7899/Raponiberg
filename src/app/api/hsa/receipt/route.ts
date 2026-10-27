import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { receiptPath } from "@/lib/hsa/receiptScan";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

/** One file from the HSA receipts folder (?file=path inside it), to open from the receipts log. */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const abs = receiptPath(request.nextUrl.searchParams.get("file") ?? "");
  if (!abs) return NextResponse.json({ error: "No such receipt in the receipts folder" }, { status: 404 });
  const ext = path.extname(abs).toLowerCase();
  return new NextResponse(new Uint8Array(await readFile(abs)), {
    headers: {
      "Content-Type": TYPES[ext] ?? "application/octet-stream",
      "Content-Disposition": `inline; filename="${path.basename(abs).replace(/"/g, "")}"`,
      "Cache-Control": "no-store",
    },
  });
}
