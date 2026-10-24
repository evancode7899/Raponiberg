import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { FACT_PARSERS, FACTS_VERSION } from "../ingest/factsVersion";
import { refreshOutdatedFactsOnLaunch, type MaintenanceReport } from "./maintenance";

// An in-memory stand-in for the documents table (invented documents).

type Doc = { parserId: string; factsVersion: number };

function fakeDb(docs: Doc[]) {
  const db = {
    sourceDocument: {
      count: async ({ where }: { where: { factsVersion: { lt: number }; parserId: { in: string[] } } }) =>
        docs.filter((d) => d.factsVersion < where.factsVersion.lt && where.parserId.in.includes(d.parserId)).length,
    },
  };
  return db as unknown as PrismaClient;
}

function spyRefresh() {
  const calls: PrismaClient[] = [];
  const report = { factsRefreshed: 1, factsFailed: [] } as unknown as MaintenanceReport;
  const refresh = async (db: PrismaClient) => {
    calls.push(db);
    return report;
  };
  return { refresh, calls, report };
}

describe("re-extracting outdated facts at launch", () => {
  it("runs the refresh once when a fact document was stored by an older extractor", async () => {
    const db = fakeDb([
      { parserId: FACT_PARSERS[0]!, factsVersion: FACTS_VERSION - 1 },
      { parserId: FACT_PARSERS[1]!, factsVersion: FACTS_VERSION - 1 },
    ]);
    const { refresh, calls, report } = spyRefresh();
    expect(await refreshOutdatedFactsOnLaunch(db, refresh)).toBe(report);
    expect(calls).toEqual([db]);
  });

  it("does nothing when every fact document is current", async () => {
    const { refresh, calls } = spyRefresh();
    expect(await refreshOutdatedFactsOnLaunch(fakeDb([{ parserId: FACT_PARSERS[0]!, factsVersion: FACTS_VERSION }]), refresh)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("ignores old documents from parsers that store no facts", async () => {
    const { refresh, calls } = spyRefresh();
    expect(await refreshOutdatedFactsOnLaunch(fakeDb([{ parserId: "made-up-bank-statement", factsVersion: 0 }]), refresh)).toBeNull();
    expect(calls).toEqual([]);
  });
});
