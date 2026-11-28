import { describe, expect, it } from "vitest";
import { barChart, lineChart, renderDigest, ticks, type DigestData } from "./render";

// Invented figures.
const MONTH_ENDS = ["2025-04-30", "2025-05-31", "2025-06-30", "2025-07-31", "2025-08-31", "2025-09-30", "2025-10-31", "2025-11-30", "2025-12-31", "2026-01-31", "2026-02-28", "2026-03-31"];
const LABELS = ["Apr 2025", "May 2025", "Jun 2025", "Jul 2025", "Aug 2025", "Sep 2025", "Oct 2025", "Nov 2025", "Dec 2025", "Jan 2026", "Feb 2026", "Mar 2026"];

export const sample: DigestData = {
  asOf: "2026-03-31",
  written: "Apr 2, 2026, 8:00 AM",
  feed: [
    { tone: "good", text: "Net worth hit a new high." },
    { tone: "warn", text: "Estimated tax is due Apr 15." },
  ],
  health: { failing: 0, missing: 1, awaiting: 2, checksPassing: 40, checksTotal: 41 },
  netWorth: {
    total: 123_456_00,
    assets: 150_000_00,
    debts: -26_544_00,
    liquid: 40_000_00,
    month: -1_200_00,
    year: 20_000_00,
    ytd: null,
    ytdYear: "2026",
    series: MONTH_ENDS.map((end, i) => ({ end, cents: i === 4 ? null : 100_000_00 + i * 2_000_00 })),
    yearEnds: [
      { end: "2026-03-31", cents: 123_456_00 },
      { end: "2025-12-31", cents: 116_000_00 },
    ],
    drivers: { saving: 15_000_00, markets: 6_000_00, other: -1_000_00 },
    groups: [
      { group: "Cash", cents: 40_000_00, accounts: [{ name: "Everyday checking", institution: "Sample Bank", cents: 40_000_00 }] },
      { group: "Credit cards", cents: -1_544_00, accounts: [{ name: "Travel card", institution: null, cents: -1_544_00 }] },
    ],
    change: { label: "Mar 2026", cents: -1_200_00, steps: [{ label: "Saved", cents: 800_00, note: "Pay in, spending out." }, { label: "Markets", cents: -2_000_00, note: "" }], notes: ["Markets took back more than was saved."] },
  },
  cashFlow: {
    lastMonth: { label: "Mar 2026", income: 9_000_00, spending: 7_500_00, net: 1_500_00, rate: 0.17 },
    months: LABELS.map((label, i) => (i === 4 ? { label, income: null, spending: null, net: null, rate: null } : { label, income: 9_000_00, spending: 7_000_00 + i * 200_00, net: 2_000_00 - i * 200_00, rate: 0.1 })),
    last12: { months: 11, income: 99_000_00, spending: 88_000_00, net: 11_000_00, rate: 0.11 },
    kinds: { bill: 3_000_00, big: 1_500_00, everyday: 3_000_00 },
    categories: [{ category: "Groceries", lastMonth: 900_00, avg: 800_00 }],
    merchants: [{ name: "Corner Grocer", category: "Groceries", cents: 400_00, count: 5 }],
    payers: [{ name: "Sample Employer", cents: 9_000_00 }],
    bills: [{ name: "Streaming Co", category: "Subscriptions", cadence: "monthly", typical: 15_00, annual: 180_00, change: 2_00 }],
    oneOffs: [{ date: "2026-03-10", label: "New sofa", category: "Home", cents: 1_500_00 }],
  },
  investments: {
    asOf: "2026-03-31",
    blocked: false,
    total: 80_000_00,
    returns: { from: "2025-01-01", total: 0.12, annualized: 0.08, month: { label: "Mar 2026", ratio: -0.015 } },
    classes: [{ label: "US stocks", cents: 60_000_00, share: 0.75, drift: 2_000_00 }],
    byTreatment: [{ treatment: "Roth", cents: 80_000_00 }],
    accounts: [{ name: "Sample Roth", treatment: "Roth", cents: 80_000_00, positions: [{ name: "TOTL · Total Market Index", cents: 80_000_00, gain: 5_000_00 }] }],
    holdings: [{ name: "Total Market Index", cents: 60_000_00, share: 0.75, gain: 5_000_00, accounts: ["Sample Roth"] }],
    gains: { unrealized: 5_000_00, taxableUnrealized: -100_00, harvest: [{ name: "BOND", account: "Sample Brokerage", loss: -100_00 }] },
    quarters: [
      { label: "Q4 2025", portfolio: 0.04, sp500: 0.05 },
      { label: "Q1 2026", portfolio: -0.02, sp500: -0.03 },
    ],
    fees: { weightedRatio: 0.0005, annual: 40_00, accountFees: -12_00 },
  },
  taxes: { year: 2026, blocked: null, rows: [{ name: "Federal", tax: 20_000_00, paid: 18_000_00, balance: 2_000_00 }], installments: [{ date: "2026-06-15", label: "Federal Q2", cents: 1_000_00 }] },
  due: [{ date: "2026-04-15", title: "Pat <tax> & co", cents: 2_000_00 }],
  goals: [{ name: "Rainy day", status: "ON_TRACK", current: null, target: 20_000_00, lands: "2027-01-31" }],
  fire: { fiYear: 2045, progress: 0.2, number: 2_000_000_00, levers: [{ label: "Spend $1k a month less", fiYear: 2043 }] },
};

describe("renderDigest", () => {
  const html = renderDigest(sample);
  it("is one page with no script, no links and no network", () => {
    expect(html).not.toMatch(/<script|src=|href=|@import|url\(/i);
    expect(html).toContain("default-src 'none'");
  });
  it("has five radio tabs, the first one open", () => {
    expect(html.match(/<input type="radio" name="tab"/g)).toHaveLength(5);
    expect(html).toContain('id="t-home" class="tabr" checked');
    for (const id of ["home", "nw", "cash", "inv", "plans"]) expect(html).toContain(`class="panel p-${id}"`);
  });
  it("draws proven figures, withheld ones as n.a., and escapes text", () => {
    expect(html).toContain("$123,456");
    expect(html).toContain("−$1,200");
    expect(html).toContain("n.a.");
    expect(html).toContain("Pat &lt;tax&gt; &amp; co");
    expect(html).toContain("On track · lands Jan 2027");
    for (const s of ["Everyday checking", "Corner Grocer", "Sample Employer", "Streaming Co", "New sofa", "TOTL · Total Market Index", "Net worth hit a new high.", "Owed at filing", "Spend $1k a month less"]) expect(html).toContain(s);
  });
  it("puts breakdowns in tap-to-expand details", () => {
    expect(html).toMatch(/<details><summary><span>Cash <span class="pill">1<\/span><\/span>/);
  });
  it("gives every chart a fixed size (Quick Look won't size one itself)", () => {
    const svgs = html.match(/<svg[^>]*>/g) ?? [];
    expect(svgs.length).toBeGreaterThanOrEqual(4);
    for (const svg of svgs) expect(svg).toMatch(/width="\d+" height="\d+"/);
  });
  it("lets no CSS resize a chart (that left Quick Look a black screen)", () => {
    const css = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    expect(css).not.toMatch(/\.chart\{[^}]*(width|height)/);
  });
  it("scrolls as one page (Quick Look can't freeze a header, so nothing tries)", () => {
    const css = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    expect(css).not.toMatch(/position:sticky|position:fixed|overflow-y:auto/);
    expect(css).toMatch(/html,body\{background:var\(--bg\)\}/);
  });
});

describe("charts", () => {
  it("label the y axis with round dollar ticks and the x axis with months", () => {
    const svg = lineChart(sample.netWorth.series);
    expect(svg).toContain(">$100k<");
    expect(svg).toContain(">$120k<");
    expect(svg).toMatch(/>Apr ’25</);
    expect(svg).toMatch(/>Mar ’26</);
  });
  it("leave unproven months out of the line and the bars", () => {
    expect(lineChart([{ end: "2026-01-31", cents: 1 }, { end: "2026-02-28", cents: null }])).toBe("");
    expect(lineChart(sample.netWorth.series).match(/<polyline/g)).toHaveLength(2);
    expect(barChart([{ label: "Jan", a: null }, { label: "Feb", a: 5_00 }], { title: "t" }).match(/<rect/g)).toHaveLength(1);
  });
  it("pick round ticks", () => {
    expect(ticks(0, 100)).toEqual([0, 25, 50, 75, 100]);
    expect(ticks(-30, 70, 3)).toEqual([-50, 0, 50, 100]);
    expect(ticks(101, 119)).toEqual([100, 105, 110, 115, 120]);
  });
});
