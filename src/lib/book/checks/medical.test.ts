import { describe, expect, it } from "vitest";
import type { HealthPlan } from "../../medical/plans.ts";
import type { Book } from "../load.ts";
import { checkMedical } from "./medical.ts";
import { Collector } from "./collector.ts";

const plan = (hsaEligible: boolean): HealthPlan => ({
  id: "example-2025",
  coverage: "MEDICAL",
  insurer: "Example Health",
  name: "Example PPO",
  coverageFrom: "2025-01-01",
  coverageTo: "2025-12-31",
  accumulator: "CALENDAR_YEAR",
  hsaEligible,
  deductible: { inNetwork: { individualCents: 100_000, familyCents: 200_000 }, outOfNetwork: null },
  outOfPocket: { inNetwork: { individualCents: 300_000, familyCents: 600_000 }, outOfNetwork: null },
  services: [],
  limits: [],
  excluded: [],
  otherCovered: [],
  rules: [],
  sources: [],
});

const stub = (payDate: string, hsa: number) => ({ payDate, personId: "pat", employer: "Example Co", documentTitle: `stub ${payDate}`, lines: [{ name: "HSA", kind: "HSA", current: hsa, ytd: hsa }] });

/** Only what the medical checks read of a Book. */
const book = (eligible: boolean) => ({ today: "2026-02-01", rows: [], accounts: [], stubs: [stub("2025-03-15", 20_000), stub("2025-09-15", 20_000)], medical: { docs: null, plans: [plan(eligible)], planProblems: [] } }) as unknown as Book;

describe("medical.hsa-eligible", () => {
  it("withholds the tax figures of the years HSA money went in without an eligible plan", () => {
    const c = new Collector();
    checkMedical(book(false), c);
    expect(c.findings).toEqual([expect.objectContaining({ id: "medical.hsa-eligible", check: "medical.hsa-eligible", status: "FAIL", scope: { from: "2025-01-01", to: "2025-12-31", affects: ["TAX"] } })]);
  });

  it("passes, withholding nothing, when the plan is HSA-eligible", () => {
    const c = new Collector();
    checkMedical(book(true), c);
    expect(c.findings).toEqual([]);
    expect(c.passes).toEqual([expect.objectContaining({ check: "medical.hsa-eligible", scope: { from: "2025-01-01", to: "2025-12-31", affects: ["TAX"] } })]);
  });
});
