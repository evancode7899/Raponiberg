import { createElement as h, Fragment } from "react";
import { Bar, ComposedChart, Legend, Line, Tooltip, XAxis, YAxis } from "recharts";
import { describe, expect, it } from "vitest";
import { readChart } from "./RechartsResponsive";

describe("every chart as a table", () => {
  const data = [
    { label: "Jan 2031", spend: 1200.4, avg: null },
    { label: "Feb 2031", spend: 980, avg: 1090.2 },
  ];

  it("reads the points, the x axis, each series by name, through arrays and fragments", () => {
    const chart = h(
      ComposedChart,
      { data },
      h(XAxis, { dataKey: "label" }),
      h(YAxis, {}),
      h(Legend, {}),
      [h(Bar, { key: "b", dataKey: "spend", name: "Spending" })],
      h(Fragment, {}, h(Line, { dataKey: "avg", name: "Average" }), false),
      h(Line, { dataKey: "hidden", legendType: "none" }),
    );
    const r = readChart(chart)!;
    expect(r.x).toBe("label");
    expect(r.series).toEqual([
      { key: "spend", name: "Spending" },
      { key: "avg", name: "Average" },
    ]);
    expect(r.rows).toBe(data);
    expect(r.format(1200.4, "Spending", data[0]!)).toBe("1,200.4");
  });

  it("says each value in the chart's own tooltip words", () => {
    const chart = h(ComposedChart, { data }, h(XAxis, { dataKey: "label" }), h(Tooltip, { formatter: (v: unknown, n: unknown) => [`$${Math.round(Number(v))}`, String(n)] }), h(Bar, { dataKey: "spend" }));
    const r = readChart(chart)!;
    expect(r.series).toEqual([{ key: "spend", name: "spend" }]);
    expect(r.format(980, "spend", data[1]!)).toBe("$980");
  });

  it("offers no table for a chart it can't read", () => {
    expect(readChart(h(ComposedChart, { data: [] }, h(XAxis, { dataKey: "label" }), h(Bar, { dataKey: "spend" })))).toBeNull();
    expect(readChart(h(ComposedChart, { data }, h(Bar, { dataKey: "spend" })))).toBeNull();
    expect(readChart("text")).toBeNull();
  });
});
