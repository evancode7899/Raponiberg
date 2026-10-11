import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { runBackup } from "@/lib/backup/auto";
import { backupRoot } from "@/lib/backup/backup";
import { isDemo } from "@/lib/dataDir";
import { prisma } from "@/lib/db";
import { stopDemo } from "@/lib/demo/launch";
import { NextRequest, NextResponse } from "next/server";

/**
 * Exits this Node process (the power button and the OFF terminal command). A last backup
 * runs first, so nothing waits on the 15-minute timer; it's given 30 seconds at most. The
 * delay lets the response below reach the browser before the process dies. The real app
 * takes a running demo down with it, so the next start can update the files it uses.
 */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  setTimeout(() => {
    const backup = backupRoot() ? runBackup(prisma, "shutdown").catch((e: unknown) => console.error("[backup]", e)) : Promise.resolve();
    const demo = isDemo() ? Promise.resolve() : stopDemo();
    const limit = new Promise((resolve) => setTimeout(resolve, 30_000));
    void Promise.race([Promise.all([backup, demo]), limit]).finally(() => process.exit(0));
  }, 150);

  return NextResponse.json({ ok: true });
}
