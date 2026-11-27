import { describe, expect, it } from "vitest";
import { parseCompositeDescriptor } from "./compositeProof";

// Pat Example's made-up months.
const month = (metric: string, start: string) => ({ report: "cash-flow", metric, granularity: "month", start, end: start.replace(/01$/, "28") });
const sum = (metric: string) => ({ report: "composite", op: "sum", of: [month(metric, "2031-01-01"), month(metric, "2031-02-01")] });

describe("parseCompositeDescriptor", () => {
  it("takes a share of a difference of sums: a savings rate over a run of months, as Cash flow › Trends draws it", () => {
    const rate = { report: "composite", op: "share", of: [{ report: "composite", op: "diff", of: [sum("income"), sum("spending")] }, sum("income")] };
    const p = parseCompositeDescriptor(rate);
    expect("error" in p).toBe(false);
    expect((p as unknown as { of: { report: string; of?: unknown[] }[] }).of[0]!.of).toHaveLength(2);
  });

  it("still refuses nesting without end", () => {
    let d: Record<string, unknown> = sum("income");
    for (let i = 0; i < 4; i++) d = { report: "composite", op: "sum", of: [d, sum("spending")] };
    expect(parseCompositeDescriptor(d)).toEqual({ error: expect.stringMatching(/nests 3 levels at most/) });
  });
});
