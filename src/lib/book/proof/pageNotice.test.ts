import { describe, expect, it } from "vitest";
import type { SweepProblem, SweepState } from "./clearance.ts";
import { pageNotice } from "./pageNotice.ts";

const problem = (kind: SweepProblem["kind"], page: string, detail = `${page} is off`): SweepProblem => ({ kind, page, descriptor: null, detail });
const sweep = (problems: Record<string, SweepProblem[]>, status: SweepState["status"] = "ready"): SweepState => ({ stamp: "s", status, cleared: {}, basis: {}, problems });

describe("pageNotice", () => {
  it("counts a page's withheld figures once each, however many problems each has", () => {
    const s = sweep({
      a: [problem("SELF_CHECK", "Taxes 2025", "parts don't add"), problem("CHAIN", "Taxes 2025")],
      b: [problem("REDERIVE", "Taxes 2026")],
      c: [problem("REDERIVE", "Card perks")],
    });
    expect(pageNotice(s, "/taxes")).toEqual({ figures: 2, parts: [{ page: "Taxes 2025", figures: 1 }, { page: "Taxes 2026", figures: 1 }], example: "parts don't add" });
    expect(pageNotice(s, "/card-perks")?.figures).toBe(1);
  });

  it("says nothing on a page with no problem of its own", () => {
    const s = sweep({ a: [problem("CHAIN", "Taxes 2025")] });
    expect(pageNotice(s, "/net-worth")).toBeNull();
    expect(pageNotice(s, "/settings")).toBeNull();
  });

  it("doesn't count a failed link (the linked proof's problem) or what wasn't swept", () => {
    expect(pageNotice(sweep({ a: [problem("LINK", "Taxes 2025")], b: [problem("SKIPPED", "Taxes 2024")] }), "/taxes")).toBeNull();
  });

  it("keeps pages with like names apart", () => {
    const s = sweep({ a: [problem("CHAIN", "Home budget")], b: [problem("CHAIN", "Account limits")] });
    expect(pageNotice(s, "/")).toBeNull();
    expect(pageNotice(s, "/home-budget")?.figures).toBe(1);
    expect(pageNotice(s, "/taxes")).toBeNull();
    expect(pageNotice(s, "/tax-accounts")?.figures).toBe(1);
  });

  it("counts a tab that was once its own page on the page that took it in", () => {
    const s = sweep({ a: [problem("CHAIN", "Mortgage")], b: [problem("REDERIVE", "Transactions")], c: [problem("CHAIN", "Home budget")] });
    expect(pageNotice(s, "/home-budget")?.parts).toEqual([
      { page: "Home budget", figures: 1 },
      { page: "Mortgage", figures: 1 },
    ]);
    expect(pageNotice(s, "/statements")?.figures).toBe(1);
    expect(pageNotice(s, "/mortgage")).toBeNull();
  });

  it("waits for the sweep's verdicts", () => {
    expect(pageNotice(sweep({ a: [problem("CHAIN", "Taxes 2025")] }, "pending"), "/taxes")).toBeNull();
  });
});
