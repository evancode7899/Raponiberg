import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readDecisions, recordConfirmed, recordRejected, resolveLegs, type LegFingerprint } from "./decisionStore";

const tempFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), "transfer-decisions-")), "transfer-decisions.json");

const plan: LegFingerprint = { institution: "Plan Co", identifiers: ["PLAN01"], date: "2025-12-31", amountCents: -5000000 };
const ira: LegFingerprint = { institution: "Broker Co", identifiers: ["X0001"], date: "2026-01-05", amountCents: 4996000 };

describe("transfer decisions file", () => {
  it("keeps a confirmed rollover, and an unpair turns it into a rejection", () => {
    const file = tempFile();
    recordConfirmed({ legs: [plan, ira], differenceCents: -4000, note: "rollover fee" }, file);
    recordConfirmed({ legs: [ira, plan], differenceCents: -4000, note: "again" }, file);
    expect(readDecisions(file).confirmed).toHaveLength(1);
    recordRejected([ira, plan], file);
    expect(readDecisions(file).confirmed).toHaveLength(0);
    expect(readDecisions(file).rejected).toHaveLength(1);
  });

  it("refuses a file written by a newer app instead of misreading it", () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ version: 2, confirmed: [], rejected: [] }));
    expect(() => readDecisions(file)).toThrow(/newer version/);
  });

  it("finds a re-imported row by account, date and amount, never guessing between two", () => {
    const rows = [
      { id: "new-plan-row", ...plan, identifiers: ["OLD1", "PLAN01"] },
      { id: "ira-row", ...ira },
    ];
    expect(resolveLegs([plan, ira], rows)).toEqual(["new-plan-row", "ira-row"]);
    expect(resolveLegs([plan, ira], [...rows, { id: "twin", ...ira }])).toBeNull();
    expect(resolveLegs([plan, ira], rows.slice(0, 1))).toBeNull();
  });
});
