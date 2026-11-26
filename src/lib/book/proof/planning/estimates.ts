import { taxLink } from "../../../forecast/forecast.ts";
import { loadForecastData } from "../../../forecast/load.ts";
import { employerKey } from "../../../ingest/payroll/types.ts";
import { type MortgageFigure, mortgageFigures } from "../../../mortgage/figures.ts";
import { LINKED_KEYS, toPlan, withLinks } from "../../../mortgage/inputs.ts";
import { buildMortgageLinks } from "../../../mortgage/links.ts";
import { comparePrepayVsInvest } from "../../../mortgage/prepayVsInvest.ts";
import { estimateFigures, yearEstimate } from "../../../profile/yearEstimate.ts";
import { buildTaxReport, type PersonReport } from "../../../tax/buildTaxReport.ts";
import { TAX_YEARS } from "../../../tax/params.ts";
import type { Book } from "../../load.ts";
import { rederiveEstimate, rederiveMortgage } from "../../rederive/planning.ts";
import type { BonusesDescriptor } from "../bonusesProof.ts";
import { checksFor, perBook, sumCheck } from "../common.ts";
import { PAY_CHECKS, type PayDescriptor } from "../payProof.ts";
import type { PlanningDescriptor } from "../planningProof.ts";
import type { TaxEstimateDescriptor } from "../taxEstimateProof.ts";
import type { ChainLine, ProofCheck, ProofContext, ProofLink, ProofValue } from "../types.ts";
import { type Base, baseFrom, type Built, driversBlock, forecastChecks, money, monthWord, notFound, projectionEstimate, seedLink, signed, withheldProof } from "./shared.ts";

/** The annual estimate, Mortgage and Taxes figures the forecast feeds (planningProof.ts). */

const ESTIMATE_WORDS: Record<string, string> = {
  salary: "Salary",
  bonus: "Bonus",
  "other-income": "Investment & other income (year to date only)",
  gross: "Gross income",
  "taxes-deductions": "Total taxes & deductions",
  employer: "Employer retirement & HSA",
  "partner-kept": "A partner's pay kept in their own accounts",
  "net-cash": "Net cash",
  living: "Living expenses",
  "one-offs": "One-off expenses",
  saved: "Saved incl. retirement",
  "to-retirement": "Of which to retirement accounts",
  "savings-of-gross": "Savings % of gross",
  "net-worth": "Net worth on Dec 31",
  liquid: "Liquid on Dec 31",
  illiquid: "Illiquid on Dec 31",
  "change-pct": "Change in net worth (%)",
  change: "Change in net worth",
};

/** One line of the annual statement's estimate column, worked out as the page works it out: the year to date plus the forecast's rest of the year, on the saved drivers. */
export async function buildAnnualEstimate(ctx: ProofContext, d: Extract<PlanningDescriptor, { page: "annual-estimate" }>): Promise<{ built: Built; b: Base | null }> {
  const data = await perBook(ctx, "forecast-data", () => loadForecastData(ctx.db, ctx.book));
  const b = baseFrom(ctx.book, data);
  const e = yearEstimate(data);
  if (!e || !b) return { built: data.profile.seeds ? notFound("No whole-year estimate: no year to date, or the forecast has no rest of the year.") : withheldProof(ctx.book, data), b };
  const value = estimateFigures(e)[d.line];
  if (!value) return { built: notFound(`The estimate column shows no "${d.line}".`), b };
  const word = d.line.startsWith("bridge:") ? `What moved net worth: ${d.line.slice(7)}` : d.line.startsWith("age:") ? "Age" : (ESTIMATE_WORDS[d.line] ?? d.line);
  const { checks, withheld } = forecastChecks(b);
  return {
    b,
    built: {
      describes: `${e.year} est. (annual statement): ${word}`,
      figure: value,
      selfCheck: null,
      rederived: rederiveEstimate(d.line, value, e, estimateFigures(e)),
      blocks: [
        {
          kind: "chain",
          title: `${e.year}, whole year`,
          lines: [
            { label: word, value, source: "estimate", note: `Actual through ${e.ytd.asOf} (the year to date on the annual statement), then the forecast for ${e.restFrom}–Dec.` },
            ...(e.flows.close ? [{ label: "Net worth on Dec 31 (est.)", value: { cents: e.flows.close.netWorth }, source: "estimate" as const }] : []),
          ],
        },
        driversBlock(b),
      ],
      checks,
      withheld,
      estimates: [projectionEstimate(b)],
      through: b.seeds.start.asOf,
    },
  };
}

// --------------------------------------------------------------------------- Mortgage

const MORTGAGE_WORDS: Record<MortgageFigure, string> = {
  advantage: "Investing the extra minus paying the loan down: net worth at the horizon",
  "break-even": "The investment return above which investing wins",
  chance: "Share of simulated markets in which investing ends ahead",
  "interest-saved": "Interest paying down saves by the horizon",
};

const LINK_WORDS: Record<(typeof LINKED_KEYS)[number], string> = { investReturn: "Investment return", inflation: "Inflation", fedMarginalRate: "Federal marginal rate", standardDeduction: "Standard deduction", stateIncomeTax: "State income tax" };

/** The Mortgage page's figures, re-run on the server: the inputs as the page carries them, the links put in as api/mortgage/links has them, the same comparison and seeded simulation. */
export async function buildMortgage(ctx: ProofContext, d: Extract<PlanningDescriptor, { page: "mortgage" }>): Promise<Built> {
  const { links } = await perBook(ctx, "mortgage-links", () => buildMortgageLinks(ctx.db, ctx.book));
  const eff = withLinks(d.inputs, links);
  const m = mortgageFigures(eff);
  const v = m.values[d.figure];
  const value: ProofValue | null = "cents" in v ? (v.cents == null ? null : { cents: v.cents }) : v.ratio == null ? null : { ratio: v.ratio };
  if (!value) return notFound(m.hasChoice ? "The simulation doesn't reach the horizon." : "Nothing to compare: no extra monthly amount and no lump sum within the horizon.");
  const usd = (dollars: number): ProofValue => ({ cents: Math.round(dollars * 100) });
  const H = m.horizon;
  const unit = eff.realDollars ? "in today's dollars" : "in future dollars";
  const inputs: ChainLine[] = [
    { label: "Loan", value: usd(eff.principal), source: "assumption" },
    { label: "Rate", value: { ratio: eff.rate }, source: "assumption" },
    { label: "Term (years)", value: { text: String(eff.termYears) }, source: "assumption" },
    { label: "Extra each month", value: usd(eff.extraMonthly), source: "assumption" },
    { label: "Lump sums", value: { text: String(eff.lumps.length) }, source: "assumption" },
    { label: "Horizon (years)", value: { text: String(eff.horizonYears) }, source: "assumption" },
    { label: "Yearly swings (simulation)", value: { ratio: eff.volatility }, source: "assumption" },
    { label: "Dividend yield", value: { ratio: eff.dividendYield }, source: "assumption" },
    { label: "Tax on gains (federal + state)", value: { ratio: eff.fedGainsRate + eff.ctGainsRate }, source: "assumption" },
    ...LINKED_KEYS.map((k): ChainLine => {
      const l = links[k];
      const linked = !!l && !d.inputs.typed?.[k];
      const val = k === "standardDeduction" || k === "stateIncomeTax" ? usd(eff[k]) : { ratio: eff[k] };
      return { label: LINK_WORDS[k], value: val, source: linked ? "derived" : "assumption", note: linked ? `From ${l!.from}.` : "Typed on the page." };
    }),
  ];
  const result: ChainLine[] =
    d.figure === "advantage"
      ? [
          { label: `Net worth investing the extra, month ${H}`, value: usd(m.cmp.invest.netWorth[H]! / m.defl(H)), source: "estimate" },
          { label: `Net worth paying the loan down, month ${H}`, value: usd(m.cmp.prepay.netWorth[H]! / m.defl(H)), source: "estimate" },
          { label: `Difference, ${unit}`, value, source: "derived" },
        ]
      : d.figure === "interest-saved"
        ? [
            { label: "Interest investing the extra", value: usd(m.interest.invest), source: "estimate" },
            { label: "Interest paying the loan down", value: usd(m.interest.prepay), source: "estimate" },
            { label: `Saved, ${unit}`, value, source: "derived" },
          ]
        : d.figure === "break-even"
          ? [{ label: "Return at which both paths end level at the horizon", value, source: "derived", note: "Found by bisection between −5% and 25%." }]
          : [
              { label: "Simulated markets", value: { text: String(m.mc.paths) }, source: "derived", note: "Monthly returns around the expected return at the yearly swings typed; one fixed seed, so the same markets every time." },
              { label: "Investing ends ahead in", value, source: "estimate" },
            ];
  return {
    describes: `Mortgage: ${MORTGAGE_WORDS[d.figure]}`,
    figure: value,
    selfCheck: null,
    rederived: rederiveMortgage(d.figure, value, eff, m, (rr) => comparePrepayVsInvest(toPlan({ ...eff, investReturn: rr })).advantage),
    blocks: [
      { kind: "chain", title: "The comparison", lines: result },
      { kind: "chain", title: "What it runs on", lines: inputs, note: "The Mortgage page's inputs as saved; a linked figure is used unless one is typed over it." },
    ],
    estimates: [{ id: "planning.mortgage", title: "A model of the loan and the market", detail: "Both paths are projected month by month on the inputs; nothing here is read off a statement." }],
    through: ctx.book.horizon.netWorth,
  };
}

// --------------------------------------------------------------------------- Taxes

export async function buildTaxes(ctx: ProofContext, d: Extract<PlanningDescriptor, { page: "taxes" }>): Promise<Built> {
  // As api/tax: the year in progress follows the shared forecast.
  const data = await perBook(ctx, "forecast-data", () => loadForecastData(ctx.db, ctx.book));
  const b = baseFrom(ctx.book, data);
  if (!TAX_YEARS[d.year]) return notFound(`No ${d.year} tax law in the app.`);
  const r = buildTaxReport(ctx.book, d.year, { forecast: b ? taxLink(b.f) : null });
  if (r.blocked) return notFound(`${d.year} taxes are withheld.`);
  const p = r.people.find((x) => x.id === d.personId);
  if (!p) return notFound(`No one in the household has the id ${d.personId}.`);
  const e = p.payroll.find((x) => x.active);
  const lastStub = e?.latestPayDate ?? null;
  const { checks, withheld } = checksFor(ctx.book, { affects: "PAY", from: `${d.year}-01-01`, to: lastStub ?? `${d.year}-12-31`, personId: p.id }, PAY_CHECKS);
  const fc = p.fromForecast;
  const estLine: ProofLink = { label: `Where it lands on the ${d.year} estimate`, descriptor: { report: "tax-estimate", year: d.year, basis: "projected", key: d.figure === "bonus-expected" ? "pay.bonus" : "pay.salary" } satisfies TaxEstimateDescriptor };
  if (d.figure === "bonus-expected") {
    if (!fc) return notFound(`${d.year} isn't the year in progress: no bonus is expected from the forecast.`);
    const lines: ChainLine[] = fc.items.map((i, k) => ({
      op: k ? ("+" as const) : undefined,
      label: `${i.label}${i.key ? `, ${monthWord(i.key)}` : ""}`,
      value: { cents: i.gross },
      source: i.source === "ESTIMATE" ? ("estimate" as const) : ("proven" as const),
      note: i.source === "LETTER" ? "Amount and date read off the award letter." : i.source === "PAID" ? `Paid on the ${i.date} stub.` : "The forecast's estimate: a share of base salary on the usual pattern.",
      link:
        i.source === "LETTER" && i.window
          ? { label: i.label, descriptor: { report: "bonuses", figure: "window", window: i.window, measure: "scheduled" } satisfies BonusesDescriptor }
          : i.source === "PAID" && i.date
            ? { label: `${i.date} bonus`, descriptor: { report: "pay", basis: "paid", personId: p.id, lines: ["bonus"], start: i.date, end: i.date } satisfies PayDescriptor }
            : seedLink("The forecast's bonuses", { report: "forecast", figure: "seed", which: "bonus" }),
    }));
    if (!lines.length) lines.push({ label: "None after the latest stub", value: { cents: 0 }, source: "derived" });
    lines.push({ op: "=", label: "Bonus still expected", value: { cents: fc.bonus }, source: "derived" });
    const parts = fc.items.reduce((t, i) => t + i.gross, 0);
    return {
      describes: `${p.name}: bonus still expected in ${d.year}, from the forecast`,
      figure: { cents: fc.bonus },
      selfCheck: sumCheck(fc.bonus, parts, `The forecast's ${fc.items.length} bonus${fc.items.length === 1 ? "" : "es"} after the latest stub add up to ${money(parts)}`),
      blocks: [
        { kind: "chain", title: `Paid after ${lastStub ?? "the latest stub"}`, lines, note: "The forecast's bonuses dated after the latest pay stub this estimate counts.", },
        { kind: "breakdown", title: "On the estimate", items: [{ label: "Gross bonus for the year", value: { text: "projected" }, link: estLine }] },
      ],
      checks,
      withheld,
      estimates: fc.items.some((i) => i.source === "ESTIMATE") ? [{ id: "planning.bonus-estimates", title: "Bonuses no stub or letter shows yet", detail: "A share of base salary, paid on the latest letter's pattern (or the usual bonus month)." }] : [],
      through: lastStub ?? r.today,
    };
  }
  if (!e) return notFound(`${p.name} has no ${d.year} pay stubs.`);
  return projectedGross(ctx.book, d.year, p, e, estLine, checks, withheld);
}

function projectedGross(book: Book, year: number, p: PersonReport, e: PersonReport["payroll"][number], estLine: ProofLink, checks: ProofCheck[], withheld: boolean): Built {
  const n = e.remainingPayDates.length;
  const check = e.regularPaycheck?.gross ?? 0;
  const fromForecast = p.fromForecast?.bonus ?? 0;
  const typedExtra = e.extraBonus - fromForecast;
  const lines: ChainLine[] = [
    {
      label: `Gross pay year to date, ${e.latestPayDate} stub`,
      value: { cents: e.ytd.gross },
      source: "proven",
      link: { label: `${e.employer}, ${year} to date`, descriptor: { report: "pay", basis: "ytd", personId: p.id, employerKeys: [employerKey(e.employer)], year, through: e.latestPayDate, lines: ["gross"] } satisfies PayDescriptor },
    },
  ];
  if (n)
    lines.push({
      op: "+",
      label: `${n} more paychecks × ${money(check)} gross (the ${e.basis === "TYPICAL" ? "typical recent" : "latest"} regular check)`,
      value: { cents: check * n },
      source: "estimate",
      note: `Pay dates ${e.remainingPayDates[0]} – ${e.remainingPayDates.at(-1)}${e.payThrough ? `, ending ${e.payThrough}` : ""}.`,
      ...(p.fromForecast ? { link: seedLink(`${p.name}'s paycheck`, { report: "forecast", figure: "seed", which: "pay", personId: p.id, paycheck: e.basis }) } : {}),
    });
  if (fromForecast && e.extraBonus) lines.push({ op: "+", label: "Bonus still expected (the forecast)", value: { cents: fromForecast }, source: "derived", link: { label: "Bonus still expected", descriptor: { report: "planning", page: "taxes", figure: "bonus-expected", year, personId: p.id } } });
  if (typedExtra) lines.push(signed(typedExtra, { label: "Extra bonus typed under Inputs", source: "assumption" }));
  lines.push({ op: "=", label: `Projected gross pay for ${year}`, value: { cents: e.projected.gross }, source: "derived" });
  const parts = e.ytd.gross + check * n + e.extraBonus;
  return {
    describes: `${p.name} · ${e.employer}: gross pay projected to Dec 31, ${year}`,
    figure: { cents: e.projected.gross },
    selfCheck: sumCheck(e.projected.gross, parts, `Year to date, the paychecks left and the bonus add up to ${money(parts)}`),
    blocks: [{ kind: "chain", title: "Gross pay to Dec 31", lines, note: p.fromForecast ? "The paycheck basis and bonuses come from the shared forecast (Forecast page)." : undefined }, { kind: "breakdown", title: "On the estimate", items: [{ label: "Gross salary for the year", value: { text: "projected" }, link: estLine }] }],
    checks,
    withheld,
    estimates: n ? [{ id: `planning.paychecks:${p.id}`, title: `${n} paychecks after ${e.latestPayDate}`, detail: "The chosen regular check repeated for each pay date left in the year." }] : [],
    through: e.latestPayDate,
  };
}

