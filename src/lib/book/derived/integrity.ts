import type { IntegrityReport } from "../types.ts";
import { ln, t, type DerivedFigure } from "./types.ts";

type Report = Pick<IntegrityReport, "checks" | "findings" | "inferences" | "accepted" | "stale"> & { horizon: { netWorth: string } };

/**
 * Statements › Issues: the integrity tiles, proven from the Book's own integrity report.
 * Each is a count (or the data edge's date), and its proof lists exactly what it counts:
 * the open findings inside the data edge, the checks with nothing failing or missing, the
 * inferences, the exceptions you accepted.
 */
export function integrityDerived(r: Report): DerivedFigure[] {
  const inRange = r.findings.filter((f) => !f.atEdge);
  const failing = inRange.filter((f) => f.status === "FAIL");
  const missing = inRange.filter((f) => f.status === "MISSING");
  const passing = r.checks.filter((c) => c.failed === 0 && c.missing === 0);
  const count = (figure: string, describes: string, xs: { title: string }[], what: string): DerivedFigure => ({
    figure,
    describes,
    value: t(String(xs.length)),
    lines: [ln(what, t(String(xs.length)), undefined, { source: "proven" })],
    parts: xs.map((x) => ({ label: x.title, value: t("1") })),
  });
  return [
    count("failing", "Open findings: data that contradicts itself", failing, "Failing findings inside the data edge"),
    count("missing", "Open findings: statements or stubs not on file", missing, "Missing findings inside the data edge"),
    { figure: "proven-through", describes: "The data edge: every figure stops here", value: t(r.horizon.netWorth), lines: [ln("Net worth is proven through", t(r.horizon.netWorth), undefined, { source: "proven", note: "The last day every account's statements cover." })] },
    {
      figure: "checks-passing",
      describes: "Checks with nothing failing or missing",
      value: t(`${passing.length} / ${r.checks.length}`),
      lines: [ln("Checks fully passing", t(String(passing.length)), undefined, { source: "proven" }), ln("Checks run", t(String(r.checks.length)))],
      parts: r.checks.map((c) => ({ label: c.id, value: t(c.failed || c.missing ? `${c.failed} failing · ${c.missing} missing` : "passing") })),
    },
    count("inferred", "Facts inferred from other sources", r.inferences, "Inferences"),
    { ...count("accepted", "Exceptions you accepted", r.accepted, "Accepted exceptions"), lines: [ln("Accepted exceptions", t(String(r.accepted.length)), undefined, { source: "assumption" }), ln("To review (their finding no longer arises)", t(String(r.stale.length)))] },
  ];
}
