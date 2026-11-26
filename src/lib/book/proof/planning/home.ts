import { homeForecast } from "../../../forecast/forecast.ts";
import { loadForecastData } from "../../../forecast/load.ts";
import { computeBudgetScenario, computeLenderMax, computeMaxApproval, defaultHomeBudgetInputs, type HomeBudgetInputs, type MaxApprovalResult, monthlyPaymentOnLoan } from "../../../home-budget/homeBudgetModel.ts";
import { defaultFunds, type FundsBook, type FundsConfig, type HomeLinked, linkHome } from "../../../home-budget/homeLinked.ts";
import { type RentVsBuyFigure, rentVsBuyFigures, SIM_YEARS } from "../../../home-budget/rentVsBuy.ts";
import { type PayForTax, taxOnPay } from "../../../profile/basePay.ts";
import { TAX_YEARS } from "../../../tax/params.ts";
import type { Book } from "../../load.ts";
import { rederiveRentVsBuy } from "../../rederive/planning.ts";
import { buildHomeFunds, buildHomeSpending } from "../../reports/homeFunds.ts";
import { CASH_FLOW_CHECKS } from "../cashFlowProof.ts";
import { checksFor, perBook, sumCheck } from "../common.ts";
import { NET_WORTH_CHECKS } from "../netWorthProof.ts";
import type { PayDescriptor } from "../payProof.ts";
import type { HomeFigure, PlanningDescriptor } from "../planningProof.ts";
import type { ChainLine, ProofBlock, ProofContext, ProofLink, ProofValue } from "../types.ts";
import { type Base, baseFrom, type Built, cents, money, monthWord, notFound, pct, projected, projectionEstimate, seedLink, signed, START, yearCell } from "./shared.ts";

/** The Home budget page's figures (planningProof.ts): cash to put in, the most a home can cost, the lender's view, rent vs buy. */

type HomeCtx = { book: Book; fb: FundsBook; L: HomeLinked; inputs: HomeBudgetInputs; funds: FundsConfig; d: Extract<PlanningDescriptor, { page: "home" }>; b: Base | null };

export async function homeCtx(ctx: ProofContext, d: Extract<PlanningDescriptor, { page: "home" }>): Promise<HomeCtx> {
  // As api/home-budget/funds, then the page's own links (linkHome) on the typed inputs.
  const data = await perBook(ctx, "forecast-data", () => loadForecastData(ctx.db, ctx.book));
  const b = baseFrom(ctx.book, data);
  const fb: FundsBook = { ...buildHomeFunds(ctx.book), forecast: b ? homeForecast(b.f, b.seeds) : null, spending: buildHomeSpending(ctx.book, data.profile.settings) };
  const inputs = { ...defaultHomeBudgetInputs(), ...d.inputs };
  const funds = { ...defaultFunds(), ...d.funds };
  return { book: ctx.book, fb, L: linkHome(fb, inputs, funds, Number(ctx.book.today.slice(0, 4))), inputs, funds, d, b };
}

const homeLink = (c: HomeCtx, label: string, figure: HomeFigure): ProofLink => ({ label, descriptor: { report: "planning", page: "home", figure, inputs: c.d.inputs ?? {}, funds: c.d.funds ?? {} } });
export const typed = (label: string, value: ProofValue, note = "Typed on the Home budget page."): ChainLine => ({ label, value, source: "assumption", note });

function homeChecks(c: HomeCtx) {
  return checksFor(c.book, { affects: "NET_WORTH", from: c.fb.asOf, to: c.fb.asOf }, NET_WORTH_CHECKS);
}

function homeCashProof(c: HomeCtx): Built {
  const { L, fb } = c;
  const { checks, withheld } = homeChecks(c);
  if (!L.linked || !L.derived) {
    const why = c.funds.mode === "manual" ? "You chose a fixed amount." : "Net worth isn't proven, so the fixed amount stands in.";
    return { describes: "Cash for the home (a fixed amount)", figure: { cents: cents(L.ins.cashForHome) }, selfCheck: null, blocks: [{ kind: "chain", title: "Cash for the home", lines: [typed("Fixed amount", { cents: cents(L.ins.cashForHome) }, why)] }], checks, withheld, estimates: [], through: fb.asOf };
  }
  const D = L.derived;
  const nw = (label: string, ids: string[]): ProofLink | undefined => (ids.length ? { label, descriptor: { report: "net-worth", metric: "balance", date: fb.asOf, accountIds: ids } } : undefined);
  const cashIds = fb.accounts.filter((a) => a.group === "Cash").map((a) => a.accountId);
  const invIds = fb.accounts.filter((a) => a.group === "Taxable investments").map((a) => a.accountId);
  const cardIds = c.book.ledger.accounts.filter((a) => a.group === "Credit cards" && !a.closed).map((a) => a.id);
  const liquidC = cents(D.liquid);
  const afterTaxC = cents(D.afterTax);
  const availableC = cents(D.available);
  const lines: ChainLine[] = [
    { label: `Bank cash on ${fb.asOf}`, value: { cents: fb.cashCents }, source: "proven", ...(nw("Bank cash", cashIds) ? { link: nw("Bank cash", cashIds)! } : {}) },
    { op: "+", label: "Taxable investments", value: { cents: fb.investmentsCents }, source: "proven", ...(nw("Taxable investments", invIds) ? { link: nw("Taxable investments", invIds)! } : {}) },
  ];
  if (fb.cardsCents) lines.push(signed(fb.cardsCents, { label: "Card balances", source: "proven", ...(nw("Cards", cardIds) ? { link: nw("Cards", cardIds)! } : {}) }));
  // The forecast's addition is a difference of two balances: its cell is the liquid balance, in the block below.
  if (D.buyKey) lines.push({ op: D.added < 0 ? "−" : "+", label: `What the forecast adds by ${monthWord(D.buyKey)}`, value: { cents: Math.abs(cents(D.added)) }, source: "estimate", note: "Liquid savings and growth after the proven balances (worked out below)." });
  lines.push({ op: "=", label: D.buyKey ? `Liquid money at the end of ${monthWord(D.buyKey)}` : "Liquid money now", value: { cents: liquidC }, source: "derived" });
  lines.push({ op: "−", label: `Tax on ${money(cents(D.gain))} of gains`, value: { cents: liquidC - afterTaxC }, source: "derived", link: homeLink(c, "Gains tax rate", "gains-tax"), note: `Gains × ${pct(L.ins.capitalGainsTaxRate, 1)}.` });
  lines.push({ op: "=", label: "Liquid, after tax", value: { cents: afterTaxC }, source: "derived" });
  lines.push({ op: "×", label: "Share to put into the home", value: { ratio: c.funds.share }, source: "assumption" }, { op: "=", label: "Cash for the home", value: { cents: availableC }, source: "derived" });
  const gainLines: ChainLine[] = [{ label: "Growth in taxable investments since their first statements", value: { cents: fb.gainCents }, source: "proven", note: "Growth net of fees over every statement on file; withdrawals reduce basis dollar for dollar, so the tax errs high." }];
  // The ledger's growth line is liquid and illiquid together, and a span from the start isn't one of its columns: no cell holds it.
  if (D.buyKey) gainLines.push(projected("+", `Growth the forecast earns on liquid money by ${monthWord(D.buyKey)}`, cents(D.gainAdded), null, "Each month's growth on liquid money, from the start through the buy month."));
  gainLines.push({ op: "=", label: "Gains", value: { cents: cents(D.gain) }, source: "derived" });
  const parts = fb.cashCents + fb.investmentsCents + fb.cardsCents + (D.buyKey ? cents(D.added) : 0);
  return {
    describes: `Cash for the home${D.buyKey ? `, buying in ${monthWord(D.buyKey)}` : ""}`,
    figure: { cents: availableC },
    selfCheck: sumCheck(liquidC, parts, `Cash, investments and cards${D.buyKey ? " and what the forecast adds" : ""} come to ${money(parts)} of liquid money`),
    blocks: [
      { kind: "chain", title: "Cash for the home", lines, note: `Not counted: ${fb.excluded.map((e) => e.group.toLowerCase()).join(", ") || "nothing"}.` },
      ...(D.buyKey && c.b && fb.forecast
        ? [
            {
              kind: "chain" as const,
              title: `What the forecast adds by ${monthWord(D.buyKey)}`,
              lines: [
                projected(undefined, `Liquid money at the end of ${monthWord(D.buyKey)}`, fb.forecast.months.find((m) => m.key === D.buyKey)!.liquid, { month: D.buyKey, line: "liquid" }, "The forecast's liquid balance."),
                { op: "−" as const, label: `Liquid money at the start, ${c.b.seeds.start.asOf}`, value: { cents: fb.forecast.startLiquid }, source: "proven" as const, link: START },
                { op: "=" as const, label: "Added", value: { cents: cents(D.added) }, source: "derived" as const },
              ],
            },
          ]
        : []),
      { kind: "chain", title: "Gains taxed on the way out", lines: gainLines },
    ],
    checks,
    withheld: withheld || fb.blockers.length > 0,
    estimates: D.buyKey && c.b ? [projectionEstimate(c.b)] : [],
    through: fb.asOf,
  };
}

function homeSalaryProof(c: HomeCtx): Built {
  const { L } = c;
  const y = L.buy.year;
  if (!L.buy.salaryLinked || !c.b) return { describes: "Household salary (typed)", figure: { cents: cents(L.ins.annualHouseholdSalary) }, selfCheck: null, blocks: [{ kind: "chain", title: "Household salary", lines: [typed("Salary you typed", { cents: cents(L.ins.annualHouseholdSalary) })] }], estimates: [], through: c.fb.asOf };
  const { f } = c.b;
  const n = y - f.plan.start.year;
  const lines: ChainLine[] = f.pay.people.map((p, i) => ({
    op: i ? ("+" as const) : undefined,
    label: `${p.name}'s base salary`,
    value: { cents: p.salary },
    source: p.salaryTyped ? ("assumption" as const) : ("derived" as const),
    link: seedLink(`${p.name}'s pay`, { report: "forecast", figure: "seed", which: "pay", personId: p.personId, paycheck: p.basis }),
  }));
  lines.push({ op: "=", label: `Household base salary in ${f.plan.start.year}`, value: { cents: f.plan.salary }, source: "derived" });
  const salaryC = cents(L.buy.salary!);
  if (n > 0)
    lines.push(
      { op: "×", label: `(1 + raise)^${n}`, value: { ratio: (1 + f.plan.salaryGrowth) ** n }, source: "assumption", note: `${pct(f.plan.salaryGrowth)} a year, each January.` },
      projected("=", `Household base salary in ${y}`, salaryC, yearCell(y, "salary"), `The forecast's ${y}, Jan–Dec.`),
    );
  return {
    describes: `Household base salary in ${y}, from the forecast`,
    figure: { cents: salaryC },
    selfCheck: n > 0 ? null : sumCheck(salaryC, f.pay.people.reduce((t, p) => t + p.salary, 0), `Each person's base salary adds up to ${money(f.pay.people.reduce((t, p) => t + p.salary, 0))}`),
    blocks: [{ kind: "chain", title: "Base salary", lines, note: "Base pay only: bonuses aren't counted in the comfort view." }],
    estimates: n > 0 ? [projectionEstimate(c.b)] : [],
    through: c.b.seeds.start.asOf,
  };
}

/** The tax engine's lines on the salary (and a gain), as homeTax works them out. */
function homeTaxProof(c: HomeCtx, which: "income-tax" | "gains-tax"): Built {
  const { L } = c;
  const rate = which === "income-tax" ? L.tax.income : L.tax.gains;
  const used = which === "income-tax" ? L.ins.incomeTaxRate : L.ins.capitalGainsTaxRate;
  const word = which === "income-tax" ? "Income tax rate" : "Capital-gains tax rate";
  const basis = c.fb.forecast?.tax;
  if (!rate.linked || !basis) return { describes: `${word} (typed)`, figure: { ratio: used }, selfCheck: null, blocks: [{ kind: "chain", title: word, lines: [typed(`${word} you typed`, { ratio: used })] }], estimates: [], through: c.fb.asOf };
  const params = TAX_YEARS[basis.year]!;
  const salary = L.ins.annualHouseholdSalary;
  const people: PayForTax[] = basis.earners.map((e) => ({ id: e.id, name: e.name, salary: Math.round(salary * e.share * 100), bonus: 0, k401Pretax: 0, hsa: 0, section125: 0 }));
  const base = taxOnPay(params, people, basis.dependents);
  const salaryLine: ChainLine = { label: "Household salary", value: { cents: cents(salary) }, source: L.buy.salaryLinked ? "derived" : "assumption", link: homeLink(c, "Household salary", "salary"), note: `Split ${basis.earners.map((e) => `${e.name} ${pct(e.share, 1)}`).join(", ")} as their base pay; ${basis.year} law, filing jointly, ${basis.dependents.length} dependent${basis.dependents.length === 1 ? "" : "s"}.` };
  let lines: ChainLine[];
  if (which === "income-tax") {
    lines = [
      { label: "Federal income tax", value: { cents: base.federal }, source: "law" },
      { op: "+", label: "Connecticut income tax", value: { cents: base.ct }, source: "law" },
      { op: "+", label: "Social Security", value: { cents: base.socialSecurity }, source: "law" },
      { op: "+", label: "Medicare", value: { cents: base.medicare }, source: "law" },
      { op: "+", label: "CT paid leave", value: { cents: base.pfml }, source: "law" },
      { op: "=", label: "Tax on the salary", value: { cents: base.total }, source: "derived" },
      { ...salaryLine, op: "÷" },
      { op: "=", label: word, value: { ratio: used }, source: "derived", note: "Wages only: no 401(k), HSA or benefit deductions, so it errs a little high." },
    ];
  } else {
    const g = Math.max(50_000, L.tax.gains.gain);
    const withGain = taxOnPay(params, people, basis.dependents, Math.round(g * 100));
    const extra = withGain.federal + withGain.ct - base.federal - base.ct;
    lines = [
      salaryLine,
      { label: L.tax.gains.gain < 50_000 ? "Gain priced (at least $50,000)" : "Gain", value: { cents: Math.round(g * 100) }, source: "derived", note: "Growth in taxable investments since their first statements, plus what the forecast earns by the buy month (the Cash for the home proof)." },
      { label: "Federal + CT income tax with the gain", value: { cents: withGain.federal + withGain.ct }, source: "law" },
      { op: "−", label: "Federal + CT income tax without it", value: { cents: base.federal + base.ct }, source: "law" },
      { op: "=", label: "Tax the gain adds", value: { cents: extra }, source: "derived", note: "Federal 15/20%, the 3.8% NIIT and Connecticut, where the gain lands." },
      { op: "÷", label: "Gain", value: { cents: Math.round(g * 100) }, source: "derived" },
      { op: "=", label: word, value: { ratio: used }, source: "derived" },
    ];
  }
  return { describes: `${word}, from the tax engine`, figure: { ratio: used }, selfCheck: null, blocks: [{ kind: "chain", title: word, lines }], estimates: [], through: c.fb.asOf };
}

/** The most a home can cost: the loan the limit's monthly room pays for, plus the cash put in, less closing and renovation. */
function maxBlocks(c: HomeCtx, ins: HomeBudgetInputs, max: MaxApprovalResult, income: ChainLine, cap: ChainLine, lender: boolean): { blocks: ProofBlock[]; figureC: number } {
  const priceC = cents(max.impliedMaxHomeValue);
  const loanC = cents(max.impliedMaxLoan);
  const downC = priceC - loanC;
  const cashC = cents(ins.cashForHome);
  const closingC = cents(ins.closingCostsPctOfHomePrice * max.impliedMaxHomeValue);
  const renoC = cashC - closingC - downC;
  const other = max.monthlyInsurance + max.monthlyPropertyTax + max.monthlyMaintenance + max.monthlyMortgageInsurance + ins.hoaMonthly + ins.utilitiesMonthly;
  const room: ChainLine[] = [
    income,
    { op: "÷", label: "Months", value: { text: "12" }, source: "derived" },
    cap,
    { op: "=", label: "Housing a month at the limit", value: { cents: cents(max.maxHousingBudgetMonthly) }, source: "derived" },
    { op: "−", label: `Property tax (${pct(ins.annualPropertyTaxRate)} of the price a year)`, value: { cents: cents(max.monthlyPropertyTax) }, source: "assumption" },
    { op: "−", label: `Insurance (${pct(ins.annualInsuranceRateOnValue)})`, value: { cents: cents(max.monthlyInsurance) }, source: "assumption" },
  ];
  if (!lender) room.push({ op: "−", label: `Maintenance (${pct(ins.annualMaintenanceRate)})`, value: { cents: cents(max.monthlyMaintenance) }, source: "assumption" }, { op: "−", label: "Utilities", value: { cents: cents(ins.utilitiesMonthly) }, source: "assumption" });
  if (ins.hoaMonthly) room.push({ op: "−", label: "HOA", value: { cents: cents(ins.hoaMonthly) }, source: "assumption" });
  if (max.monthlyMortgageInsurance) room.push({ op: "−", label: "Mortgage insurance", value: { cents: cents(max.monthlyMortgageInsurance) }, source: "assumption" });
  // Each cost rounded to the cent; the payment is what they leave (the solver's, to within a cent).
  const paymentC = room.slice(4).reduce((t, l) => t - ("cents" in l.value ? l.value.cents : 0), cents(max.maxHousingBudgetMonthly));
  room.push({ op: "=", label: "Left for the mortgage payment", value: { cents: paymentC }, source: "derived", note: `Housing ${money(cents(max.maxHousingBudgetMonthly))} less ${money(cents(other))} of other costs at the max price.` });
  const pay1 = monthlyPaymentOnLoan(1, ins.annualMortgageRate, ins.mortgageTermYears);
  return {
    figureC: priceC,
    blocks: [
      { kind: "chain", title: "The monthly room", lines: room },
      {
        kind: "chain",
        title: "The loan it pays for",
        lines: [
          { label: "Mortgage payment", value: { cents: paymentC }, source: "derived", note: `The solver lands on ${money(cents(max.monthlyMortgagePayment))}; the costs above are each rounded to the cent.` },
          { op: "÷", label: `Payment per $1 borrowed (${pct(ins.annualMortgageRate, 3)}, ${ins.mortgageTermYears} years)`, value: { text: pay1.toFixed(6) }, source: "assumption" },
          { op: "=", label: "Loan", value: { cents: loanC }, source: "derived" },
        ],
      },
      {
        kind: "chain",
        title: "The price",
        lines: [
          { label: "Cash for the home", value: { cents: cashC }, source: c.L.linked ? "derived" : "assumption", link: homeLink(c, "Cash for the home", "cash") },
          { op: "−", label: `Closing costs (${pct(ins.closingCostsPctOfHomePrice)} of the price)`, value: { cents: closingC }, source: "assumption" },
          { op: "−", label: `Renovation (${pct(ins.renovationPctOfHomePrice)} of the price)`, value: { cents: renoC }, source: "assumption" },
          { op: "=", label: "Down payment", value: { cents: downC }, source: "derived" },
          { op: "+", label: "Loan", value: { cents: loanC }, source: "derived" },
          { op: "=", label: lender ? "Lender max" : "Most you can afford", value: { cents: priceC }, source: "derived", note: "The page shows it rounded down to $1,000." },
        ],
        note: "Every dollar of the cash goes in; the price is solved so the loan and down payment fit together.",
      },
    ],
  };
}

function homeMaxProof(c: HomeCtx, lender: boolean): Built {
  const { L } = c;
  const ins = L.ins;
  const max = lender ? computeLenderMax(ins, L.lender.income) : computeMaxApproval(ins);
  const income: ChainLine = lender
    ? { label: "Income a lender counts a year", value: { cents: cents(L.lender.income) }, source: "derived", link: homeLink(c, "Lender income", "lender-income") }
    : { label: "Household salary a year", value: { cents: cents(ins.annualHouseholdSalary) }, source: L.buy.salaryLinked ? "derived" : "assumption", link: homeLink(c, "Household salary", "salary") };
  const cap: ChainLine = { op: "×", label: lender ? "Lender's limit (% of gross)" : "Your housing limit (% of gross)", value: { ratio: lender ? ins.lenderMaxDti : ins.housingCostMaxOfGross }, source: "assumption" };
  const m = maxBlocks(c, ins, max, income, cap, lender);
  const { checks, withheld } = homeChecks(c);
  const loanC = cents(max.impliedMaxLoan);
  return {
    describes: lender ? "Lender view: the most a lender would likely approve" : "You can afford up to",
    figure: { cents: m.figureC },
    selfCheck: sumCheck(m.figureC, loanC + (m.figureC - loanC), `The loan and down payment add up to ${money(m.figureC)}`),
    blocks: m.blocks,
    checks,
    withheld: withheld || (L.linked && c.fb.blockers.length > 0),
    estimates: L.buy.key && c.b ? [projectionEstimate(c.b)] : [],
    through: c.fb.asOf,
  };
}

/** Housing a month at the most you can afford: the limit's share of gross pay, cost by cost at that price (as the page's headline). */
function homeMonthlyProof(c: HomeCtx): Built {
  const { L } = c;
  const ins = L.ins;
  const max = computeMaxApproval(ins);
  const at = computeBudgetScenario({ ...ins, budgetHomePrice: max.impliedMaxHomeValue, budgetDownPaymentPct: max.downPaymentPctOfHome });
  const totalC = cents(at.monthlyTotalHousing);
  const parts: [string, number][] = [
    ["Mortgage (principal and interest)", at.monthlyMortgagePayment],
    ["Property tax", at.monthlyPropertyTax],
    ["Insurance", at.monthlyInsurance],
    ["Maintenance", at.monthlyMaintenance],
    ["Utilities", at.monthlyUtilities],
    ["HOA", at.monthlyHoa],
    ["Mortgage insurance", at.monthlyMortgageInsurance],
  ];
  const lines: ChainLine[] = parts.filter(([, v]) => v).map(([label, v], i) => ({ ...(i ? { op: "+" as const } : {}), label, value: { cents: cents(v) }, source: "derived" as const }));
  // Each cost rounded to the cent; the mortgage line takes the rounding so the lines re-add to the total.
  const rest = lines.slice(1).reduce((t, l) => t + ("cents" in l.value ? l.value.cents : 0), 0);
  if (lines[0]) lines[0] = { ...lines[0], value: { cents: totalC - rest } };
  lines.push({ op: "=", label: "Housing a month, all-in", value: { cents: totalC }, source: "derived" });
  const { checks, withheld } = homeChecks(c);
  return {
    describes: "Housing a month at the most you can afford",
    figure: { cents: totalC },
    selfCheck: null,
    blocks: [
      { kind: "chain", title: "At the most you can afford, every month", lines, note: "The price is solved so this is your housing limit's share of gross pay." },
      { kind: "chain", title: "The limit it fills", lines: [{ label: "Household salary a year", value: { cents: cents(ins.annualHouseholdSalary) }, source: L.buy.salaryLinked ? "derived" : "assumption", link: homeLink(c, "Household salary", "salary") }, { op: "÷", label: "Months", value: { text: "12" }, source: "derived" }, { op: "×", label: "Your housing limit (% of gross)", value: { ratio: ins.housingCostMaxOfGross }, source: "assumption" }, { op: "=", label: "Housing a month at the limit", value: { cents: cents(max.maxHousingBudgetMonthly) }, source: "derived" }] },
    ],
    checks,
    withheld: withheld || (L.linked && c.fb.blockers.length > 0),
    estimates: L.buy.key && c.b ? [projectionEstimate(c.b)] : [],
    through: c.fb.asOf,
  };
}

/** Salary after income tax, a year: what the headline's share of take-home divides by. */
function homeTakeHomeProof(c: HomeCtx): Built {
  const ins = c.L.ins;
  const salaryC = cents(ins.annualHouseholdSalary);
  const takeHomeC = cents(ins.annualHouseholdSalary * (1 - ins.incomeTaxRate));
  return {
    describes: "Household salary after income tax, a year",
    figure: { cents: takeHomeC },
    selfCheck: null,
    blocks: [
      {
        kind: "chain",
        title: "Take-home",
        lines: [
          { label: "Household salary", value: { cents: salaryC }, source: c.L.buy.salaryLinked ? "derived" : "assumption", link: homeLink(c, "Household salary", "salary") },
          { op: "×", label: "1 − income tax (federal, Connecticut and payroll)", value: { ratio: 1 - ins.incomeTaxRate }, source: c.L.tax.income.linked ? "derived" : "assumption", link: homeLink(c, "Income tax rate", "income-tax") },
          { op: "=", label: "Take-home a year", value: { cents: takeHomeC }, source: "derived" },
        ],
      },
    ],
    estimates: [],
    through: c.fb.asOf,
  };
}

/** The long-term gain the engine's capital-gains rate is priced on (at least $50,000): the taxable investments' growth, as the Cash for the home proof works it out. */
function homeGainProof(c: HomeCtx): Built {
  const g = c.L.tax.gains.gain;
  const priced = cents(Math.max(50_000, g));
  return {
    describes: "The gain the capital-gains tax rate is priced on",
    figure: { cents: priced },
    selfCheck: null,
    blocks: [
      {
        kind: "chain",
        title: "Gain",
        lines: [
          { label: "Growth in taxable investments since their first statements, plus what the forecast earns by the buy month", value: { cents: cents(g) }, source: "derived", link: homeLink(c, "Cash for the home", "cash") },
          ...(g < 50_000 ? [{ label: "Priced at least at", value: { cents: 5_000_000 }, source: "assumption" as const, note: "Too small a gain would price the rate on a sliver of a bracket." }] : []),
        ],
      },
    ],
    estimates: [],
    through: c.fb.asOf,
  };
}

/** Today's typical month of spending outside housing (book/reports/homeFunds.ts buildHomeSpending): the real-spend check beside what a price leaves. */
function homeSpendingProof(c: HomeCtx): Built {
  const s = c.fb.spending;
  if (!s) return notFound("No proven month of spending yet.");
  const { checks, withheld } = checksFor(c.book, { affects: "CASH_FLOW", from: s.from, to: s.to }, CASH_FLOW_CHECKS);
  return {
    describes: "Today's typical month of spending, housing and utilities left out",
    figure: { cents: s.monthlyCents },
    selfCheck: null,
    blocks: [
      {
        kind: "chain",
        title: `The typical month, ${s.from} to ${s.to}`,
        lines: [
          { label: "Typical month of living cost, one-offs out", value: { cents: s.monthlyCents + s.housingMonthlyCents }, source: "proven" },
          { op: "−", label: "Housing and utilities (the home's all-in cost takes their place)", value: { cents: s.housingMonthlyCents }, source: "proven" },
          { op: "=", label: "Outside housing", value: { cents: s.monthlyCents }, source: "derived" },
        ],
        note: `The last ${s.months} months, as Goals and the forecast read living cost.`,
      },
    ],
    checks,
    withheld,
    estimates: [],
    through: s.to,
  };
}

function lenderIncomeProof(c: HomeCtx): Built {
  const { L } = c;
  const salary: ChainLine = { label: "Household salary", value: { cents: cents(L.ins.annualHouseholdSalary) }, source: L.buy.salaryLinked ? "derived" : "assumption", link: homeLink(c, "Household salary", "salary") };
  const lines: ChainLine[] = [salary];
  const blocks: ProofBlock[] = [];
  if (L.lender.countBonus && L.lender.bonus && c.b) {
    const annual = cents(L.lender.bonus.annual);
    const people = c.b.seeds.people.map((p) => ({ p, last: p.bonusHistory.filter((h) => !h.partial).slice(-2) })).filter((x) => x.last.length);
    blocks.push({
      kind: "breakdown",
      title: "Bonuses in the last complete years",
      items: people.flatMap(({ p, last }) =>
        last.map((h) => ({ label: `${p.name}, ${h.year}`, value: { cents: h.bonus }, link: { label: `${p.name}'s ${h.year} bonus`, descriptor: { report: "pay", basis: "ytd", personId: p.personId, year: h.year, lines: ["bonus"] } satisfies PayDescriptor } })),
      ),
    });
    let given = 0;
    people.forEach(({ p, last }, i) => {
      const v = i === people.length - 1 ? annual - given : Math.round(last.reduce((t, h) => t + h.bonus, 0) / last.length);
      given += v;
      lines.push({ op: "+", label: `${p.name}: average of ${last.map((h) => h.year).join(" and ")}`, value: { cents: v }, source: "derived" });
    });
  } else lines.push({ op: "+", label: L.lender.bonus ? "Bonus (left out: base only)" : "Bonus (no bonus history)", value: { cents: 0 }, source: L.lender.bonus ? "assumption" : "derived" });
  lines.push({ op: "=", label: "Income the lender counts", value: { cents: cents(L.lender.income) }, source: "derived" });
  return {
    describes: "Income the lender view counts",
    figure: { cents: cents(L.lender.income) },
    selfCheck: null,
    blocks: [{ kind: "chain", title: "Lender income", lines, note: "Lenders average each earner's cash bonuses over the last two complete years." }, ...blocks],
    estimates: [],
    through: c.fb.asOf,
  };
}

const RVB_WORDS: Record<RentVsBuyFigure, string> = {
  "rvb-ahead": "Rent vs buy: how far ahead buying is if you sell in the year you'd sell",
  "rvb-break-even": `Rent vs buy: the first year from which buying stays ahead (within ${SIM_YEARS} years)`,
  "rvb-owning": "Rent vs buy: what owning costs a month in year one, unrecoverable",
  "rvb-rent": "Rent vs buy: rent a month",
};

/** Rent vs buy, re-run on the server as the tab runs it: the linked inputs, the same budget scenario, ownership cost and simulation. */
function rentVsBuyProof(c: HomeCtx, figure: RentVsBuyFigure): Built {
  const ins = c.L.ins;
  const r = rentVsBuyFigures(ins);
  const v = r.values[figure];
  const figureV: ProofValue = typeof v === "string" ? { text: v } : { cents: cents(v) };
  const at = r.sim.years[r.horizon - 1]!;
  const lines: ChainLine[] =
    figure === "rvb-ahead"
      ? [
          { label: `Buyer's net worth after selling, year ${r.horizon}`, value: { cents: cents(at.buyerWealth) }, source: "estimate", note: "Home sold (selling costs, tax on the gain past the exclusion), investments sold (tax on gains)." },
          { label: `Renter's net worth, year ${r.horizon}`, value: { cents: cents(at.renterWealth) }, source: "estimate", note: "The same cash on day one and the same monthly budget, the difference invested." },
          { label: "Ahead by buying", value: figureV, source: "derived" },
        ]
      : figure === "rvb-break-even"
        ? [
            { label: "Break-even", value: figureV, source: "derived", note: "The first year-end from which buying stays ahead through the whole run." },
            ...r.sim.years.filter((y) => y.year <= 5 || y.year % 5 === 0).map((y): ChainLine => ({ label: `Buying minus renting, year ${y.year}`, value: { cents: cents(y.buyAdvantage) }, source: "estimate" })),
          ]
        : figure === "rvb-owning"
          ? [
              ...r.snap.components.map((x): ChainLine => ({ label: x.label, value: { cents: cents(x.monthly) }, source: "derived" })),
              { label: "Owning a month", value: figureV, source: "derived", note: `${pct(r.snap.totalCostOfHomeOwnershipAnnualPct)} of the home's value a year.` },
            ]
          : [typed("Rent a month", figureV)];
  const { checks, withheld } = homeChecks(c);
  return {
    describes: RVB_WORDS[figure],
    figure: figureV,
    selfCheck: null,
    rederived: rederiveRentVsBuy(figure, figureV, r),
    blocks: [
      { kind: "chain", title: "Rent vs buy", lines },
      {
        kind: "chain",
        title: "What it runs on",
        lines: [
          { label: "Home price", value: { cents: cents(r.b.homePrice) }, source: "assumption", note: "From the Test a price tab." },
          { label: "Cash in on day one (down payment, closing, renovation)", value: { cents: cents(r.sim.upfrontCash) }, source: "derived" },
          typed("Rent a month", { cents: cents(ins.marketRentMonthly) }),
          typed("Rent increase a year", { ratio: ins.rentGrowthRate }),
          typed("Home appreciation a year", { ratio: ins.homeAppreciationRate }),
          { label: "Investment return a year", value: { ratio: ins.investmentReturnRate }, source: c.L.returns.linked ? "derived" : "assumption", ...(c.L.returns.linked ? { note: "The Forecast's return." } : {}) },
          typed("Selling costs", { ratio: ins.sellingCostsPct }),
          typed("Years until you'd sell", { text: String(r.horizon) }),
        ],
      },
    ],
    checks,
    withheld,
    estimates: [{ id: "planning.rent-vs-buy", title: "A model of owning and renting", detail: "Both households are run month by month on the inputs; nothing here is read off a statement." }],
    through: c.fb.asOf,
  };
}

export function buildHome(c: HomeCtx): Built {
  switch (c.d.figure) {
    case "rvb-ahead":
    case "rvb-break-even":
    case "rvb-owning":
    case "rvb-rent":
      return rentVsBuyProof(c, c.d.figure);
    case "cash":
      return homeCashProof(c);
    case "salary":
      return homeSalaryProof(c);
    case "income-tax":
    case "gains-tax":
      return homeTaxProof(c, c.d.figure);
    case "max-price":
      return homeMaxProof(c, false);
    case "lender-max":
      return homeMaxProof(c, true);
    case "lender-income":
      return lenderIncomeProof(c);
    case "max-monthly":
      return homeMonthlyProof(c);
    case "take-home":
      return homeTakeHomeProof(c);
    case "spending":
      return homeSpendingProof(c);
    case "gain":
      return homeGainProof(c);
  }
}

