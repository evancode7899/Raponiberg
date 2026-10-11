/**
 * Seeds the category taxonomy for the statement ledger (src/lib/classifier/taxonomy.ts)
 * and removes categories from older taxonomies that nothing references anymore.
 * Idempotent — safe to re-run. (Imports also create missing categories on their own.)
 * Run from project root: npm run db:seed
 */
import { PrismaClient } from "@prisma/client";
import { CATEGORIES } from "../src/lib/classifier/taxonomy.ts";

async function main() {
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.category.findMany({
      select: {
        id: true,
        name: true,
        _count: { select: { transactions: true, budgetLines: true, merchantRules: true } },
      },
    });
    const byName = new Map(existing.map((c) => [c.name, c]));
    let created = 0;
    for (const [i, def] of CATEGORIES.entries()) {
      const found = byName.get(def.name);
      if (found) {
        await prisma.category.update({
          where: { id: found.id },
          data: { kind: def.kind, groupName: def.group, displayOrder: i },
        });
      } else {
        await prisma.category.create({ data: { name: def.name, kind: def.kind, groupName: def.group, displayOrder: i } });
        created++;
      }
    }
    const wanted = new Set(CATEGORIES.map((c) => c.name));
    const stale = existing.filter(
      (c) => !wanted.has(c.name) && c._count.transactions + c._count.budgetLines + c._count.merchantRules === 0,
    );
    if (stale.length) await prisma.category.deleteMany({ where: { id: { in: stale.map((c) => c.id) } } });
    console.log(`Categories: ${created} created, ${stale.length} unused old ones removed.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
