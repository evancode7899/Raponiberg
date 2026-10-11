import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { isPageInputKey, readPageInputs, writePageInputs } from "@/lib/pageInputs";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** A calculator page's saved inputs (see lib/pageInputs.ts): { value: object | null }. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { key } = await params;
  if (!isPageInputKey(key)) return NextResponse.json({ error: "Unknown inputs" }, { status: 404 });
  return NextResponse.json({ value: readPageInputs(key) });
}

/** Body: { value: object } — replaces that page's saved inputs. */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { key } = await params;
  if (!isPageInputKey(key)) return NextResponse.json({ error: "Unknown inputs" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { value?: unknown } | null;
  try {
    writePageInputs(key, body?.value);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
