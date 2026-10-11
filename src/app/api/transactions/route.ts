import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import { parseIsoDate } from "@/lib/statements/parseIsoDate";
import type { Prisma, TransactionLane } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Ledger rows for the Transactions page and drill-downs. Query: from, to (YYYY-MM-DD),
 * category, lane (comma list), accountId, q (payee, detail or merchant contains),
 * needsReview=1, limit (≤ 2000). Only committed, non-summary statement rows. Also
 * returns how many rows match and their money in / out, beyond the page returned.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const sp = request.nextUrl.searchParams;
  const where: Prisma.TransactionWhereInput = {
    statementImport: { status: "COMMITTED", isSummary: false },
  };
  const from = sp.get("from");
  const to = sp.get("to");
  if (from || to) {
    where.date = {
      ...(from ? { gte: parseIsoDate(from) } : {}),
      ...(to ? { lte: parseIsoDate(to) } : {}),
    };
  }
  const category = sp.get("category");
  if (category) where.category = { name: category };
  const lane = sp.get("lane");
  if (lane) where.lane = { in: lane.split(",") as TransactionLane[] };
  const accountId = sp.get("accountId");
  if (accountId) where.accountId = accountId;
  if (sp.get("needsReview") === "1") where.needsReview = true;
  const q = sp.get("q")?.trim();
  if (q) where.OR = [{ payee: { contains: q } }, { detail: { contains: q } }, { merchantKey: { contains: q.toUpperCase() } }];
  const limit = Math.min(2000, Number(sp.get("limit") ?? 500) || 500);

  const [rows, count, inflow, outflow] = await Promise.all([
    prisma.transaction.findMany({
      where,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: limit,
      select: {
        id: true,
        date: true,
        amountCents: true,
        payee: true,
        detail: true,
        lane: true,
        merchantKey: true,
        needsReview: true,
        classifiedBy: true,
        userLocked: true,
        account: { select: { id: true, name: true } },
        category: { select: { name: true } },
      },
    }),
    prisma.transaction.count({ where }),
    prisma.transaction.aggregate({ where: { AND: [where, { amountCents: { gt: 0 } }] }, _sum: { amountCents: true } }),
    prisma.transaction.aggregate({ where: { AND: [where, { amountCents: { lt: 0 } }] }, _sum: { amountCents: true } }),
  ]);
  return NextResponse.json({
    transactions: rows,
    total: { count, inCents: inflow._sum.amountCents ?? 0, outCents: outflow._sum.amountCents ?? 0 },
  });
}
