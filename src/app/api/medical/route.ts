import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { dataStamp, stampTag } from "@/lib/book/cache";
import { prisma } from "@/lib/db";
import { loadMedicalPage } from "@/lib/medical/page";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Every health coverage statement (EOB) in the statements folder, joined into claims and years, with the plans on file (lib/medical). */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    // The stamp of the data read, taken before reading it: a change during the read makes it stale, never newer.
    const stamp = dataStamp();
    return NextResponse.json(await loadMedicalPage(prisma), { headers: { "x-data-stamp": stampTag(stamp) } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the health coverage statements" }, { status: 500 });
  }
}
