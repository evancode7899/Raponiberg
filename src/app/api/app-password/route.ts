import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { checkAppPassword, isDefaultAppPassword, writeAppPassword } from "@/lib/appPassword";
import { isDemo } from "@/lib/dataDir";
import { ensureDemoRunning, isDemoWord } from "@/lib/demo/launch";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Whether the lock screen still uses the default password: { isDefault }. The demo
 * instance also says so ({ demo: true, exitUrl }): it has no lock screen, and its "Exit
 * demo" button leads back to the real app.
 */
export async function GET() {
  if (isDemo()) return NextResponse.json({ isDefault: false, demo: true, exitUrl: process.env.DEMO_EXIT_URL || "http://127.0.0.1:3000" });
  return NextResponse.json({ isDefault: isDefaultAppPassword() });
}

/**
 * Body: { password } — the lock screen's unlock attempt: { ok }. Not behind API_SECRET,
 * since the lock screen comes before anything else is entered. "demo" (when it isn't the
 * real password) starts the demo instance and answers { ok: false, demo: url } for the
 * lock screen to go to.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
  if (checkAppPassword(body?.password)) return NextResponse.json({ ok: true });
  if (!isDemo() && isDemoWord(body?.password)) {
    try {
      return NextResponse.json({ ok: false, demo: await ensureDemoRunning(appOrigin(request)) });
    } catch (e) {
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "The demo couldn't start" }, { status: 503 });
    }
  }
  return NextResponse.json({ ok: false });
}

/** This app as the browser reached it (Next reports its own bind address as localhost). */
function appOrigin(request: NextRequest): string {
  const host = request.headers.get("host");
  return host ? `http://${host}` : new URL(request.url).origin;
}

/** Body: { password } — sets a new lock-screen password (Settings › General). */
export async function PUT(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
  try {
    writeAppPassword(body?.password);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
