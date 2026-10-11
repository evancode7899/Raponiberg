import { prisma } from "@/lib/db";
import { assertSettingsDatabaseRequest } from "@/lib/settingsDatabaseAuth";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Delegate = {
  count: () => Promise<number>;
  findMany: (args: { skip: number; take: number; orderBy?: unknown }) => Promise<Record<string, unknown>[]>;
};

/**
 * Read-only table browser. Whitelisted tables only, in the order the browser lists them
 * (the statement ledger first), each with a sensible sort.
 */
const TABLES: { name: string; key: string; orderBy?: unknown }[] = [
  { name: "Account", key: "account", orderBy: [{ displayOrder: "asc" }, { name: "asc" }] },
  { name: "AccountAlias", key: "accountAlias" },
  { name: "SourceDocument", key: "sourceDocument", orderBy: [{ periodEnd: "desc" }] },
  { name: "StatementImport", key: "statementImport", orderBy: [{ periodEnd: "desc" }] },
  { name: "Transaction", key: "transaction", orderBy: [{ date: "desc" }, { id: "desc" }] },
  { name: "PayStub", key: "payStub", orderBy: [{ payDate: "desc" }] },
  { name: "TransferMatch", key: "transferMatch" },
  { name: "TransferLeg", key: "transferLeg" },
  { name: "TransferRejection", key: "transferRejection" },
  { name: "Category", key: "category", orderBy: [{ displayOrder: "asc" }, { name: "asc" }] },
  { name: "MerchantCategoryRule", key: "merchantCategoryRule" },
  { name: "AppSetting", key: "appSetting" },
  { name: "AuditEvent", key: "auditEvent", orderBy: [{ occurredAt: "desc" }] },
  { name: "BudgetLine", key: "budgetLine" },
];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const delegate = (key: string) => (prisma as unknown as Record<string, Delegate>)[key]!;

export async function GET(req: Request) {
  const auth = assertSettingsDatabaseRequest(req);
  if (auth) {
    return auth;
  }

  try {
    const url = new URL(req.url);
    const tableParam = url.searchParams.get("table");

    if (!tableParam) {
      const tables = await Promise.all(TABLES.map(async (t) => ({ name: t.name, count: await delegate(t.key).count() })));
      return NextResponse.json({ ok: true as const, tables });
    }

    const t = TABLES.find((x) => x.name === tableParam);
    if (!t) {
      return NextResponse.json({ ok: false as const, error: `Unknown table: ${tableParam}` }, { status: 400 });
    }

    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const limitRaw = Number(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT)) || DEFAULT_LIMIT;
    const limit = Math.min(MAX_LIMIT, Math.max(1, limitRaw));
    const skip = (page - 1) * limit;

    const d = delegate(t.key);
    const [total, rows] = await Promise.all([
      d.count(),
      d.findMany({ skip, take: limit, ...(t.orderBy ? { orderBy: t.orderBy } : {}) }),
    ]);
    const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];

    return NextResponse.json({ ok: true as const, table: t.name, page, limit, total, columns, rows });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ ok: false as const, error: message }, { status: 500 });
  }
}
