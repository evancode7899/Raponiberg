import { rejectNonLocalRequest } from "@/lib/auth/localRequest";
import { NextRequest, NextResponse } from "next/server";

/** Turns away requests that a website, rather than this computer's own tab, made (see localRequest.ts). */
export function proxy(request: NextRequest) {
  const reason = rejectNonLocalRequest(request.nextUrl.pathname, request.headers);
  if (!reason) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: reason }, { status: 403 });
  return new NextResponse(`Forbidden: ${reason}. Open Raponiberg at http://127.0.0.1:3000.`, { status: 403 });
}

export const config = {
  // Build output (scripts, styles, fonts) holds no data; everything else is checked.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
