import type { LpFund } from "../../funds/report.ts";
import { c, ln, t, type DerivedFigure } from "./types.ts";

/**
 * Investments › a private fund's LP view (key: the fund's key), from the manager's own
 * notices and capital statements: what was committed, called, handed back and wired, and
 * the capital account's value.
 */
export function fundsDerived(funds: LpFund[]): DerivedFigure[] {
  return funds.flatMap((f) => {
    const key = f.key;
    const s = f.statement;
    const add = (figure: string, describes: string, value: DerivedFigure["value"], lines: DerivedFigure["lines"]): DerivedFigure => ({ figure, key, describes: `${f.fund}: ${describes}`, value, lines });
    return [
      add("commitment", "capital committed", f.commitmentCents == null ? null : c(f.commitmentCents), [ln("Commitment, as the notices print it", f.commitmentCents == null ? t("—") : c(f.commitmentCents), undefined, { source: "proven" })]),
      add("called", "contributions called (gross)", c(f.calledCents), [ln("Every capital call, before anything handed back", c(f.calledCents), undefined, { source: "proven" })]),
      add("distributed", "distributions to date", c(f.distributedCents), [
        ln("Returned at later closes (recallable)", c(f.returnedCents), undefined, { source: "proven" }),
        ln("Interest from later investors", c(f.interestCents), "+", { source: "proven" }),
        ln("Other distributions", c(f.otherDistributionsCents), "+", { source: "proven" }),
        ln("Distributions to date", c(f.distributedCents), "="),
      ]),
      add("net-contributed", "contributions, net of what was returned", c(f.netContributedCents), [ln("Called", c(f.calledCents), undefined, { source: "proven" }), ln("Returned at later closes", c(f.returnedCents), "−", { source: "proven" }), ln("Net contributions", c(f.netContributedCents), "=")]),
      add("interest", "interest received on returned contributions", c(f.interestCents), [ln("Interest on the notices", c(f.interestCents), undefined, { source: "proven" })]),
      add("unfunded", "commitment still to be called", f.unfundedCents == null ? null : c(f.unfundedCents), f.commitmentCents == null || f.unfundedCents == null ? [] : [ln("Commitment", c(f.commitmentCents), undefined, { source: "proven" }), ln("Contributions to date, net", c(f.netContributedCents), undefined, { source: "proven" }), ln("Unfunded, as the latest notice prints it", c(f.unfundedCents), undefined, { source: "proven" })]),
      add("net-cash", "net cash due on the notices", c(f.netCashCents), [ln("Amounts due on the notices, net", c(f.netCashCents), undefined, { source: "proven" }), ln("Bank wires on file", c(f.wiredCents), undefined, { source: "proven" })]),
      add("nav", s ? `capital account at the ${s.asOf} statement` : "capital account", s ? c(s.navCents) : null, s ? [ln(`Capital account, ${s.asOf} statement`, c(s.navCents), undefined, { source: "proven" })] : []),
    ];
  });
}
