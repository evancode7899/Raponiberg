import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import { importStatementFiles, type ImportProgress } from "@/lib/ingest/importFiles";
import { MAX_STATEMENT_UPLOAD_BYTES, bytesLabel, requestTooLarge, statementUploadProblem } from "@/lib/uploadLimits";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Upload one or more statement PDFs (form field "file", repeatable). Each is parsed by
 * the matching deterministic parser and committed through the same pipeline as the
 * bulk importer. The account is detected from the statement itself — no need to pick
 * one. Statements that tie out to the cent are committed; anything else waits for
 * review. Files no parser recognizes are reported for hand-parsing.
 *
 * With ?stream=1 the answer is a line of JSON per step as it happens (ImportProgress: each
 * file read, committed, settled), then { done: <the usual answer> }: the import page shows
 * each file's progress while the files still commit together, oldest first.
 */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Too big is refused before a byte is read (lib/uploadLimits.ts).
  if (requestTooLarge(request.headers.get("content-length"), MAX_STATEMENT_UPLOAD_BYTES)) {
    return NextResponse.json({ error: `An import may be up to ${bytesLabel(MAX_STATEMENT_UPLOAD_BYTES)} at once: import the files in smaller batches.` }, { status: 413 });
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
  const tooBig = statementUploadProblem(files);
  if (tooBig) return NextResponse.json({ error: tooBig }, { status: 413 });
  const review = form.get("review") === "true";

  const loaded = await Promise.all(files.map(async (f) => ({ fileName: f.name, bytes: Buffer.from(await f.arrayBuffer()) })));
  if (request.nextUrl.searchParams.get("stream") !== "1") return NextResponse.json(await importStatementFiles(prisma, loaded, { review }));
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      const line = (x: unknown) => c.enqueue(enc.encode(JSON.stringify(x) + "\n"));
      try {
        line({ done: await importStatementFiles(prisma, loaded, { review, onProgress: (p: ImportProgress) => line({ progress: p }) }) });
      } catch (e) {
        line({ error: e instanceof Error ? e.message : "Import failed" });
      }
      c.close();
    },
  });
  return new NextResponse(body, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
