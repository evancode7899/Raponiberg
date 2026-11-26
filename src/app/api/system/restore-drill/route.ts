import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { backupRoot } from "@/lib/backup/backup";
import { drillDue, readDrill } from "@/lib/backup/drill";
import { logDrill } from "@/lib/backup/drillLog";
import { drillRunning, runDrillNow } from "@/lib/backup/drillAuto";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The last restore drill (lib/backup/drill.ts), whether one is due, and whether one is running. Reads only. */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const last = readDrill();
  return NextResponse.json({ last, due: drillDue(last), running: drillRunning(), canRun: backupRoot() != null });
}

/** Runs the drill now (Settings › Data). */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const last = await runDrillNow(prisma, "manual", logDrill);
    return NextResponse.json({ last, due: false, running: false, canRun: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The drill failed" }, { status: 500 });
  }
}
