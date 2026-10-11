import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import { importStatementFiles } from "@/lib/ingest/importFiles";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Upload one or more statement PDFs (form field "file", repeatable). Each is parsed by
 * the matching deterministic parser and committed through the same pipeline as the
 * bulk importer. The account is detected from the statement itself — no need to pick
 * one. Statements that tie out to the cent are committed; anything else waits for
 * review. Files no parser recognizes are reported for hand-parsing.
 */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: 'Missing file field (use name "file")' }, { status: 400 });
  }
  const review = form.get("review") === "true";

  const loaded = await Promise.all(files.map(async (f) => ({ fileName: f.name, bytes: Buffer.from(await f.arrayBuffer()) })));
  return NextResponse.json(await importStatementFiles(prisma, loaded, { review }));
}
