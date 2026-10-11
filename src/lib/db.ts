import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/** Query logging in dev is very slow; set PRISMA_LOG_QUERIES=true to enable. */
const prismaLog: ("query" | "error" | "warn")[] =
  process.env.PRISMA_LOG_QUERIES === "true"
    ? ["query", "error", "warn"]
    : ["error", "warn"];

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? prismaLog : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

const globalForSqlite = globalThis as unknown as {
  __prismaSqlitePerfInit?: boolean;
};

/** WAL + busy timeout; runs once per process (avoids HMR / multi-import storms in dev). */
function initSqlitePerf() {
  if (globalForSqlite.__prismaSqlitePerfInit) {
    return;
  }
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("file:")) {
    return;
  }
  globalForSqlite.__prismaSqlitePerfInit = true;
  void prisma
    .$connect()
    .then(async () => {
      try {
        await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
        await prisma.$queryRawUnsafe("PRAGMA busy_timeout=5000");
        await prisma.$queryRawUnsafe("PRAGMA synchronous=NORMAL");
      } catch {
        /* ignore */
      }
    })
    .catch(() => {});
}
initSqlitePerf();
