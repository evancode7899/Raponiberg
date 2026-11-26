import { describe, expect, it } from "vitest";
import { renderDigest, sparkline, type DigestData } from "./render";

// Invented figures.
const data: DigestData = {
  asOf: "2026-03-31",
  written: "Apr 2, 2026, 8:00 AM",
  netWorth: { total: 123_456_00, month: -1_200_00, ytd: null, ytdYear: "2026", series: [{ end: "2026-01-31", cents: 120_000_00 }, { end: "2026-02-28", cents: null }, { end: "2026-03-31", cents: 123_456_00 }] },
  cashFlow: { label: "Mar 2026", income: 9_000_00, spending: 7_500_00, net: 1_500_00 },
  due: [{ date: "2026-04-15", title: "Pat <tax> & co", cents: 2_000_00 }],
  goals: [{ name: "Rainy day", status: "ON_TRACK", current: null, target: 20_000_00, lands: "2027-01-31" }],
};

describe("renderDigest", () => {
  const html = renderDigest(data);
  it("is one page with no script and no network", () => {
    expect(html).not.toMatch(/<script|src=|href=|@import|url\(/i);
    expect(html).toContain("default-src 'none'");
  });
  it("draws proven figures, withheld ones as n.a., and escapes text", () => {
    expect(html).toContain("$123,456");
    expect(html).toContain("−$1,200");
    expect(html).toContain("n.a.");
    expect(html).toContain("Pat &lt;tax&gt; &amp; co");
    expect(html).toContain("On track · Jan 2027");
  });
  it("leaves unproven months out of the line", () => {
    expect(sparkline(data.netWorth.series)).toBe("");
    const two = sparkline([...data.netWorth.series, { end: "2026-04-30", cents: 125_000_00 }]);
    expect(two.match(/<polyline/g)).toHaveLength(1);
  });
});
