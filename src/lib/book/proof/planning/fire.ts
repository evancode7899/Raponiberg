import { analyzeFire, drawFor, extended, FAT_SHARE, type FireAnalysis, fireNumber, firePlans, firstYearIncome, LEAN_SHARE, livingIn, stressTest, type StressTest } from "../../../fire/fire.ts";
import { type AccessFigure, accessFigures, longTermCells, longTermTable, type LongTermTable, planValue, STRESS_PATHS, type StressFigure, stressFigures } from "../../../fire/longTerm.ts";
import { milestones as netWorthMilestones } from "../../../forecast/forecast.ts";
import type { ForecastData } from "../../../forecast/load.ts";
import { type Outlook, type OutlookPlan, projectOutlook, retirementTax, type WalkAwayRow, walkAwayTable } from "../../../profile/outlook.ts";
import type { Book } from "../../load.ts";
import { ledgerNetWorthAt } from "../../rederive/netWorth.ts";
import { rederiveAccess, rederivePlanCell, rederiveStress } from "../../rederive/planning.ts";
import { sumCheck } from "../common.ts";
import type { LedgerLine } from "../forecastProof.ts";
import type { FireFigure, FireSettings, PlanningDescriptor } from "../planningProof.ts";
import type { ChainLine, ProofBlock, ProofLink, ProofValue } from "../types.ts";
import { type Base, baseFrom, type Built, driversBlock, forecastChecks, livingLine, money, monthWord, notFound, pct, projected, projectionEstimate, seedLink, START, startLine, yearCell } from "./shared.ts";

/** The FIRE page's figures (planningProof.ts): FIRE numbers, FI years, coast, savings rate, milestones, the long-term plan, access and the stress test. */

type FireCtx = Base & { plans: ReturnType<typeof firePlans>; fa: FireAnalysis; fire: FireSettings };

/** FIRE contexts already worked out, per forecast data (itself once per Book) and settings: the long-term table alone is ~400 figures, each its own proof. */
const fireCtxs = new WeakMap<ForecastData, Map<string, FireCtx | null>>();

export function fireCtx(book: Book, data: ForecastData, fire?: FireSettings): FireCtx | null {
  let byKey = fireCtxs.get(data);
  if (!byKey) fireCtxs.set(data, (byKey = new Map()));
  const key = JSON.stringify(fire ?? null);
  if (!byKey.has(key)) byKey.set(key, makeFireCtx(book, data, fire));
  return byKey.get(key)!;
}

function makeFireCtx(book: Book, data: ForecastData, fire?: FireSettings): FireCtx | null {
  const saved = data.profile.settings.outlook;
  const s: FireSettings = fire ?? { walkAwayYear: saved.walkAwayYear, withdrawalRate: saved.withdrawalRate, stateTaxRate: saved.stateTaxRate, retirementAge: saved.retirementAge };
  const b = baseFrom(book, data, s);
  if (!b) return null;
  // As FireClient: the forecast, FIRE's two plans, the analysis.
  const plans = firePlans(b.f);
  const fa = analyzeFire(plans.full, plans.base, { asOf: b.seeds.start.asOf, retirementAge: b.a.retirementAge });
  return { ...b, plans, fa, fire: s };
}

const fireLink = (c: FireCtx, label: string, figure: FireFigure): ProofLink => ({ label, descriptor: { report: "planning", page: "fire", figure, fire: c.fire } });

function fireSettingsBlock(c: FireCtx): ProofBlock {
  return {
    kind: "chain",
    title: "FIRE settings",
    lines: [
      { label: "Withdrawal rate", value: { ratio: c.fire.withdrawalRate }, source: "assumption", note: "Of Jan 1 net worth." },
      { label: "State tax on draws", value: c.fire.stateTaxRate == null ? { text: "Connecticut's brackets" } : { ratio: c.fire.stateTaxRate }, source: c.fire.stateTaxRate == null ? "law" : "assumption" },
      { label: "Walk-away year", value: { text: c.fire.walkAwayYear == null ? "keep working" : String(c.fire.walkAwayYear) }, source: "assumption" },
      { label: "Retirement age (Coast target)", value: { text: String(c.fire.retirementAge) }, source: "assumption" },
      { label: "Federal brackets and standard deduction", value: { text: String(c.plans.full.tax.year) }, source: "law", note: `Married filing jointly; indexed by inflation (${pct(c.plans.full.inflation)}) each year after ${c.plans.full.tax.year}.` },
    ],
    note: "As set on the FIRE page (saved or not).",
  };
}

/** The draw whose after-tax income pays `spending` in `year`, ÷ the withdrawal rate. */
function fireNumberBlocks(c: FireCtx, plan: OutlookPlan, year: number, spending: number, title: string): { blocks: ProofBlock[]; number: number; parts: number } {
  const draw = drawFor(plan, year, spending);
  const t = retirementTax(plan, year, draw);
  const number = fireNumber(plan, year, spending);
  return {
    number,
    parts: Math.ceil(draw / plan.withdrawalRate),
    blocks: [
      {
        kind: "chain",
        title: `The draw that pays ${money(spending)} after tax`,
        lines: [
          { label: `Pre-tax draw in ${year}`, value: { cents: draw }, source: "derived", note: "The smallest draw whose after-tax income covers the spending." },
          { op: "−", label: "Federal income tax", value: { cents: t.federal }, source: "law", note: `On ${money(t.taxable)} after the standard deduction.` },
          { op: "−", label: plan.stateTaxRate == null ? "Connecticut income tax (its brackets)" : `State tax (${pct(plan.stateTaxRate)} of the taxable draw)`, value: { cents: t.state }, source: plan.stateTaxRate == null ? "law" : "derived" },
          { op: "=", label: "After-tax income", value: { cents: t.afterTax }, source: "derived", note: `Covers ${money(spending)}.` },
        ],
      },
      {
        kind: "chain",
        title,
        lines: [
          { label: "Pre-tax draw", value: { cents: draw }, source: "derived" },
          { op: "÷", label: "Withdrawal rate", value: { ratio: plan.withdrawalRate }, source: "assumption" },
          { op: "=", label: title, value: { cents: number }, source: "derived", note: "Rounded up to the cent." },
        ],
      },
    ],
  };
}

function fireNumberProof(c: FireCtx, which: "fire" | "lean" | "fat"): Built {
  const plan = c.plans.full;
  const y0 = plan.start.year;
  const living0 = c.fa.now.livingCost;
  const share = which === "lean" ? LEAN_SHARE : which === "fat" ? FAT_SHARE : 1;
  const spending = which === "fire" ? living0 : Math.round(living0 * share);
  const word = { fire: "FIRE number", lean: "Lean FIRE number", fat: "Fat FIRE number" }[which];
  const page = which === "fire" ? c.fa.now.fireNumber : which === "lean" ? c.fa.now.leanNumber : c.fa.now.fatNumber;
  const costLines: ChainLine[] = [livingLine(c, undefined, `Living cost in ${y0}`)];
  if (which !== "fire") costLines.push({ op: "×", label: `${which === "lean" ? "Lean" : "Fat"} FIRE's share of it`, value: { ratio: share }, source: "derived", note: "The page's definition." }, { op: "=", label: "Spending to cover", value: { cents: spending }, source: "derived" });
  const n = fireNumberBlocks(c, plan, y0, spending, word);
  const { checks, withheld } = forecastChecks(c);
  return {
    describes: `${word}: the net worth whose draw covers ${which === "fire" ? "living cost" : `${share * 100}% of living cost`} after tax`,
    figure: { cents: page },
    selfCheck: sumCheck(page, n.parts, `${money(drawFor(plan, y0, spending))} ÷ ${pct(plan.withdrawalRate)} rounds up to ${money(n.parts)}`),
    blocks: [{ kind: "chain", title: "What a year costs", lines: costLines }, ...n.blocks, fireSettingsBlock(c)],
    checks,
    withheld,
    estimates: [],
    through: c.seeds.start.asOf,
  };
}

/** One year's walk-away row as a chain: Jan 1 net worth × the withdrawal rate, after tax, against that year's living cost. */
function walkRowBlock(c: FireCtx, plan: OutlookPlan, row: WalkAwayRow, need: number, title: string, forecastMonths: boolean): ProofBlock {
  const dec = `${row.year - 1}-12`;
  return {
    kind: "chain",
    title,
    lines: [
      // The no-bonus plan is FIRE's own run, not the forecast: no ledger cell holds its net worth.
      forecastMonths
        ? projected(undefined, `Net worth on Jan 1, ${row.year}`, row.netWorth, { month: dec, line: "netWorth" }, `The forecast's net worth at the end of ${monthWord(dec)}.`)
        : projected(undefined, `Net worth on Jan 1, ${row.year}`, row.netWorth, null, `The forecast with every bonus left out, at the end of ${monthWord(dec)}.`),
      { op: "×", label: "Withdrawal rate", value: { ratio: plan.withdrawalRate }, source: "assumption" },
      { op: "=", label: "Draw", value: { cents: row.draw }, source: "derived" },
      { op: "−", label: "Federal income tax", value: { cents: row.federalTax }, source: "law" },
      { op: "−", label: plan.stateTaxRate == null ? "Connecticut income tax (its brackets)" : `State tax (${pct(plan.stateTaxRate)})`, value: { cents: row.stateTax }, source: plan.stateTaxRate == null ? "law" : "derived" },
      { op: "=", label: "Walk-away income after tax", value: { cents: row.afterTaxIncome }, source: "derived" },
      projected("÷", `Living cost in ${row.year}`, row.livingCost, yearCell(row.year, "living"), `Grown by ${pct(plan.livingGrowth)} a year from the start.`),
      { op: "=", label: `Covered (${need >= 1 ? `${need * 100}%` : `${need * 100}%`} needed)`, value: { ratio: row.coverage ?? 0 }, source: "derived" },
    ],
  };
}

function fiYearProof(c: FireCtx, flavor: "fi" | "base" | "lean" | "fat"): Built {
  const plan = flavor === "base" ? c.plans.base : c.plans.full;
  const need = flavor === "lean" ? LEAN_SHARE : flavor === "fat" ? FAT_SHARE : 1;
  // The same tables analyzeFire reads: the full plan's rows, or the no-bonus plan's walk-away table.
  const rows: WalkAwayRow[] = flavor === "base" ? walkAwayTable(extended(plan)) : c.fa.rows;
  const row = flavor === "fi" ? c.fa.fi : flavor === "base" ? c.fa.fiBase : flavor === "lean" ? c.fa.lean : c.fa.fat;
  const word = { fi: "Financially independent", base: "Financially independent with no bonuses", lean: "Lean FIRE", fat: "Fat FIRE" }[flavor];
  const nowNumber = flavor === "lean" ? c.fa.now.leanNumber : flavor === "fat" ? c.fa.now.fatNumber : c.fa.now.fireNumber;
  const reachedNow = (flavor === "lean" || flavor === "fat") && c.fa.now.netWorth >= nowNumber;
  const blocks: ProofBlock[] = [];
  let figure: ProofValue;
  if (reachedNow) {
    figure = { text: "Now" };
    blocks.push({
      kind: "chain",
      title: "Reached already",
      lines: [startLine(c), { label: `${flavor === "lean" ? "Lean" : "Fat"} FIRE number today`, value: { cents: nowNumber }, source: "derived", note: "Net worth is at or past it.", link: fireLink(c, "The number", flavor === "lean" ? "lean-number" : "fat-number") }],
    });
  } else {
    figure = { text: row ? String(row.year) : "Not in 60 yrs" };
    if (row) blocks.push(walkRowBlock(c, plan, rows.find((r) => r.year === row.year) ?? row, need, `Walking away on Jan 1, ${row.year}`, flavor !== "base"));
    const before = row ? rows.find((r) => r.year === row.year - 1) : rows.at(-1);
    if (before) blocks.push(walkRowBlock(c, plan, before, need, row ? `A year earlier, ${before.year}: not yet` : `Still short in ${before.year}, the last year looked at`, flavor !== "base"));
  }
  if (flavor === "base") blocks.push({ kind: "chain", title: "No bonuses", lines: [{ label: "Every bonus (paid, scheduled and estimated)", value: { cents: 0 }, source: "derived", note: "Left out to show what base pay alone does." }] });
  blocks.push(driversBlock(c), fireSettingsBlock(c));
  const { checks, withheld } = forecastChecks(c);
  return {
    describes: `${word}: the first year walk-away income covers ${need === 1 ? "living cost" : `${need * 100}% of living cost`}`,
    figure,
    selfCheck: null,
    blocks,
    checks,
    withheld,
    estimates: [projectionEstimate(c)],
    through: c.seeds.start.asOf,
  };
}

function coastNumberProof(c: FireCtx): Built {
  const plan = c.plans.full;
  const y0 = plan.start.year;
  const retire = c.fa.retireYear;
  const { checks, withheld } = forecastChecks(c);
  if (retire == null || c.fa.now.coastNumber == null)
    return { describes: "Coast FIRE number", figure: { text: "Needs age" }, selfCheck: null, blocks: [{ kind: "chain", title: "Coast FIRE", lines: [{ label: "Birth year", value: { text: "not set" }, source: "assumption", note: "Add birth years in Settings › Household." }] }], checks, withheld, estimates: [], through: c.seeds.start.asOf };
  const living = livingIn(plan, retire);
  const n = fireNumberBlocks(c, plan, retire, living, `FIRE number in ${retire}`);
  const years = retire - y0;
  const coast = c.fa.now.coastNumber;
  return {
    describes: `Coast FIRE number: invested today, returns alone reach the FIRE number by ${retire}`,
    figure: { cents: coast },
    selfCheck: sumCheck(coast, Math.round(n.number / (1 + plan.returnRate) ** years), `${money(n.number)} ÷ (1 + ${pct(plan.returnRate)})^${years} rounds to ${money(Math.round(n.number / (1 + plan.returnRate) ** years))}`),
    blocks: [
      {
        kind: "chain",
        title: `Living cost in ${retire}`,
        lines: [
          livingLine(c, undefined, `Living cost in ${y0}`),
          { op: "×", label: `(1 + living growth)^${years}`, value: { ratio: (1 + plan.livingGrowth) ** years }, source: "assumption", note: `${pct(plan.livingGrowth)} a year.` },
          { op: "=", label: `Living cost in ${retire}`, value: { cents: living }, source: "estimate" },
        ],
        note: `${retire} = birth year ${plan.birthYear} + retirement age ${c.fire.retirementAge}.`,
      },
      ...n.blocks,
      {
        kind: "chain",
        title: "Back to today",
        lines: [
          { label: `FIRE number in ${retire}`, value: { cents: n.number }, source: "derived" },
          { op: "÷", label: `(1 + return)^${years}`, value: { ratio: (1 + plan.returnRate) ** years }, source: "assumption", note: `${pct(plan.returnRate)} a year.` },
          { op: "=", label: "Coast FIRE number today", value: { cents: coast }, source: "derived" },
        ],
      },
      fireSettingsBlock(c),
    ],
    checks,
    withheld,
    estimates: [],
    through: c.seeds.start.asOf,
  };
}

function coastYearProof(c: FireCtx): Built {
  const { now, coast, rows } = c.fa;
  const { checks, withheld } = forecastChecks(c);
  const reached = now.coastNumber != null && now.netWorth >= now.coastNumber;
  const blocks: ProofBlock[] = [];
  const rowBlock = (r: (typeof rows)[number], title: string): ProofBlock => ({
    kind: "chain",
    title,
    lines: [
      projected(undefined, `Net worth on Jan 1, ${r.year}`, r.netWorth, { month: `${r.year - 1}-12`, line: "netWorth" }, `The forecast's net worth at the end of Dec ${r.year - 1}.`),
      { label: `Coast FIRE number in ${r.year}`, value: { cents: r.coastNumber ?? 0 }, source: "derived", note: `The FIRE number in ${c.fa.retireYear} discounted at the return.` },
    ],
  });
  if (reached) blocks.push({ kind: "chain", title: "Reached already", lines: [startLine(c), { label: "Coast FIRE number today", value: { cents: now.coastNumber! }, source: "derived", link: fireLink(c, "Coast FIRE number", "coast-number") }] });
  else if (coast) {
    blocks.push(rowBlock(coast, `${coast.year}: net worth reaches it`));
    const before = rows.find((r) => r.year === coast.year - 1);
    if (before) blocks.push(rowBlock(before, `${before.year}: not yet`));
  }
  blocks.push({ kind: "chain", title: "Coast FIRE today", lines: [{ label: "Coast FIRE number", value: now.coastNumber != null ? { cents: now.coastNumber } : { text: "needs a birth year" }, source: "derived", link: fireLink(c, "Coast FIRE number", "coast-number") }] }, driversBlock(c), fireSettingsBlock(c));
  return {
    describes: "Coast FIRE: the first year net worth reaches that year's Coast FIRE number",
    figure: { text: reached ? "Reached" : coast ? String(coast.year) : c.plans.full.birthYear == null ? "Needs age" : "—" },
    selfCheck: null,
    blocks,
    checks,
    withheld,
    estimates: [projectionEstimate(c)],
    through: c.seeds.start.asOf,
  };
}

function savingsRateProof(c: FireCtx): Built {
  const y = c.fa.projection.find((p) => p.months === 12 && p.working);
  const { checks, withheld } = forecastChecks(c);
  if (!y || c.fa.savingsRate == null) return { describes: "Savings rate", figure: { text: "—" }, selfCheck: null, blocks: [], checks, withheld, estimates: [], through: c.seeds.start.asOf };
  const yr = (line: LedgerLine) => yearCell(y.year, line);
  const sum = `The forecast's ${y.year}, Jan–Dec.`;
  const income = y.takeHome + y.employerMatch + y.bonusKept;
  const bonusSpent = y.bonusKept - y.bonusSaved;
  const parts = income - y.livingCost - y.planned - bonusSpent;
  return {
    describes: `Savings rate in ${y.year}, the first full working year of the plan`,
    figure: { ratio: c.fa.savingsRate },
    selfCheck: sumCheck(y.saved, parts, `Income less living cost, one-offs and bonus spent comes to ${money(parts)} saved`),
    blocks: [
      {
        kind: "chain",
        title: `What ${y.year} brings in and saves`,
        lines: [
          // The ledger has no take-home line (its taxes line nets bonus tax in), so no cell holds it.
          projected(undefined, "Take-home from base pay", y.takeHome, null, sum),
          projected("+", "Employer 401(k) and HSA money", y.employerMatch, yr("employer"), sum),
          // The ledger shows bonus gross and bonus spent, not bonus kept: no cell holds it.
          projected("+", "Bonus kept after tax", y.bonusKept, null, sum),
          { op: "=", label: "Income", value: { cents: income }, source: "derived" },
          projected("−", "Living cost", y.livingCost, yr("living"), sum),
          projected("−", "Planned one-offs", y.planned, yr("oneOffs"), `Typed on the Forecast page. ${sum}`),
          projected("−", "Bonus spent (kept, not saved)", bonusSpent, yr("bonusSpent"), sum),
          { op: "=", label: "Saved incl. retirement", value: { cents: y.saved }, source: "derived" },
          { op: "÷", label: "Income", value: { cents: income }, source: "derived" },
          { op: "=", label: "Savings rate", value: { ratio: c.fa.savingsRate }, source: "derived" },
        ],
      },
      driversBlock(c),
    ],
    checks,
    withheld,
    estimates: [projectionEstimate(c)],
    through: c.seeds.start.asOf,
  };
}

/** Year one's take-home from base pay and employer money: base salary × the share kept after tax, plus the employer's 401(k)/HSA money (firstYearIncome). */
function incomeProof(c: FireCtx): Built {
  const plan = c.fa.plan;
  const takeHome = Math.round(plan.salary * plan.takeHomeRate);
  const income = firstYearIncome(plan);
  const { checks, withheld } = forecastChecks(c);
  return {
    describes: "Take-home from base pay plus employer money, the plan's first year",
    figure: { cents: income },
    selfCheck: sumCheck(income, takeHome + plan.employerMatch, `Take-home and employer money add up to ${money(takeHome + plan.employerMatch)}`),
    blocks: [
      {
        kind: "chain",
        title: "Year one's income from pay",
        lines: [
          { label: "Household base salary", value: { cents: plan.salary }, source: "derived", link: seedLink("Kept after tax", { report: "forecast", figure: "seed", which: "take-home" }) },
          { op: "×", label: "Kept after tax", value: { ratio: plan.takeHomeRate }, source: c.f.pay.rateTyped ? "assumption" : "derived", link: seedLink("Kept after tax", { report: "forecast", figure: "seed", which: "take-home" }) },
          { op: "=", label: "Take-home from base pay", value: { cents: takeHome }, source: "derived" },
          { op: "+", label: "Employer 401(k) and HSA money", value: { cents: plan.employerMatch }, source: c.f.pay.employerTyped ? "assumption" : "derived", link: seedLink("Employer money", { report: "forecast", figure: "seed", which: "employer" }) },
          { op: "=", label: "Income the savings-rate chart runs on", value: { cents: income }, source: "derived" },
        ],
        note: "Bonuses stay as set: each point of the chart changes only living cost.",
      },
      driversBlock(c),
    ],
    checks,
    withheld,
    estimates: [],
    through: c.seeds.start.asOf,
  };
}

function ratioOfNowProof(c: FireCtx, which: "years-saved" | "runway" | "progress" | "liquid-share"): Built {
  const { now } = c.fa;
  const { checks, withheld } = forecastChecks(c);
  const liquid: ChainLine = { label: `Liquid money at the end of ${c.seeds.start.asOf}`, value: { cents: now.liquid }, source: "proven", note: "Cash and taxable investments, less card balances.", link: START };
  const [top, bottom, value, word] =
    which === "years-saved"
      ? [startLine(c), livingLine(c, "÷"), now.yearsOfSpending, "Years of spending saved"]
      : which === "runway"
        ? [liquid, livingLine(c, "÷"), now.liquidYears, "Runway (liquid)"]
        : which === "liquid-share"
          ? [liquid, startLine(c, "÷"), now.liquid / Math.max(1, now.netWorth), "Share of net worth that is liquid"]
          : [startLine(c), { op: "÷" as const, label: "FIRE number", value: { cents: now.fireNumber }, source: "derived" as const, link: fireLink(c, "FIRE number", "fire-number") }, now.progress, "Progress to financial independence"];
  const ratio = which === "progress" || which === "liquid-share";
  return {
    describes: word,
    figure: ratio ? { ratio: value } : { text: value.toFixed(1) },
    selfCheck: null,
    blocks: [{ kind: "chain", title: word, lines: [top, bottom, { op: "=", label: word, value: ratio ? { ratio: value } : { text: value.toFixed(2) }, source: "derived" }] }],
    checks,
    withheld,
    estimates: [],
    through: c.seeds.start.asOf,
  };
}

function milestoneProof(c: FireCtx, id: string): Built {
  const plan = c.plans.full;
  const { checks, withheld } = forecastChecks(c);
  const m = c.fa.milestones.find((x) => x.id === id);
  if (!m) return notFound(`No FIRE milestone ${id}.`);
  const blocks: ProofBlock[] = [];
  if (id.startsWith("nw-")) {
    const target = Number(id.slice(3));
    // The same month-by-month path the milestones come from (keep working, 60 years out).
    const long = projectOutlook({ ...extended(plan), walkAwayYear: null }).months;
    const nm = netWorthMilestones(plan).find((x) => x.cents === target);
    if (m.reached) blocks.push({ kind: "chain", title: "Reached already", lines: [startLine(c), { label: "Milestone", value: { cents: target }, source: "derived" }] });
    else if (nm?.key) {
      const i = long.findIndex((x) => x.key === nm.key);
      const at = long[i]!;
      const lines: ChainLine[] = [{ label: "Milestone", value: { cents: target }, source: "derived", note: "One of the page's fixed net worth marks." }];
      // The long run looks 60 years out; a month past the forecast's horizon has no cell (linkCells finds none).
      lines.push(projected(undefined, `Net worth at the end of ${monthWord(at.key)}: reaches it`, at.netWorth, { month: at.key, line: "netWorth" }, "The forecast, kept working."));
      if (i > 0) lines.push(projected(undefined, `End of ${monthWord(long[i - 1]!.key)}: not yet`, long[i - 1]!.netWorth, { month: long[i - 1]!.key, line: "netWorth" }, "The forecast, kept working."));
      else lines.push(startLine(c));
      blocks.push({ kind: "chain", title: `The first month at or past ${money(target)}`, lines });
    } else
      blocks.push({ kind: "chain", title: "Not within 60 years", lines: [{ label: "Milestone", value: { cents: target }, source: "derived" }, projected(undefined, `Net worth at the end of ${monthWord(long.at(-1)!.key)}`, long.at(-1)!.netWorth, { month: long.at(-1)!.key, line: "netWorth" }, "The forecast, kept working, 60 years out.")] });
  } else {
    const share = Number(id.slice(3));
    const row = m.reached ? null : (c.fa.rows.find((r) => r.progress >= share) ?? null);
    if (m.reached) blocks.push({ kind: "chain", title: "Reached already", lines: [{ label: "Progress today", value: { ratio: c.fa.now.progress }, source: "derived", link: fireLink(c, "Progress", "progress") }] });
    else if (row) {
      const before = c.fa.rows.find((r) => r.year === row.year - 1);
      for (const r of [row, ...(before ? [before] : [])])
        blocks.push({
          kind: "chain",
          title: r === row ? `${r.year}: ${share * 100}% of the FIRE number` : `${r.year}: not yet`,
          lines: [
            projected(undefined, `Net worth on Jan 1, ${r.year}`, r.netWorth, { month: `${r.year - 1}-12`, line: "netWorth" }, `The forecast's net worth at the end of Dec ${r.year - 1}.`),
            { op: "÷", label: `FIRE number in ${r.year}`, value: { cents: r.fireNumber }, source: "derived", note: `The draw covering ${r.year}'s living cost after tax ÷ the withdrawal rate.` },
            { op: "=", label: "Progress", value: { ratio: r.progress }, source: "derived" },
          ],
        });
    }
  }
  blocks.push(driversBlock(c));
  return {
    describes: `Milestone: ${m.label}`,
    figure: { text: m.reached ? "Reached" : m.key ? monthWord(m.key) : m.year ? `Jan 1, ${m.year}` : "Not within 60 years" },
    selfCheck: null,
    blocks,
    checks,
    withheld,
    estimates: m.reached ? [] : [projectionEstimate(c)],
    through: c.seeds.start.asOf,
  };
}

// FIRE › Plan and Stress test: the long-term table, the bridge to 59½, the market paths.

const tables = new WeakMap<FireCtx, { table: LongTermTable; full: Outlook }>();
/** The long-term table as FIRE › Plan builds it (PlanTab → LongTermView): the plan as run, the no-bonus plan, the proven years. */
function fireTableOf(c: FireCtx): { table: LongTermTable; full: Outlook } {
  let t = tables.get(c);
  if (!t) {
    const full = projectOutlook(c.plans.full);
    const base = c.plans.base === c.plans.full ? full : projectOutlook(c.plans.base);
    tables.set(c, (t = { table: longTermTable({ r: c.data.profile, s: c.seeds, full, base, plan: c.fa.plan, pay: c.f.pay, schedule: c.f.schedule }), full }));
  }
  return t;
}

const stresses = new WeakMap<FireCtx, Map<number, StressTest>>();
/** The stress test as FIRE › Stress test runs it: the same seeded paths, so the same figures. */
function fireStress(c: FireCtx, volatility: number): StressTest {
  let byVol = stresses.get(c);
  if (!byVol) stresses.set(c, (byVol = new Map()));
  if (!byVol.has(volatility)) byVol.set(volatility, stressTest(c.fa.plan, { volatility, paths: STRESS_PATHS }));
  return byVol.get(volatility)!;
}

function planCellProof(c: FireCtx, row: string, col: string): Built {
  const { table: t, full } = fireTableOf(c);
  const cell = longTermCells(t).find((x) => x.row === row && x.col === col);
  const value = cell ? planValue(cell.value) : null;
  if (!cell || !value) return notFound(`The long-term table shows no "${row}" in ${col}.`);
  const j = t.columns.findIndex((x) => x.id === col);
  const forecast = t.projected.includes(j) || t.highlight.includes(j);
  const year = Number(/(\d{4})/.exec(col)?.[1]);
  const y = forecast ? full.years.find((x) => x.year === year) : undefined;
  const lines: ChainLine[] = [{ label: cell.label, value, source: forecast ? "estimate" : "proven", note: forecast ? "The plan, year by year, on the saved forecast and the FIRE settings." : "A proven year (or this year so far), as the annual statement shows it." }];
  if (y) {
    const plain = (label: string, cents: number) => lines.push({ label, value: { cents }, source: "estimate" });
    plain(`Net worth, Jan 1 ${y.year}`, y.startNetWorth);
    if (y.working) {
      plain("Base salary", y.salary);
      plain("Bonuses (gross)", y.bonusGross);
      plain("Employer 401(k) & HSA", y.employerMatch);
    } else {
      plain("Pre-tax draw", y.draw);
      plain("After-tax income", y.afterTaxIncome);
    }
    plain("Living cost", y.livingCost);
    plain("Saved", y.saved);
    plain("Investment growth", y.growth);
    plain(`Net worth, Dec 31 ${y.year}`, y.netWorth);
  }
  const { checks, withheld } = forecastChecks(c);
  return {
    describes: `FIRE › Plan, long-term table: ${cell.label}`,
    figure: value,
    selfCheck: null,
    rederived: rederivePlanCell(t, full, row, col, value, { birthYear: c.fa.plan.birthYear ?? null, nwAt: (iso) => ledgerNetWorthAt(c.book, iso) + (c.data.profile.years.find((y) => `${y.year}-12-31` === iso)?.netWorth?.inTransit ?? 0) }),
    blocks: [{ kind: "chain", title: forecast ? `The plan in ${year}` : "Proven", lines }, driversBlock(c), fireSettingsBlock(c)],
    checks,
    withheld,
    estimates: forecast ? [projectionEstimate(c)] : [],
    through: c.seeds.start.asOf,
  };
}

const ACCESS_WORDS: Record<AccessFigure, string> = { liquid: "Liquid (cash + taxable investments) on the walk-away Jan 1", illiquid: "Retirement & other accounts on the walk-away Jan 1", "liquid-out": "The year liquid money runs out", "access-year": "The first full year of penalty-free access (age 60)" };

function accessProof(c: FireCtx, metric: AccessFigure): Built {
  const a = accessFigures(c.fa.plan, c.fa.fi?.year ?? null);
  const value = a ? planValue(a.figures[metric]) : null;
  if (!a || !value) return notFound("No walk-away year and no FI year, or no birth year: the bridge to 59½ isn't shown.");
  const b = a.bridge;
  const { checks, withheld } = forecastChecks(c);
  return {
    describes: `FIRE › Plan, bridging to 59½: ${ACCESS_WORDS[metric]}`,
    figure: value,
    selfCheck: null,
    rederived: rederiveAccess(metric, value, { walkAway: a.walkAway, birthYear: c.fa.plan.birthYear ?? null, plan: fireTableOf(c).full }),
    blocks: [
      {
        kind: "chain",
        title: `Walking away on Jan 1, ${a.walkAway}`,
        lines: [
          { label: "Walk-away year", value: { text: String(a.walkAway) }, source: "assumption", note: c.fa.plan.walkAwayYear ? "As set on the FIRE page." : "None set: FI's year." },
          { label: `Liquid, Jan 1 ${a.walkAway}`, value: { cents: b.liquidAtWalkAway }, source: "estimate", note: "The plan's cash + taxable investments at the end of the year before." },
          { label: "Retirement & other", value: { cents: b.illiquidAtWalkAway }, source: "estimate" },
          { label: "Liquid lasts until", value: { text: b.liquidOutYear ? String(b.liquidOutYear) : "never runs out" }, source: "estimate", note: "The first retired year that starts with no liquid money left." },
          { label: "Penalty-free access", value: { text: String(b.accessYear) }, source: "law", note: `Birth year ${c.fa.plan.birthYear} + 60.` },
        ],
      },
      driversBlock(c),
      fireSettingsBlock(c),
    ],
    checks,
    withheld,
    estimates: [projectionEstimate(c)],
    through: c.seeds.start.asOf,
  };
}

const STRESS_WORDS: Record<StressFigure, string> = { p50: "FI year in a typical market (median path)", p10: "FI year in good markets (best 10% of paths)", p90: "FI year in bad markets (worst 10% of paths)", "by-fi": "Chance of FI by the steady-return plan's FI year" };

function stressProof(c: FireCtx, metric: StressFigure, volatility: number): Built {
  const st = fireStress(c, volatility);
  const value = planValue(stressFigures(st, c.fa.fi?.year ?? null)[metric]);
  if (!value) return notFound(`The stress test shows no ${STRESS_WORDS[metric].toLowerCase()}.`);
  const { checks, withheld } = forecastChecks(c);
  const yr = (y: number | null) => ({ text: y ? String(y) : "not in 60 yrs" });
  return {
    describes: `FIRE › Stress test: ${STRESS_WORDS[metric]}`,
    figure: value,
    selfCheck: null,
    rederived: rederiveStress(metric, value, st, c.fa.fi?.year ?? null),
    blocks: [
      {
        kind: "chain",
        title: `${st.paths.toLocaleString("en-US")} market paths`,
        lines: [
          { label: "Average return", value: { ratio: c.fa.plan.returnRate }, source: "assumption" },
          { label: "Yearly swings (standard deviation)", value: { ratio: volatility }, source: "assumption", note: "As set on the FIRE page." },
          { label: "Paths", value: { text: st.paths.toLocaleString("en-US") }, source: "derived", note: "Lognormal yearly returns from one fixed seed: the same paths every time." },
          { label: "FI year, best 10%", value: yr(st.fiYears.p10), source: "estimate" },
          { label: "FI year, median", value: yr(st.fiYears.p50), source: "estimate" },
          { label: "FI year, worst 10%", value: yr(st.fiYears.p90), source: "estimate" },
          ...(c.fa.fi ? [{ label: `FI by ${c.fa.fi.year} (the steady plan's FI year)`, value: { ratio: st.fiByYear.find((x) => x.year === c.fa.fi!.year)?.share ?? 0 }, source: "estimate" as const, link: fireLink(c, "Steady-return FI year", "fi-year") }] : []),
        ],
      },
      driversBlock(c),
      fireSettingsBlock(c),
    ],
    checks,
    withheld,
    estimates: [projectionEstimate(c)],
    through: c.seeds.start.asOf,
  };
}

export function buildFire(c: FireCtx, d: Extract<PlanningDescriptor, { page: "fire" }>): Built {
  switch (d.figure) {
    case "fire-number":
      return fireNumberProof(c, "fire");
    case "lean-number":
      return fireNumberProof(c, "lean");
    case "fat-number":
      return fireNumberProof(c, "fat");
    case "coast-number":
      return coastNumberProof(c);
    case "fi-year":
      return fiYearProof(c, "fi");
    case "fi-year-base":
      return fiYearProof(c, "base");
    case "lean-year":
      return fiYearProof(c, "lean");
    case "fat-year":
      return fiYearProof(c, "fat");
    case "coast-year":
      return coastYearProof(c);
    case "savings-rate":
      return savingsRateProof(c);
    case "income":
      return incomeProof(c);
    case "years-saved":
    case "runway":
    case "progress":
    case "liquid-share":
      return ratioOfNowProof(c, d.figure);
    case "milestone":
      return milestoneProof(c, d.milestone!);
    case "plan-cell":
      return planCellProof(c, d.row!, d.col!);
    case "access":
      return accessProof(c, d.metric as AccessFigure);
    case "stress":
      return stressProof(c, d.metric as StressFigure, d.volatility!);
  }
}

