import { describe, expect, it } from "vitest";
import { Collector } from "./checks/collector";
import { exceptionDrift } from "./exceptions";
import type { Finding, StandingException } from "./types";

// SSOT F · B: an exception covers the finding the owner accepted, not whatever later takes its id.
const finding = (title: string, detail = "The bank's statements and the card's disagree."): Finding => ({
  id: "networth.reconciles:2025-03",
  check: "networth.reconciles",
  status: "FAIL",
  title,
  detail,
  fix: "Check the statements.",
  scope: { from: "2025-03-01", to: "2025-03-31", affects: ["NET_WORTH"] },
});
const accepted = (f: Finding): StandingException => ({
  id: f.id,
  check: f.check,
  note: "A few dollars of rounding at Example Bank",
  acceptedAt: "2025-05-01T00:00:00.000Z",
  finding: { status: f.status, title: f.title, detail: f.detail, scope: f.scope },
});

describe("accepted exceptions", () => {
  const small = finding("March 2025 doesn't reconcile by $3.00");
  const ex = accepted(small);

  it("cover the finding as accepted", () => {
    expect(exceptionDrift(ex, small)).toBeNull();
    const c = new Collector([ex]);
    c.add(small);
    expect(c.report().findings).toEqual([]);
    expect(c.report().accepted.map((a) => a.id)).toEqual([small.id]);
  });

  it("reopen when the amount grows, saying what was accepted", () => {
    const big = finding("March 2025 doesn't reconcile by $30,000.00");
    expect(exceptionDrift(ex, big)).toMatch(/\$3\.00/);
    const c = new Collector([ex]);
    c.add(big);
    const r = c.report();
    expect(r.accepted).toEqual([]);
    expect(r.findings.map((f) => f.id)).toEqual([big.id]);
    expect(r.findings[0]!.detail).toMatch(/changed since you accepted it/);
    // Not stale either: its finding still arises.
    expect(r.stale).toEqual([]);
  });

  it("reopen when the status changes", () => {
    expect(exceptionDrift(ex, { ...small, status: "MISSING" })).toMatch(/failure/);
  });

  it("compare the detail's amounts only when the snapshot's detail states any", () => {
    const carried = { ...ex, finding: { ...ex.finding, detail: "Reviewed before this was an integrity check." } };
    expect(exceptionDrift(carried, finding(small.title, "Off by $3.00 this time."))).toBeNull();
    const priced = accepted(finding(small.title, "Off by $3.00."));
    expect(exceptionDrift(priced, finding(small.title, "Off by $9.00."))).not.toBeNull();
  });
});

describe("past the data edge (SSOT F · K)", () => {
  it("only missing data is awaited; a contradiction stays a failure", () => {
    const c = new Collector([], "2025-02-28");
    c.add({ ...finding("A statement is on its way"), id: "m", status: "MISSING" });
    c.add({ ...finding("Two statements disagree"), id: "f" });
    const r = c.report();
    expect(r.findings.find((f) => f.id === "m")!.atEdge).toBe(true);
    expect(r.findings.find((f) => f.id === "f")!.atEdge).toBeUndefined();
    const t = r.checks.find((x) => x.id === "networth.reconciles")!;
    expect([t.awaiting, t.failed]).toEqual([1, 1]);
  });
});
