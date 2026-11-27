import type { LpEvent, LpFund } from "../../funds/report.ts";
import { c, ln, r, t, type DerivedFigure } from "./types.ts";

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
      add("returned", "contributions returned at later closes", c(f.returnedCents), [ln("Returned on the equalisation notices", c(f.returnedCents), undefined, { source: "proven" })]),
      add("other", "distributions beyond the notices", c(f.otherDistributionsCents), [ln("Distributions the capital statement reports beyond the notices", c(f.otherDistributionsCents), undefined, { source: "proven" })]),
      add("wired", "bank wires on file", c(f.wiredCents), f.events.filter((e) => e.wire).map((e, i) => ln(`${e.wire!.date}, ${e.wire!.accountName}`, c(e.wire!.amountCents), i ? "+" : undefined, { source: "proven" }))),
      add(
        "unfunded-share",
        "share of the commitment still to be called",
        f.commitmentCents && f.unfundedCents != null ? r(f.unfundedCents / f.commitmentCents) : null,
        f.commitmentCents && f.unfundedCents != null ? [ln("Unfunded", c(f.unfundedCents), undefined, { source: "proven" }), ln("÷ commitment", c(f.commitmentCents), "÷", { source: "proven" }), ln("Share", r(f.unfundedCents / f.commitmentCents), "=")] : [],
      ),
      ...statementRow(f),
      ...f.events.flatMap((e) => eventFigures(f, e)),
      ...f.checks.flatMap((x) => [
        { figure: "check-printed", key: `${key}|${x.label}`, describes: `${f.fund}: ${x.label}, as the manager printed it`, value: c(x.expectedCents), lines: [ln(`${x.label}, printed`, c(x.expectedCents), undefined, { source: "proven" })] },
        { figure: "check-notices", key: `${key}|${x.label}`, describes: `${f.fund}: ${x.label}, from the notices on file`, value: c(x.actualCents), lines: [ln(`${x.label}, added up from the notices`, c(x.actualCents), undefined, { source: "proven" })] },
      ]),
    ];
  });
}

/** The latest capital statement's row (key: the fund's key), as the statement prints it. */
function statementRow(f: LpFund): DerivedFigure[] {
  const s = f.statement;
  if (!s) return [];
  const row = (figure: string, describes: string, cents: number, lines?: DerivedFigure["lines"]): DerivedFigure => ({ figure, key: f.key, describes: `${f.fund}: ${describes}, ${s.asOf} statement`, value: c(cents), lines: lines ?? [ln(`${describes[0]!.toUpperCase()}${describes.slice(1)}, as the statement prints it`, c(cents), undefined, { source: "proven" })] });
  return [
    row("st-paid-in", "contributions called through the statement", s.paidInCents),
    row("st-distributed", "distributions through the statement", s.distributedCents),
    row("st-gain", "gain", s.gainCents, [ln("NAV", c(s.navCents), undefined, { source: "proven" }), ln("+ distributions", c(s.distributedCents), "+", { source: "proven" }), ln("− paid in", c(s.paidInCents), "−", { source: "proven" }), ln("Gain", c(s.gainCents), "=")]),
    row("st-income", "income to date", s.incomeCents),
    row("st-fees", "management fees", s.managementFeeCents),
    row("st-carry", "carried interest", s.carryCents),
  ];
}

/** A notice or statement on the fund's timeline (key: fund key|kind+date): what it called, handed back and was wired, as printed. */
export const eventKey = (f: Pick<LpFund, "key">, e: Pick<LpEvent, "kind" | "date">) => `${f.key}|${e.kind}${e.date}`;
function eventFigures(f: LpFund, e: LpEvent): DerivedFigure[] {
  const key = eventKey(f, e);
  const out: DerivedFigure[] = [];
  const add = (figure: string, describes: string, cents: number) => out.push({ figure, key, describes: `${f.fund}, ${e.label} of ${e.date}: ${describes}`, value: c(cents), lines: [ln(`${describes[0]!.toUpperCase()}${describes.slice(1)}, as printed`, c(cents), undefined, { source: "proven" })] });
  if (e.kind !== "STATEMENT") {
    if (e.calledCents) add("ev-called", "called", e.calledCents);
    if (e.returnedCents) add("ev-returned", "handed back", e.returnedCents);
    if (e.interestCents) add("ev-interest", "interest", e.interestCents);
    add("ev-net", "net due", e.netDueCents);
  }
  if (e.wire) add("ev-wire", `bank wire on ${e.wire.date}`, e.wire.amountCents);
  if (e.unfundedCents != null) add("ev-unfunded", "unfunded after", e.unfundedCents);
  if (e.navCents != null) add("ev-nav", "capital account (NAV)", e.navCents);
  return out;
}
