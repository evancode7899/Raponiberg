import type { HealthPlan, NetworkAmounts } from "../../medical/plans.ts";
import type { ClaimView, MedicalReport, Slice, YearView } from "../../medical/report.ts";
import type { EobBalance } from "../../medical/types.ts";
import { c, ln, t, type DerivedFigure } from "./types.ts";

/**
 * Medical: what the EOBs say each claim, person, provider, kind of care and year cost, who
 * paid it, the year's deductible and out-of-pocket balances as the insurer printed them,
 * and the plan's limits as its documents state them. Keys: a year is "COVERAGE|year", a
 * slice of it "COVERAGE|year|name", a claim its claim ID, a statement its file, a plan
 * limit "planId|network|individual|family".
 */

export const yearKey = (y: Pick<YearView, "coverage" | "year">) => `${y.coverage}|${y.year}`;
export const sliceKey = (y: Pick<YearView, "coverage" | "year">, name: string) => `${yearKey(y)}|${name}`;
export const balanceKey = (y: Pick<YearView, "coverage" | "year">, b: Pick<EobBalance, "person" | "kind" | "inNetwork">) => `${yearKey(y)}|${b.person ?? "Family"}|${b.kind}|${b.inNetwork ? "in" : "out"}`;
export const planLimitKey = (p: Pick<HealthPlan, "id">, network: "in" | "out", who: "individual" | "family") => `${p.id}|${network}|${who}`;

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const PRINTED = { source: "proven" as const };
const claimLabel = (x: ClaimView) => `${x.firstDate} ${x.patient}, ${x.provider || "provider not printed"} (claim ${x.id})`;

/** The chain of a sum over claims: each claim, then the total. */
function claimChain(xs: readonly ClaimView[], pick: (x: ClaimView) => number, total: number, label: string) {
  return [...xs.map((x, i) => ln(claimLabel(x), c(pick(x)), i ? "+" : undefined, PRINTED)), ln(label, c(total), "=")];
}

function claimFigures(x: ClaimView): DerivedFigure[] {
  const key = x.id;
  const replaced = x.earlier.length ? `Replaces ${x.earlier.map((e) => `claim ${e.id} of the EOB of ${e.statementDate} (you owed ${usd(e.yourShareCents)}, the plan paid ${usd(e.planCents)})`).join("; ")}.` : undefined;
  const add = (figure: string, describes: string, cents: number, lines: DerivedFigure["lines"]): DerivedFigure => ({ figure, key, describes: `Claim ${x.id}: ${describes}`, value: c(cents), lines, ...(replaced ? { note: replaced } : {}) });
  const lineLabel = (l: ClaimView["lines"][number]) => `${l.date}${l.dateTo ? `–${l.dateTo}` : ""} ${l.service}${l.code ? ` (${l.code})` : ""}`;
  const byLine = (pick: (l: ClaimView["lines"][number]) => number, total: number, label: string) => [...x.lines.map((l, i) => ln(lineLabel(l), c(pick(l)), i ? "+" : undefined, PRINTED)), ln(label, c(total), "=")];
  return [
    add("claim-billed", "amount billed", x.billedCents, byLine((l) => l.billedCents, x.billedCents, "Billed, as the claim's totals print it")),
    add(
      "claim-plan",
      "what the plan paid",
      x.planCents,
      x.cob ? [ln("The plan's payment after coordination of benefits, as the EOB's COB facts print it", c(x.planCents), undefined, PRINTED)] : byLine((l) => l.planCents, x.planCents, "Plan's share, as the claim's totals print it"),
    ),
    add(
      "claim-you",
      "what you owe the provider",
      x.yourShareCents,
      x.cob
        ? [ln("Your share after the other plan paid, as the EOB's COB facts print it", c(x.yourShareCents), undefined, PRINTED)]
        : byLine((l) => l.yourShareCents, x.yourShareCents, "Your share, as the claim's totals print it"),
    ),
    ...(x.cob ? [add("claim-other", "what the other plan paid first", x.otherPlanCents, [ln("Other plan(s) paid, as the EOB's COB facts print it", c(x.otherPlanCents), undefined, PRINTED)])] : []),
  ];
}

function sliceFigures(y: YearView, s: Slice, kind: "person" | "provider" | "kind", claims: readonly ClaimView[], of: (x: ClaimView) => string): DerivedFigure[] {
  const key = sliceKey(y, s.key);
  const xs = claims.filter((x) => x.coverage === y.coverage && x.year === y.year && of(x) === s.key);
  const add = (figure: string, describes: string, cents: number, pick: (x: ClaimView) => number): DerivedFigure => ({ figure, key, describes: `${y.year} ${s.key}: ${describes}`, value: c(cents), lines: claimChain(xs, pick, cents, describes[0]!.toUpperCase() + describes.slice(1)) });
  return [add(`${kind}-you`, "what you owe", s.yourShareCents, (x) => x.yourShareCents), add(`${kind}-plan`, "what the plan paid", s.planCents, (x) => x.planCents), ...(kind === "kind" || kind === "provider" ? [add(`${kind}-billed`, "billed", s.billedCents, (x) => x.billedCents)] : [])];
}

export const BALANCE_LABEL = { DEDUCTIBLE: "deductible", OUT_OF_POCKET: "out-of-pocket limit", ANNUAL_MAXIMUM: "annual maximum" } as const;

function balanceFigures(y: YearView): DerivedFigure[] {
  const b = y.balances;
  if (!b) return [];
  return b.rows.flatMap((row) => {
    const key = balanceKey(y, row);
    const what = `${row.person ?? "the family"}'s ${row.inNetwork ? "in-network" : "out-of-network"} ${BALANCE_LABEL[row.kind]}`;
    const src = `As the EOB of ${row.asOf} prints it (balances ${b.from} to ${b.to}${row.includesPharmacy ? ", medical and pharmacy" : ""})`;
    return [
      { figure: "balance-used", key, describes: `${y.year}: ${what}, used`, value: c(row.usedCents), lines: [ln("Used", c(row.usedCents), undefined, { source: "proven", note: src })] },
      { figure: "balance-limit", key, describes: `${y.year}: ${what}`, value: c(row.limitCents), lines: [ln("Annual limit", c(row.limitCents), undefined, { source: "proven", note: src })] },
      {
        figure: "balance-left",
        key,
        describes: `${y.year}: ${what}, left`,
        value: c(row.remainingCents),
        lines: [ln("Annual limit", c(row.limitCents), undefined, PRINTED), ln("Used", c(row.usedCents), "−", PRINTED), ln("Left", c(row.limitCents - row.usedCents), "=", { note: src })],
      },
    ];
  });
}

function yearFigures(y: YearView, claims: readonly ClaimView[]): DerivedFigure[] {
  const key = yearKey(y);
  const xs = claims.filter((x) => x.coverage === y.coverage && x.year === y.year);
  const T = y.totals;
  const byPerson = (pick: (s: Slice) => number, label: string) => [...y.people.map((p, i) => ln(p.key, c(pick(p)), i ? "+" : undefined)), ln(label, c(pick({ ...T, key: "", visits: 0 })), "=")];
  const add = (figure: string, describes: string, value: DerivedFigure["value"], lines: DerivedFigure["lines"], parts?: DerivedFigure["parts"]): DerivedFigure => ({ figure, key, describes: `${y.year}: ${describes}`, value, lines, ...(parts ? { parts } : {}) });
  const claimParts = (pick: (x: ClaimView) => number) => xs.filter((x) => pick(x) !== 0).map((x) => ({ label: claimLabel(x), value: c(pick(x)) }));
  return [
    add("you-owe", "what you owe providers, by the EOBs", c(T.yourShareCents), byPerson((s) => s.yourShareCents, "You owe"), claimParts((x) => x.yourShareCents)),
    add("plan-paid", "what the plan paid", c(T.planCents), byPerson((s) => s.planCents, "Plan paid"), claimParts((x) => x.planCents)),
    add("billed", "billed by providers", c(T.billedCents), byPerson((s) => s.billedCents, "Billed"), claimParts((x) => x.billedCents)),
    add("other-paid", "paid first by another plan", c(T.otherPlanCents), claimChain(xs.filter((x) => x.otherPlanCents), (x) => x.otherPlanCents, T.otherPlanCents, "Other plans paid")),
    add("write-off", "network discounts and charges you don't owe", c(T.writeOffCents), [
      ln("Billed", c(T.billedCents)),
      ln("Plan paid", c(T.planCents), "−"),
      ln("Other plans paid", c(T.otherPlanCents), "−"),
      ln("You owe", c(T.yourShareCents), "−"),
      ln("Discounts and charges you don't owe", c(T.writeOffCents), "="),
    ]),
    add("claims", "claims processed", t(String(T.claims)), [ln("Claims (an adjusted claim counts once)", t(String(T.claims)))]),
    ...balanceFigures(y),
    ...y.people.flatMap((s) => sliceFigures(y, s, "person", claims, (x) => x.patient)),
    ...y.providers.flatMap((s) => sliceFigures(y, s, "provider", claims, (x) => x.provider || "Provider not printed")),
    ...y.kinds.flatMap((s) => sliceFigures(y, s, "kind", claims, (x) => x.kind)),
  ];
}

function planFigures(p: HealthPlan): DerivedFigure[] {
  const src = { source: "proven" as const, note: `As the plan's documents print it (${p.sources.map((s) => s.title).join("; ") || "data/medical-plans.json"}); held to the EOBs' own limits by Statements › Checks.` };
  const one = (figure: string, network: "in" | "out", who: "individual" | "family", cents: number | null | undefined, what: string): DerivedFigure[] =>
    cents == null ? [] : [{ figure, key: planLimitKey(p, network, who), describes: `${p.name}: ${network === "in" ? "in-network" : "out-of-network"} ${who} ${what}`, value: c(cents), lines: [ln(`${who === "family" ? "Family" : "Individual"} ${what}, ${network === "in" ? "in" : "out of"} network`, c(cents), undefined, src)] }];
  const both = (figure: string, n: NetworkAmounts | null, what: string) => [
    ...one(figure, "in", "individual", n?.inNetwork.individualCents, what),
    ...one(figure, "in", "family", n?.inNetwork.familyCents, what),
    ...one(figure, "out", "individual", n?.outOfNetwork?.individualCents, what),
    ...one(figure, "out", "family", n?.outOfNetwork?.familyCents, what),
  ];
  return [
    ...both("plan-deductible", p.deductible, "deductible"),
    ...both("plan-oop", p.outOfPocket, "out-of-pocket limit"),
    // The annual maximum is one amount wherever the care is: keyed as in network.
    ...one("plan-max", "in", "individual", p.annualMaximum?.individualCents, "annual maximum"),
    ...one("plan-max", "in", "family", p.annualMaximum?.familyCents, "annual maximum"),
    ...(p.allowances ?? []).map((a) => ({ figure: "plan-allowance", key: `${p.id}|${a.id}`, describes: `${p.name}: ${a.service} allowance`, value: c(a.cents), lines: [ln(`${a.service} allowance`, c(a.cents), undefined, src)] })),
  ];
}

export function medicalDerived(r: Pick<MedicalReport, "years" | "claims" | "statements" | "plans">): DerivedFigure[] {
  return [
    ...r.years.flatMap((y) => yearFigures(y, r.claims)),
    ...r.claims.flatMap(claimFigures),
    ...r.statements.flatMap((s) => {
      const xs = r.claims.filter((x) => x.file === s.file);
      const note = xs.length < s.claims ? "Claims this statement printed that a later adjustment replaced count on the statement, not in the year." : undefined;
      return [
        { figure: "statement-you", key: s.file, describes: `EOB of ${s.statementDate}: what you owe`, value: c(s.yourShareCents), lines: [ln("What you owe on its claims", c(s.yourShareCents), undefined, PRINTED)], ...(note ? { note } : {}) },
        { figure: "statement-plan", key: s.file, describes: `EOB of ${s.statementDate}: what the plan paid`, value: c(s.planCents), lines: [ln("What the plan paid on its claims", c(s.planCents), undefined, PRINTED)], ...(note ? { note } : {}) },
      ];
    }),
    ...r.plans.flatMap(planFigures),
  ];
}
