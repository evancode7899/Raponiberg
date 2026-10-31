import type { Outlook } from "../../profile/outlook.ts";
import type { StressTest } from "../../fire/fire.ts";
import type { AccessFigure, LongTermTable, PlanCellValue, StressFigure } from "../../fire/longTerm.ts";
import type { Flows } from "../../forecast/periods.ts";
import type { RentVsBuyFigure, RentVsBuyFigures } from "../../home-budget/rentVsBuy.ts";
import type { MortgageFigure, MortgageFigures } from "../../mortgage/figures.ts";
import type { MortgageInputs } from "../../mortgage/inputs.ts";
import type { YearEstimate } from "../../profile/yearEstimate.ts";
import { centsRoute, invariant, ratioRoute, textRoute } from "../proof/independence.ts";
import type { ProofValue, Rederivation, RederivedRoute } from "../proof/types.ts";

/**
 * The F4 planning figures worked out a second way (F5). These are models: the page and its
 * proof run the same one, so the second route here is what the model must satisfy whatever
 * it computes: a year's net worth rolls (Dec 31 = Jan 1 + saved + growth) and the columns
 * chain; parts add to their whole; a total is its actual part plus its forecast rest; the
 * mortgage's interest by the annuity formula rather than the month-by-month run; a
 * break-even is where the advantage changes sign. What only the model can say (a typed
 * assumption, a seeded simulation's draw) is declared.
 */

const cents = (v: PlanCellValue | null | undefined): number | null => (v && "cents" in v ? v.cents : null);
const ratio = (v: PlanCellValue | null | undefined): number | null => (v && "ratio" in v ? v.ratio : null);
const routes = (xs: (RederivedRoute | null)[]): Rederivation | null => {
  const out = xs.filter((x): x is RederivedRoute => x != null);
  return out.length ? { routes: out } : null;
};

const MODEL = { none: "A year of the plan's model on the saved drivers and FIRE settings: its net worth roll (Dec 31 = Jan 1 + saved + growth) and how the columns chain are what's held independently." };
const TYPED = { none: "A rate typed on the FIRE page or the forecast's drivers: an assumption, nothing to re-derive." };
const PROVEN = { none: "A proven year as the annual statement shows it: the Annual page's own proof re-adds it from the statements." };

/** A long-term table cell (FIRE › Plan). `nwAt` is a proven Dec 31 from the ledger's balances, account by account, plus the money the annual statement counts in transit between the household's accounts. */
export function rederivePlanCell(t: LongTermTable, full: Outlook, row: string, col: string, value: ProofValue, o: { birthYear: number | null; nwAt: (iso: string) => number }): Rederivation {
  const j = t.columns.findIndex((c) => c.id === col);
  const cell = (id: string, k: number) => {
    const r = t.rows.find((x) => x.kind === "row" && x.id === id);
    return r && r.kind === "row" ? (r.cells[k] ?? null) : null;
  };
  const year = Number(/(\d{4})/.exec(col)?.[1]);
  const firstPlan = t.projected[0] ?? t.columns.length;
  const totalCol = t.highlight[0];
  const isTotal = j === totalCol;
  const isPlan = t.projected.includes(j);
  const isYtd = totalCol != null && j === totalCol - 2;
  const y = isPlan ? full.years.find((x) => x.year === year) : undefined;
  const prev = j > 0 ? j - 1 : null;

  if (row === "age") return o.birthYear ? routes([textRoute("the year less the birth year", value, String(year - o.birthYear), `${year} − ${o.birthYear}`)])! : MODEL;
  if (row === "raise" || row === "living-growth" || row === "return") return TYPED;

  // The year in progress, whole: flows are its actual part plus the forecast rest; balances are the rest's.
  if (isTotal) {
    const rest = totalCol! - 1;
    const ytd = totalCol! - 2;
    if (row === "change") {
      // Opens on last Dec 31: the proven year just before the year so far.
      const open = cents(cell("net-worth", ytd - 1));
      const close = cents(cell("net-worth", rest));
      return routes([open && close != null ? ratioRoute("the rest's Dec 31 over last Dec 31", value, (close - open) / open, "net worth's change over the whole year", 1e-9) : null]) ?? MODEL;
    }
    if (["net-worth", "liquid", "illiquid", "net-worth-base", "bonus-estimated"].includes(row)) return routes([centsRoute("the forecast rest's figure", value, cents(cell(row, rest)) ?? 0, "a balance (or a forecast-only line) is the rest's own", 1)]) ?? MODEL;
    const a = cents(cell(row, ytd));
    const b = cents(cell(row, rest));
    return routes([a != null ? centsRoute("the year so far plus the forecast rest", value, a + (b ?? 0), "the actual column and the rest column, added", 1) : null]) ?? MODEL;
  }

  const nw = cents(cell("net-worth", j));
  const saved = cents(cell("saved", j));
  const growth = cents(cell("growth", j));
  const prevNw = prev != null ? cents(cell("net-worth", prev)) : null;
  switch (row) {
    case "net-worth": {
      if (y && saved != null && growth != null)
        return routes([
          centsRoute("Jan 1 + saved + growth", value, y.startNetWorth + saved + growth, "the year's opening balance and the table's saved and growth cells", 2),
          prevNw != null ? invariant("the columns chain", value, Math.abs(y.startNetWorth - prevNw) <= 2, `this year opens on ${Math.round(y.startNetWorth) / 100}, last column closed on ${prevNw / 100}`) : null,
        ])!;
      if (!isPlan && !isYtd && j < firstPlan) return routes([centsRoute("the ledger's balances on Dec 31, account by account, plus money in transit", value, o.nwAt(`${year}-12-31`), "every account's balance that day, and what was mid-move between them")])!;
      return routes([centsRoute("liquid + illiquid", value, (cents(cell("liquid", j)) ?? 0) + (cents(cell("illiquid", j)) ?? 0), "the two parts, added", 1)])!;
    }
    case "liquid":
    case "illiquid": {
      const other = cents(cell(row === "liquid" ? "illiquid" : "liquid", j));
      return nw != null && other != null ? routes([centsRoute("net worth less the other part", value, nw - other, "Dec 31 net worth split into liquid and illiquid", 1)])! : MODEL;
    }
    case "growth":
      if (y && nw != null && saved != null) return routes([centsRoute("Dec 31 − Jan 1 − saved", value, nw - y.startNetWorth - saved, "what the year's roll leaves for growth", 2)])!;
      if (nw != null && saved != null && prevNw != null && prev != null && prev < firstPlan) return routes([centsRoute("the change in net worth less what was saved", value, nw - prevNw - saved, "this Dec 31 less last, less saved", 2)])!;
      return PROVEN;
    case "change":
      return nw != null && prevNw ? routes([ratioRoute("this column's net worth over the last", value, (nw - prevNw) / prevNw, "the change over the opening", 1e-6)])! : y ? MODEL : PROVEN;
    case "bonus": {
      const known = cents(cell("bonus-known", j));
      const est = cents(cell("bonus-estimated", j));
      if (isPlan && (known != null || est != null)) return routes([centsRoute("paid or on a letter + estimated", value, (known ?? 0) + (est ?? 0), "the two bonus lines, added", 1)])!;
      return isPlan ? MODEL : PROVEN;
    }
    case "after-tax": {
      const draw = cents(cell("draw", j));
      const tax = cents(cell("draw-taxes", j));
      return draw != null && tax != null ? routes([centsRoute("the draw less its taxes", value, -draw + tax, "pre-tax draw less taxes on it", 2)])! : MODEL;
    }
    case "coverage": {
      const after = cents(cell("after-tax", j));
      const living = cents(cell("living", j));
      return after != null && living ? routes([ratioRoute("after-tax income over living cost", value, after / -living, "the two cells, divided", 1e-6)])! : MODEL;
    }
    case "salary":
    case "living": {
      // A whole plan year after a whole plan year: last year's grown by the year's raise (salary) or living cost growth.
      const before = full.years.find((x) => x.year === year - 1);
      const grow = ratio(cell(row === "salary" ? "raise" : "living-growth", j));
      const last = cents(cell(row, j - 1));
      if (y?.months === 12 && before?.months === 12 && grow != null && last != null && (row === "living" || (y.working && before.working)))
        return routes([centsRoute("last year's grown at the year's rate", value, Math.round(last * (1 + grow)), `${last / 100} × (1 + ${grow})`, 12)])!;
      return isPlan || isYtd ? MODEL : PROVEN;
    }
    default:
      return isPlan || isYtd ? MODEL : PROVEN;
  }
}

/** FIRE › Plan's bridge to 59½: its balances are the long-term plan's on the Dec 31 before walking away; access is birth year + 60. */
export function rederiveAccess(metric: AccessFigure, value: ProofValue, o: { walkAway: number; birthYear: number | null; plan: Outlook }): Rederivation {
  const before = o.plan.years.find((y) => y.year === o.walkAway - 1);
  if (metric === "access-year") return o.birthYear ? { routes: [textRoute("birth year + 60", value, String(o.birthYear + 60), "the first full year of penalty-free access")] } : { none: "No birth year." };
  if (metric === "liquid-out") return { none: "The first retired year the bridge's own run starts with no liquid money: only that run says." };
  if (!before) return { none: "The plan doesn't reach the year before walking away." };
  return { routes: [centsRoute("the long-term plan's Dec 31 before walking away", value, Math.round(metric === "liquid" ? before.liquid : before.illiquid), `the table's ${o.walkAway - 1} balances`, 1)] };
}

/** FIRE › Stress test: a seeded simulation's draw, held to what any set of paths must satisfy. */
export function rederiveStress(metric: StressFigure, value: ProofValue, st: StressTest, fiYear: number | null): Rederivation {
  const yr = (x: number | null) => x ?? Infinity;
  const ordered = yr(st.fiYears.p10) <= yr(st.fiYears.p50) && yr(st.fiYears.p50) <= yr(st.fiYears.p90);
  const rising = st.fiByYear.every((x, i) => i === 0 || x.share >= st.fiByYear[i - 1]!.share - 1e-12);
  const out: RederivedRoute[] = [invariant("best ≤ median ≤ worst FI year", value, ordered, "the percentiles are in order"), invariant("the share at FI only rises", value, rising, "a path that reached FI stays there")];
  if (metric === "by-fi") out.push(invariant("a share of the paths", value, "ratio" in value && value.ratio >= 0 && value.ratio <= 1 && (fiYear == null || value.ratio === (st.fiByYear.find((x) => x.year === fiYear)?.share ?? value.ratio)), "between 0 and 1, read at the steady plan's FI year"));
  if (metric === "p50" && st.fiYears.p50) {
    const at = st.fiByYear.find((x) => x.year === st.fiYears.p50)?.share;
    out.push(invariant("half the paths are FI by the median year", value, at == null || at >= 0.5 - 1 / st.paths, `${((at ?? 0) * 100).toFixed(1)}% of paths by then`));
  }
  return { routes: out };
}

/** Mortgage: interest by the annuity formula, month by month in closed form; the break-even as a root; the advantage's sign. */
export function rederiveMortgage(figure: MortgageFigure, value: ProofValue, eff: MortgageInputs, m: MortgageFigures, advantageAt: (investReturn: number) => number): Rederivation {
  const H = m.horizon;
  if (figure === "interest-saved") {
    if (eff.lumps.length > 0) return { routes: [invariant("paying down never adds interest", value, "cents" in value && value.cents >= -1, "interest saved is never below zero")] };
    const r = Math.max(0, eff.rate) / 12;
    const n = Math.round(eff.termYears * 12);
    const P = eff.principal;
    const M = r === 0 ? P / n : (P * r) / (1 - Math.pow(1 + r, -n));
    const defl = (k: number) => (eff.realDollars ? Math.pow(1 + eff.inflation, k / 12) : 1);
    // Balance after k payments of X, by the annuity formula (never below zero).
    const balance = (X: number, k: number) => Math.max(0, r === 0 ? P - X * k : P * Math.pow(1 + r, k) - (X * (Math.pow(1 + r, k) - 1)) / r);
    const interest = (X: number) => {
      let t = 0;
      for (let k = 1; k <= H; k++) t += (balance(X, k - 1) * r) / defl(k);
      return t;
    };
    const saved = Math.round((interest(M) - interest(M + eff.extraMonthly)) * 100);
    return { routes: [centsRoute("each month's interest by the annuity formula", value, saved, "balance × rate, the balance in closed form, the scheduled payment against the scheduled payment plus the extra", Math.max(2, Math.round(H / 12)))] };
  }
  const be = m.values["break-even"];
  const breakEven = "ratio" in be ? be.ratio : null;
  if (figure === "break-even") {
    if (breakEven == null) return { none: "No break-even within the search range." };
    const lo = advantageAt(breakEven - 0.0005);
    const hi = advantageAt(breakEven + 0.0005);
    return { routes: [invariant("the advantage changes sign at the break-even return", value, lo * hi <= 0 || Math.abs(lo) < 100 || Math.abs(hi) < 100, `investing comes to ${Math.round(lo)} just below it and ${Math.round(hi)} just above`)] };
  }
  if (figure === "advantage") {
    if (breakEven == null || !("cents" in value)) return { none: "No break-even to hold the advantage's sign to." };
    const above = eff.investReturn > breakEven;
    return { routes: [invariant("investing wins exactly when its return beats the break-even", value, Math.abs(value.cents) < 100 || value.cents > 0 === above, `return ${eff.investReturn} against a break-even of ${breakEven}`)] };
  }
  return { routes: [invariant("a share of the simulated markets", value, "ratio" in value && value.ratio >= 0 && value.ratio <= 1, "between 0 and 1")] };
}

/** Rent vs buy: owning's cost from its components, the tiles read along the year-by-year run. */
export function rederiveRentVsBuy(figure: RentVsBuyFigure, value: ProofValue, r: RentVsBuyFigures): Rederivation {
  const yrs = r.sim.years;
  switch (figure) {
    case "rvb-rent":
      return { none: "The market rent typed on the page: an input." };
    case "rvb-owning":
      return { routes: [centsRoute("its cost components, re-added", value, Math.round(r.snap.components.reduce((s, c) => s + c.monthly, 0) * 100), "interest, tax, insurance, upkeep and the rest, a month", r.snap.components.length)] };
    case "rvb-ahead": {
      const y = yrs[r.horizon - 1];
      return y ? { routes: [centsRoute("the buyer's wealth less the renter's, that year", value, Math.round((y.buyerWealth - y.renterWealth) * 100), `both households cashed out at the end of year ${y.year}`, 1)] } : { none: "The run doesn't reach that year." };
    }
    case "rvb-break-even": {
      const k = r.sim.breakEvenYear;
      const ahead = (y: (typeof yrs)[number]) => y.buyerWealth - y.renterWealth >= 0;
      const text = k ? `Year ${k}` : "Never";
      const holds = k ? yrs.slice(k - 1).every(ahead) && (k === 1 || !ahead(yrs[k - 2]!)) : !ahead(yrs.at(-1)!) || !yrs.every(ahead);
      return { routes: [textRoute("the first year buying stays ahead to the end", value, holds ? text : "inconsistent", "buyer's less renter's wealth, year by year")] };
    }
  }
}

/** The annual estimate: each flow is its year to date plus the forecast rest; the column's own identities. */
export function rederiveEstimate(line: string, value: ProofValue, e: YearEstimate, all: Record<string, ProofValue>): Rederivation {
  const add = (k: keyof Flows) => {
    const a = e.parts.ytd[k] as number | null;
    const b = e.parts.rest[k] as number | null;
    return a == null && b == null ? null : (a ?? 0) + (b ?? 0);
  };
  const c = (id: string) => {
    const v = all[id];
    return v && "cents" in v ? v.cents : null;
  };
  const PARTS = "the year to date plus the forecast rest";
  const flow = (k: keyof Flows, sign = 1) => {
    const v = add(k);
    return v == null ? null : centsRoute(PARTS, value, sign * v, `${String(k)}, actual through ${e.ytd.asOf} and forecast after`, 1);
  };
  const r = (xs: (RederivedRoute | null)[]) => {
    const out = xs.filter((x): x is RederivedRoute => x != null);
    return out.length ? { routes: out } : null;
  };
  const gross = (c("salary") ?? 0) + (c("bonus") ?? 0) + (c("other-income") ?? 0);
  let out: Rederivation | null = null;
  switch (line) {
    case "salary":
    case "bonus":
    case "employer":
    case "saved":
      out = r([flow(line === "saved" ? "saved" : line)]);
      break;
    case "to-retirement":
      out = r([flow("toRetirement")]);
      break;
    case "other-income":
      out = r([centsRoute(PARTS, value, add("otherIncome") ?? 0, "interest, dividends and other income so far (the forecast has none)", 1)]);
      break;
    case "taxes-deductions":
      out = r([flow("taxes", -1)]);
      break;
    case "one-offs":
      out = r([centsRoute(PARTS, value, -(add("oneOffs") ?? 0), "one-offs", 1)]);
      break;
    case "living":
      out = r([centsRoute(PARTS, value, -((add("living") ?? 0) + (add("bonusSpent") ?? 0)), "living cost and bonus spent", 2)]);
      break;
    case "gross":
      out = r([centsRoute("salary + bonus + other income", value, gross, "the column's three income lines", 0)]);
      break;
    case "net-cash":
      out = r([centsRoute("saved + living + one-offs, worked back", value, (c("saved") ?? 0) - (c("living") ?? 0) - (c("one-offs") ?? 0), "what the column spends and saves", 2)]);
      break;
    case "savings-of-gross":
      out = r([ratioRoute("saved over gross", value, gross > 0 ? (c("saved") ?? 0) / gross : null, "the column's own lines", 1e-9)]);
      break;
    case "net-worth":
      out = r([centsRoute("liquid + illiquid", value, (c("liquid") ?? 0) + (c("illiquid") ?? 0), "the two parts", 1), e.parts.rest.close ? centsRoute("the forecast rest's Dec 31", value, e.parts.rest.close.netWorth, "where the year closes", 1) : null]);
      break;
    case "liquid":
    case "illiquid":
      out = r([centsRoute("net worth less the other part", value, (c("net-worth") ?? 0) - (c(line === "liquid" ? "illiquid" : "liquid") ?? 0), "the split of Dec 31", 1)]);
      break;
    case "change":
      out = r([e.parts.ytd.open != null && e.parts.rest.close ? centsRoute("Dec 31 less last Dec 31", value, e.parts.rest.close.netWorth - e.parts.ytd.open, "where the year closes less where it opened", 2) : null]);
      break;
    case "change-pct":
      out = r([e.parts.ytd.open ? ratioRoute("the change over the opening", value, (c("change") ?? 0) / e.parts.ytd.open, "the column's change over Jan 1", 1e-9) : null]);
      break;
    case "partner-kept":
      out = { none: "A partner's pay kept in their own accounts before the merge: the year to date's own figure (the forecast has none)." };
      break;
    default:
      if (line === "bridge:total") out = r([centsRoute("its parts, re-added", value, ["cashSaved", "investmentGrowth", "outsideMoney", "newlyTracked", "inTransit", "unexplainedSavings"].reduce((s, k) => s + (c(`bridge:${k}`) ?? 0), 0), "what moved net worth, added", 2)]);
      else if (line === "bridge:cashSaved") out = r([centsRoute(PARTS, value, (e.ytd.bridge?.cashSaved ?? 0) + (e.parts.rest.saved ?? 0), "saved so far plus the rest's", 1)]);
      else if (line === "bridge:investmentGrowth") out = r([centsRoute(PARTS, value, (e.ytd.bridge?.investmentGrowth ?? 0) + (e.parts.rest.growth ?? 0), "growth so far plus the rest's returns", 1)]);
      else if (line.startsWith("bridge:")) out = { none: "The year to date's own figure on the annual statement (the forecast adds nothing to it)." };
      else if (line.startsWith("age:")) out = { none: "A member's age as the household file gives it." };
  }
  return out ?? { none: "Not a line the estimate re-adds." };
}
