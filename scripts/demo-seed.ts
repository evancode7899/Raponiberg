/**
 * Fills the demo database (DATABASE_URL, which scripts/demo.ts points at data/demo) with
 * the made-up household. Refuses to run unless APP_PROFILE=demo, so it can never write
 * into the real ledger.
 *
 * Usage (normally run by npm run demo): node scripts/demo-seed.ts
 */
import { PrismaClient } from "@prisma/client";
import { isDemo } from "../src/lib/dataDir.ts";
import { seedDemo } from "../src/lib/demo/seed.ts";

if (!isDemo()) {
  console.error("demo-seed only runs for the demo (APP_PROFILE=demo); use npm run demo.");
  process.exit(1);
}
const prisma = new PrismaClient();
try {
  const started = Date.now();
  const r = await seedDemo(prisma);
  console.log(`Demo data: ${r.documents} documents, ${r.transactions} transactions (${((Date.now() - started) / 1000).toFixed(1)}s).`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
