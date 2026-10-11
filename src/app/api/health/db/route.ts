import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";

type MigrationRow = {
  migration_name: string;
  finished_at: string | null;
};

export async function GET() {
  try {
    const [accounts, categories, transactions, budgetLines, auditEvents] =
      await Promise.all([
        prisma.account.count(),
        prisma.category.count(),
        prisma.transaction.count(),
        prisma.budgetLine.count(),
        prisma.auditEvent.count(),
      ]);

    const migrations = await prisma.$queryRaw<MigrationRow[]>`
      SELECT migration_name, finished_at
      FROM _prisma_migrations
      WHERE finished_at IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT 10
    `;

    return NextResponse.json({
      ok: true,
      counts: {
        accounts,
        categories,
        transactions,
        budgetLines,
        auditEvents,
      },
      migrations: {
        appliedRecent: migrations.map((m) => ({
          name: m.migration_name,
          finishedAt: m.finished_at,
        })),
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
