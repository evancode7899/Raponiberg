import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedReport } from "@/lib/book/cache";
import { prisma } from "@/lib/db";
import { previewImport } from "@/lib/hsa/importSheet";
import { hsaLedger, type HsaLedger } from "@/lib/hsa/load";
import { readHsaFile } from "@/lib/hsa/store";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Reads a receipts spreadsheet and previews the expenses in it, without saving anything:
 * multipart with a "file" (.xlsx or .csv), or JSON { text } for cells pasted from Excel.
 * Each expense says whether the log already has one on the same day for the same amount,
 * so importing the same sheet twice adds nothing. The page then saves the ones picked.
 */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let input: { fileName?: string; bytes?: Buffer; text?: string };
  if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    const f = form?.get("file");
    if (!(f instanceof File)) return NextResponse.json({ error: 'Missing file field (use name "file")' }, { status: 400 });
    if (f.size > MAX_BYTES) return NextResponse.json({ error: "That file is larger than 5 MB." }, { status: 400 });
    input = { fileName: f.name, bytes: Buffer.from(await f.arrayBuffer()) };
  } else {
    const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
    if (typeof body?.text !== "string" || !body.text.trim()) return NextResponse.json({ error: "Nothing pasted." }, { status: 400 });
    if (body.text.length > MAX_BYTES) return NextResponse.json({ error: "Too much pasted text." }, { status: 400 });
    input = { text: body.text };
  }
  try {
    const file = readHsaFile();
    const ledger = JSON.parse(await cachedReport(prisma, "hsa-ledger", (book) => hsaLedger(book))) as HsaLedger;
    const names = [...new Set([...ledger.persons, ...file.expenses.map((e) => e.patient)].filter(Boolean))];
    const preview = previewImport(input, names);
    const have = new Set(file.expenses.map((e) => `${e.date}|${e.amountCents}`));
    const seen = new Map<string, number>();
    const expenses = preview.expenses.map((e) => {
      const k = `${e.date}|${e.amountCents}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
      return { ...e, inLog: have.has(k), repeatInSheet: seen.get(k)! > 1 };
    });
    return NextResponse.json({ ...preview, expenses });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read that file" }, { status: 400 });
  }
}
