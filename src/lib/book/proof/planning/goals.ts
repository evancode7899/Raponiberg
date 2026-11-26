import { addDays, daysBetween } from "../../../dates/isoDate.ts";
import { balancesAt } from "../../../forecast/forecast.ts";
import { loadForecastData } from "../../../forecast/load.ts";
import { GOALS_KEY, normalizeGoals } from "../../../goals/settings.ts";
import { loadJsonSetting } from "../../../settingsStore.ts";
import type { Book } from "../../load.ts";
import { buildGoals, goalForecastOf, type GoalProgress, type GoalsReport } from "../../reports/goals.ts";
import { CASH_FLOW_CHECKS } from "../cashFlowProof.ts";
import { checksFor, perBook, sumCheck } from "../common.ts";
import { NET_WORTH_CHECKS, type NetWorthDescriptor } from "../netWorthProof.ts";
import type { GoalFigure, PlanningDescriptor } from "../planningProof.ts";
import type { ChainLine, Proof, ProofBlock, ProofContext, ProofEstimate, ProofLink } from "../types.ts";
import { type Base, baseFrom, type Built, driversBlock, money, monthWord, notFound, pct, prevKey, projected, projectionEstimate, START, startNetWorth } from "./shared.ts";

/** The Goals page's figures (planningProof.ts): where each goal stands, what's left, when the forecast reaches it. */

type GoalsCtx = { book: Book; r: GoalsReport; b: Base | null };

export async function goalsCtx(ctx: ProofContext): Promise<GoalsCtx> {
  // As api/goals: the saved goals, buildGoals on the shared forecast.
  const [settings, data] = await Promise.all([loadJsonSetting(ctx.db, GOALS_KEY, normalizeGoals), perBook(ctx, "forecast-data", () => loadForecastData(ctx.db, ctx.book))]);
  const b = baseFrom(ctx.book, data);
  return { book: ctx.book, r: buildGoals(ctx.book, settings, b ? goalForecastOf(b.f) : null, data.profile.settings), b };
}

const goalLink = (g: GoalProgress, label: string, figure: GoalFigure): ProofLink => ({ label, descriptor: { report: "planning", page: "goals", figure, goalId: g.goal.id } });

function targetLine(c: GoalsCtx, g: GoalProgress, op?: ChainLine["op"]): ChainLine {
  if (g.goal.kind === "EMERGENCY_FUND")
    return { ...(op ? { op } : {}), label: `Target: ${g.goal.months} months of spending`, value: g.targetCents == null ? { text: "—" } : { cents: g.targetCents }, source: "derived", link: goalLink(g, "Target", "target") };
  return { ...(op ? { op } : {}), label: "Target", value: g.targetCents == null ? { text: "—" } : { cents: g.targetCents }, source: "assumption", note: "Typed in the goal's editor." };
}

function goalChecks(c: GoalsCtx, g: GoalProgress) {
  return checksFor(c.book, { affects: "NET_WORTH", from: c.r.asOf, to: c.r.asOf, accountIds: g.blockerAccountIds }, NET_WORTH_CHECKS);
}

function goalCurrentProof(c: GoalsCtx, g: GoalProgress): Built {
  const track = g.goal.funding === "TRACK";
  const balance = (a: GoalProgress["accounts"][number]): ChainLine => ({
    label: `${a.name} on ${c.r.asOf}`,
    value: { cents: a.cents },
    source: "proven",
    link: { label: a.name, descriptor: { report: "net-worth", metric: "balance", date: c.r.asOf, accountIds: [a.id] } satisfies NetWorthDescriptor },
  });
  const blocks: ProofBlock[] = [
    {
      kind: "chain",
      title: track ? "Balances counted" : "Money set aside, account by account",
      lines: [
        ...g.accounts.map((a, i): ChainLine => (a.earmarkedCents === a.cents ? { ...balance(a), op: i ? "+" : undefined } : { op: i ? "+" : undefined, label: `Counted from ${a.name}`, value: { cents: a.earmarkedCents }, source: "derived" })),
        { op: "=", label: track ? "Counted toward the milestone" : "Set aside for the goal", value: { cents: g.currentCents }, source: "derived" },
      ],
      note: track ? "A milestone counts whole balances and claims nothing." : "Goals higher in the list claim an account's money first; a share caps what this goal may claim.",
    },
  ];
  for (const a of g.accounts.filter((x) => x.earmarkedCents !== x.cents)) {
    const left = a.cents - a.claimedBeforeCents;
    const lines: ChainLine[] = [balance(a)];
    if (a.claimedBeforeCents) lines.push({ op: "−", label: "Claimed by earlier goals", value: { cents: a.claimedBeforeCents }, source: "derived" }, { op: "=", label: "Left for this goal", value: { cents: left }, source: "derived" });
    if (a.share != null) lines.push({ label: `This goal's share cap (${pct(a.share, 0)} of the balance)`, value: { cents: Math.round(Math.max(0, a.cents) * a.share) }, source: "assumption" });
    lines.push({ label: "Counted toward this goal: the least of what's left, the cap and what the goal still needed", value: { cents: a.earmarkedCents }, source: "derived" });
    blocks.push({ kind: "chain", title: a.name, lines });
  }
  const { checks, withheld } = goalChecks(c, g);
  const parts = g.accounts.reduce((t, a) => t + a.earmarkedCents, 0);
  return {
    describes: `${g.goal.name}: ${track ? "counted" : "set aside"} on ${c.r.asOf}`,
    figure: { cents: g.currentCents },
    selfCheck: sumCheck(g.currentCents, parts, `The ${g.accounts.length} account${g.accounts.length === 1 ? "" : "s"} add up to ${money(parts)}`),
    blocks,
    checks,
    withheld,
    estimates: [],
    through: c.r.asOf,
  };
}

function goalSpendingProof(c: GoalsCtx): Built {
  const s = c.r.monthlySpending;
  if (!s) return notFound("No proven month of spending yet.");
  const total = s.periods.reduce((t, p) => t + p.cents, 0);
  const { checks, withheld } = checksFor(c.book, { affects: "CASH_FLOW", from: s.from!, to: s.to! }, CASH_FLOW_CHECKS);
  return {
    describes: `Typical monthly living cost: the last ${s.months} proven months`,
    figure: { cents: s.cents },
    selfCheck: sumCheck(Math.round(total / s.months), s.cents, `The ${s.months} months add up to ${money(total)}; ÷ ${s.months} is ${money(Math.round(total / s.months))}`),
    blocks: [
      {
        kind: "breakdown",
        title: "Living cost by month",
        items: s.periods.map((p) => ({
          label: monthWord(p.start),
          value: { cents: p.cents },
          sub: `Cash flow's spending ${money(p.spendingCents)}, less tax payments, one-offs and reimbursements`,
        })),
        note: "Living cost, as everywhere in the app: spending less tax payments (taxes, not living), what you count as one-off, and reimbursements received.",
      },
      {
        kind: "chain",
        title: "Average",
        lines: [
          { label: `${s.months} months`, value: { cents: total }, source: "proven" },
          { op: "÷", label: "Months", value: { text: String(s.months) }, source: "derived" },
          { op: "=", label: "A month", value: { cents: s.cents }, source: "derived", note: "Rounded to the cent." },
        ],
      },
    ],
    checks,
    withheld,
    estimates: [],
    through: s.to!,
  };
}

function goalTargetProof(c: GoalsCtx, g: GoalProgress): Built {
  const blocks: ProofBlock[] = [];
  let selfCheck: Proof["selfCheck"] = null;
  if (g.goal.kind === "EMERGENCY_FUND" && c.r.monthlySpending && g.targetCents != null) {
    const s = c.r.monthlySpending;
    blocks.push({
      kind: "chain",
      title: "Emergency fund target",
      lines: [
        { label: "Typical monthly living cost", value: { cents: s.cents }, source: "proven", link: { label: "Monthly living cost", descriptor: { report: "planning", page: "goals", figure: "spending" } } },
        { op: "×", label: "Months of spending", value: { text: String(g.goal.months) }, source: "assumption" },
        { op: "=", label: "Target", value: { cents: g.targetCents }, source: "derived" },
      ],
    });
    selfCheck = sumCheck(g.targetCents, Math.round(s.cents * (g.goal.months ?? 6)), `${money(s.cents)} × ${g.goal.months} is ${money(Math.round(s.cents * (g.goal.months ?? 6)))}`);
  } else blocks.push({ kind: "chain", title: "Target", lines: [targetLine(c, g)] });
  return { describes: `${g.goal.name}: target`, figure: g.targetCents == null ? { text: "—" } : { cents: g.targetCents }, selfCheck, blocks, estimates: [], through: c.r.asOf };
}

function goalToGoProof(c: GoalsCtx, g: GoalProgress): Built {
  const left = g.targetCents == null ? null : Math.max(0, g.targetCents - g.currentCents);
  const { checks, withheld } = goalChecks(c, g);
  if (left == null) return { describes: `${g.goal.name}: to go`, figure: { text: "—" }, selfCheck: null, blocks: [], checks, withheld, estimates: [], through: c.r.asOf };
  return {
    describes: `${g.goal.name}: still to go`,
    figure: { cents: left },
    selfCheck: sumCheck(left, Math.max(0, g.targetCents! - g.currentCents), `The target less what's ${g.goal.funding === "TRACK" ? "counted" : "set aside"} is ${money(left)}`),
    blocks: [{ kind: "chain", title: "To go", lines: [targetLine(c, g), { op: "−", label: "Already there", value: { cents: g.currentCents }, source: "derived", link: goalLink(g, "Saved so far", "current") }, { op: "=", label: "To go", value: { cents: left }, source: "derived", note: left === 0 ? "Fully funded." : undefined }] }],
    checks,
    withheld,
    estimates: [],
    through: c.r.asOf,
  };
}

function goalLandsProof(c: GoalsCtx, g: GoalProgress): Built {
  const { checks, withheld } = goalChecks(c, g);
  const fmt = (iso: string | null) => (iso ? monthWord(iso) : "—");
  const left = g.targetCents == null ? null : Math.max(0, g.targetCents - g.currentCents);
  const blocks: ProofBlock[] = [];
  const toGo: ChainLine[] = [targetLine(c, g), { op: "−", label: "Already there", value: { cents: g.currentCents }, source: "derived", link: goalLink(g, "Saved so far", "current") }, { op: "=", label: "Still needed", value: left == null ? { text: "—" } : { cents: left }, source: "derived" }];
  let estimates: ProofEstimate[] = [];
  if (g.status === "REACHED") blocks.push({ kind: "chain", title: "Reached", lines: toGo });
  else if (g.projectedFrom === "FORECAST" && c.b && g.filled) {
    const t = g.filled;
    const f = c.b.f;
    const lines: ChainLine[] = [...toGo];
    if (t.need !== t.own) lines.push({ op: "+", label: `Earlier goals' still needed on the same ${t.sides.join(" and ")} money`, value: { cents: t.need - t.own }, source: "derived", note: "New money fills unfinished goals in list order." }, { op: "=", label: "New money the forecast has to add", value: { cents: t.need }, source: "derived" });
    blocks.push({ kind: "chain", title: "What the forecast has to add", lines });
    const addedBlock = (key: string, title: string): ProofBlock => {
      const at = balancesAt(f, key);
      const ls: ChainLine[] = [];
      // Each side: its balance that month (a ledger cell) less where it started.
      for (const s of t.sides) {
        const word = s === "liquid" ? "Liquid" : "Illiquid";
        ls.push(
          projected(ls.length ? "+" : undefined, `${word} money at the end of ${monthWord(key)}`, at[s], { month: key, line: s }, `The forecast's ${s} balance.`),
          { op: "−", label: `${word} money at the start, ${c.b!.seeds.start.asOf}`, value: { cents: f.plan.start[s] }, source: "proven", link: START },
        );
      }
      const sum = t.sides.reduce((x, s) => x + at[s] - f.plan.start[s], 0);
      ls.push({ op: "=", label: `Money added by the end of ${monthWord(key)}`, value: { cents: sum }, source: "derived" });
      ls.push({ label: sum >= t.need ? `Covers the ${money(t.need)} needed` : `Short of the ${money(t.need)} needed`, value: { cents: t.need }, source: "derived" });
      return { kind: "chain", title, lines: ls };
    };
    if (g.projectedDate) {
      const key = g.projectedDate.slice(0, 7);
      blocks.push(addedBlock(key, `${monthWord(key)}: the first month it's covered`));
      if (key > f.startKey && prevKey(key) > f.startKey) blocks.push(addedBlock(prevKey(key), `${monthWord(prevKey(key))}: not yet`));
    } else if (f.months.length) blocks.push(addedBlock(f.months.at(-1)!.key, `Still short at the forecast's end, ${monthWord(f.months.at(-1)!.key)}`));
    blocks.push({ kind: "chain", title: "Where the forecast starts", lines: [{ label: `Liquid at the end of ${c.b.seeds.start.asOf}`, value: { cents: f.plan.start.liquid }, source: "proven", link: START }, { op: "+", label: "Illiquid", value: { cents: f.plan.start.illiquid }, source: "proven", link: START }, { op: "=", label: "Net worth", value: { cents: startNetWorth(c.b) }, source: "proven" }] }, driversBlock(c.b));
    estimates = [projectionEstimate(c.b)];
  } else if (g.pace && left != null) {
    const days = g.pace.monthlyCents > 0 ? Math.ceil((left / g.pace.monthlyCents) * 30.4375) : null;
    const ids = g.accounts.map((a) => a.id);
    blocks.push(
      { kind: "chain", title: "To go", lines: toGo },
      {
        kind: "chain",
        title: "At last year's pace",
        lines: [
          { label: `Change in the funding accounts, ${g.pace.from} → ${g.pace.to}, a month`, value: { cents: g.pace.monthlyCents }, source: "derived", link: { label: "Funding accounts' change", descriptor: { report: "net-worth", metric: "change", granularity: "month", start: addDays(g.pace.from, 1), end: g.pace.to, ...(ids.length ? { accountIds: ids } : {}) } }, note: "Deposits plus growth, per 30.4 days." },
          { label: "Days to cover what's still needed", value: { text: days == null ? "never (not growing)" : String(days) }, source: "derived" },
          { label: "Lands", value: { text: fmt(g.projectedDate) }, source: "estimate", note: `${c.r.asOf} + those days.` },
        ],
        note: "No forecast: last year's pace stands in.",
      },
    );
  } else blocks.push({ kind: "chain", title: "To go", lines: toGo });
  if (g.goal.targetDate) blocks.push({ kind: "chain", title: "Target date", lines: [{ label: "By", value: { text: fmt(g.goal.targetDate) }, source: "assumption" }] });
  return {
    describes: `${g.goal.name}: when it lands`,
    figure: { text: g.status === "REACHED" ? "Reached" : g.projectedDate ? fmt(g.projectedDate) : "Not reached" },
    selfCheck: null,
    blocks,
    checks,
    withheld,
    estimates,
    through: c.r.asOf,
  };
}

function goalNeededProof(c: GoalsCtx, g: GoalProgress): Built {
  const left = g.targetCents == null ? null : Math.max(0, g.targetCents - g.currentCents);
  if (g.neededMonthlyCents == null || left == null || !g.goal.targetDate) return notFound("This goal has no target date or target.");
  const months = Math.max(0, daysBetween(c.r.asOf, g.goal.targetDate) / 30.4375);
  return {
    describes: `${g.goal.name}: needed a month to land by ${monthWord(g.goal.targetDate)}`,
    figure: { cents: g.neededMonthlyCents },
    selfCheck: null,
    blocks: [
      {
        kind: "chain",
        title: "A month from now",
        lines: [
          { label: "Still needed", value: { cents: left }, source: "derived", link: goalLink(g, "To go", "to-go") },
          { op: "÷", label: `Months from ${c.r.asOf} to ${g.goal.targetDate}`, value: { text: months.toFixed(2) }, source: "assumption", note: "The target date you set; months of 30.4 days." },
          { op: "=", label: "A month", value: { cents: g.neededMonthlyCents }, source: "derived", note: months < 1 ? "Under a month left: all of it." : "Rounded up to the cent." },
        ],
      },
    ],
    estimates: [],
    through: c.r.asOf,
  };
}

export function buildGoal(c: GoalsCtx, d: Extract<PlanningDescriptor, { page: "goals" }>): Built {
  if (d.figure === "spending") return goalSpendingProof(c);
  const g = c.r.goals.find((x) => x.goal.id === d.goalId);
  if (!g) return notFound(`No goal has the id ${d.goalId}.`);
  switch (d.figure) {
    case "current":
      return goalCurrentProof(c, g);
    case "target":
      return goalTargetProof(c, g);
    case "to-go":
      return goalToGoProof(c, g);
    case "lands":
      return goalLandsProof(c, g);
    case "needed":
      return goalNeededProof(c, g);
  }
}

