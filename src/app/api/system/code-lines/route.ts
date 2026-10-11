import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { codeLineCount } from "@/lib/codeLines";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Lines of code in the app (Settings › General). */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ lines: await codeLineCount() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not count lines (is git installed?)" }, { status: 500 });
  }
}
