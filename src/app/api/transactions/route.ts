import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { LANES, type Lane } from "@/lib/classifier/taxonomy";
import { isIsoDate } from "@/lib/dates/isoDate";
import { prisma } from "@/lib/db";
import { sortRows } from "@/lib/sortRows";
import { parseIsoDate } from "@/lib/statements/parseIsoDate";
import type { Prisma, TransactionLane } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Ledger rows for the Transactions page and drill-downs. Query: from, to (YYYY-MM-DD),
 * category, lane (comma list), accountId, q (payee, detail or merchant contains),
 * needsReview=1, flow (in | out), min / max (size in dollars, either sign),
 * sort (date | amount | name; amount by size), dir (asc | desc), limit (≤ 2000). Only
 * committed, non-summary statement rows. Also returns how many rows match and their
 * money in / out, beyond the page returned.
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
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) {
    return NextResponse.json({ error: "from/to must be YYYY-MM-DD" }, { status: 400 });
  }
  if (from || to) {
    where.date = {
      ...(from ? { gte: parseIsoDate(from) } : {}),
      ...(to ? { lte: parseIsoDate(to) } : {}),
    };
  }
  const category = sp.get("category");
  if (category) where.category = { name: category };
  const lane = sp.get("lane");
  if (lane) {
    const lanes = lane.split(",");
    if (lanes.some((l) => !LANES.includes(l as Lane))) {
      return NextResponse.json({ error: `lane must be a comma list of ${LANES.join(", ")}` }, { status: 400 });
    }
    where.lane = { in: lanes as TransactionLane[] };
  }
  const accountId = sp.get("accountId");
  if (accountId) where.accountId = accountId;
  if (sp.get("needsReview") === "1") where.needsReview = true;

  const and: Prisma.TransactionWhereInput[] = [];
  const q = sp.get("q")?.trim();
  if (q) and.push({ OR: [{ payee: { contains: q } }, { detail: { contains: q } }, { merchantKey: { contains: q.toUpperCase() } }] });

  const flow = sp.get("flow") ?? "";
  if (!["", "in", "out"].includes(flow)) return NextResponse.json({ error: "flow must be in or out" }, { status: 400 });
  const dollars = (k: string) => {
    const v = sp.get(k)?.trim();
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
  };
  const min = dollars("min");
  const max = dollars("max");
  if (Number.isNaN(min) || Number.isNaN(max)) {
    return NextResponse.json({ error: "min/max must be dollar amounts ≥ 0" }, { status: 400 });
  }
  // Size is the absolute amount: money in is positive, money out negative.
  const moneyIn: Prisma.IntFilter = { gte: Math.max(1, min ?? 0), ...(max != null ? { lte: max } : {}) };
  const moneyOut: Prisma.IntFilter = { lte: -Math.max(1, min ?? 0), ...(max != null ? { gte: -max } : {}) };
  if (flow === "in") and.push({ amountCents: moneyIn });
  else if (flow === "out") and.push({ amountCents: moneyOut });
  else if (min || max != null) and.push({ OR: [{ amountCents: moneyIn }, { amountCents: moneyOut }, ...(min ? [] : [{ amountCents: 0 }])] });
  if (and.length) where.AND = and;

  const sort = sp.get("sort") ?? "date";
  const dir = sp.get("dir") ?? (sort === "name" ? "asc" : "desc");
  if (!(sort === "date" || sort === "amount" || sort === "name") || !(dir === "asc" || dir === "desc")) {
    return NextResponse.json({ error: "sort must be date, amount or name; dir asc or desc" }, { status: 400 });
  }
  const limit = Math.max(1, Math.min(2000, Math.floor(Number(sp.get("limit") ?? 500)) || 500));

  const select = {
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
  } satisfies Prisma.TransactionSelect;

  // The database sorts by date, but not by size (absolute amount) or case-blind payee,
  // so for those rank every match on its few key fields here and fetch the page by id.
  const page = async () => {
    if (sort === "date") return prisma.transaction.findMany({ where, orderBy: [{ date: dir }, { createdAt: dir }], take: limit, select });
    const keys = await prisma.transaction.findMany({ where, select: { id: true, date: true, amountCents: true, payee: true } });
    const ids = sortRows(keys, { key: sort, desc: dir === "desc" }, { date: (r) => r.date.toISOString(), amount: (r) => r.amountCents, name: (r) => r.payee })
      .slice(0, limit)
      .map((r) => r.id);
    const byId = new Map((await prisma.transaction.findMany({ where: { id: { in: ids } }, select })).map((r) => [r.id, r]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  };

  const [rows, count, inflow, outflow] = await Promise.all([
    page(),
    prisma.transaction.count({ where }),
    prisma.transaction.aggregate({ where: { AND: [where, { amountCents: { gt: 0 } }] }, _sum: { amountCents: true } }),
    prisma.transaction.aggregate({ where: { AND: [where, { amountCents: { lt: 0 } }] }, _sum: { amountCents: true } }),
  ]);
  return NextResponse.json({
    transactions: rows,
    total: { count, inCents: inflow._sum.amountCents ?? 0, outCents: outflow._sum.amountCents ?? 0 },
  });
}
