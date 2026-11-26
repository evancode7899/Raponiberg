import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { dataStamp, getBook } from "@/lib/book/cache";
import { buildProof, parseDescriptor } from "@/lib/book/proof";
import type { SweepReport } from "@/lib/book/proof/sweep";
import { proofSweep } from "@/lib/book/proof/sweepProcess";
import { prisma } from "@/lib/db";
import { movedSince } from "@/lib/restatements";
import { whySince } from "@/lib/restatementWhy";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** How many moved figures are listed with their names. */
const LISTED = 40;

/**
 * The restatement log (lib/restatements.ts): the figures the latest sweep cleared whose value
 * differs from the last month-end's record, largest move first, each with what it describes
 * and its recipe (to open its proof), and what the audit log says changed since. Reads only.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const now = proofSweep().peek();
  if (now.state !== "ready") return NextResponse.json({ status: now.state }, { status: 202 });
  const report = JSON.parse(now.body) as SweepReport;
  const since = movedSince(report.cleared);
  if (!since) return NextResponse.json({ monthEnd: null });
  const book = await getBook(prisma, dataStamp());
  const listed = [];
  for (const m of since.moved.slice(0, LISTED)) {
    const d = parseDescriptor(JSON.parse(m.key));
    if ("error" in d) continue;
    const proof = await buildProof({ book, db: prisma }, d).catch(() => null);
    listed.push({ descriptor: d, describes: proof?.describes ?? null, was: m.was, now: m.now });
  }
  return NextResponse.json({ monthEnd: { month: since.month, takenAt: since.takenAt }, compared: since.compared, movedCount: since.moved.length, moved: listed, why: await whySince(prisma, since.takenAt) });
}
