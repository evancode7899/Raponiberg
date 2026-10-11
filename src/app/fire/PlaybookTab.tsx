"use client";

import { btn, Card } from "@/components/ui/kit";
import { FAT_SHARE, LEAN_SHARE, type FireAnalysis } from "@/lib/fire/fire";
import Link from "next/link";
import type { ReactNode } from "react";
import { pct, short, usd } from "./ui";

type Principle = { id: string; title: string; idea: ReactNode; yours?: ReactNode; link?: { href: string; label: string } };

/**
 * The FIRE movement's core ideas in plain language, each tied to the household's own
 * numbers where the plan is available. Education, not financial advice.
 */
export function PlaybookTab({ f }: { f: FireAnalysis | null }) {
  const p = f?.plan;
  const n = f?.now;
  const principles: Principle[] = [
    {
      id: "number",
      title: "1. Know your number",
      idea: (
        <>
          Financial independence is when what your money can pay you covers what you spend. The rule of thumb is <strong>25× annual spending</strong> — the inverse of a 4%
          withdrawal rate. At 3.5% it&apos;s about 28.6×; at 3% it&apos;s 33×. Spending, not income, sets the target.
        </>
      ),
      yours: n && p && (
        <>
          You spend about {short(n.livingCost)} a year. At {pct(p.withdrawalRate)} and after tax, your FIRE number is <strong>{usd(n.fireNumber)}</strong> ({n.multiple.toFixed(1)}× spending)
          — you&apos;re {pct(n.progress, 0)} of the way there.
        </>
      ),
    },
    {
      id: "rate",
      title: "2. Savings rate is the lever",
      idea: (
        <>
          How long it takes depends far more on the share of income you save than on how much you earn. Saving 10% means roughly 50 working years; 50% means about 17; 75% under
          10. Each dollar not spent works twice: it&apos;s invested, and it&apos;s a dollar you never need to replace in retirement.
        </>
      ),
      yours: f && (
        <>
          This year&apos;s plan saves {pct(f.savingsRate, 0)} of take-home + employer money. The Levers tab plots your years to FI at every savings rate.
        </>
      ),
    },
    {
      id: "swr",
      title: "3. The safe withdrawal rate",
      idea: (
        <>
          The 4% rule comes from studies of US market history (the Trinity study and Bengen): withdrawing 4% of the starting portfolio, raised with inflation, survived almost
          every 30-year period. Early retirees face 40–60 years, so many plan on <strong>3.25–3.5%</strong>. This app draws a fixed share of each year&apos;s net worth instead,
          which can never run out — the trade-off is that your income moves with markets.
        </>
      ),
      yours: p && (
        <>
          You plan to draw {pct(p.withdrawalRate)}. The Levers tab shows how the date moves between 3% and 5%.
        </>
      ),
    },
    {
      id: "flavors",
      title: "4. Pick your finish line",
      idea: (
        <>
          <strong>Lean FIRE</strong> retires on a frugal budget. <strong>Fat FIRE</strong> keeps a generous one. <strong>Coast FIRE</strong> means you&apos;ve saved enough that,
          with no new contributions, growth alone reaches your number by a normal retirement age — so you only need to earn your spending. <strong>Barista FIRE</strong> leaves the
          career for part-time work that fills the gap.
        </>
      ),
      yours: f && n && (
        <>
          Lean ({pct(LEAN_SHARE, 0)} of spending): {short(n.leanNumber)} · FIRE: {short(n.fireNumber)} · Fat ({pct(FAT_SHARE, 0)}): {short(n.fatNumber)}. Years for each are on the
          Overview.
        </>
      ),
    },
    {
      id: "sequence",
      title: "5. Sequence-of-returns risk",
      idea: (
        <>
          The same average return can end very differently depending on <em>when</em> the bad years land. A crash in the first five years of retirement, while you&apos;re
          withdrawing, does lasting damage. Common defenses: a year or two of spending in cash, a bond tent around the retirement date, cutting spending a little in down years
          (guardrails), or part-time income early on.
        </>
      ),
      yours: <>The Stress test tab reruns your plan through 1,000 random market paths.</>,
    },
    {
      id: "access",
      title: "6. Getting to your money before 59½",
      idea: (
        <>
          401(k)s and IRAs charge a 10% penalty before 59½, so early retirees plan a bridge: <strong>taxable brokerage</strong> money first; <strong>Roth contributions</strong>{" "}
          (not earnings) can come out any time; a <strong>Roth conversion ladder</strong> (convert traditional money each year, take it out five years later); <strong>72(t) SEPP</strong>{" "}
          equal payments; the <strong>Rule of 55</strong> for the 401(k) of the job you leave in or after the year you turn 55; and <strong>HSA</strong> receipts saved up for
          tax-free reimbursement.
        </>
      ),
      yours: p && (
        <>
          Today about {pct(p.start.liquid / Math.max(1, p.start.liquid + p.start.illiquid), 0)} of your net worth is liquid. Plan &amp; projection checks whether it lasts until 59½.
        </>
      ),
    },
    {
      id: "taxes",
      title: "7. Taxes get smaller after you stop",
      idea: (
        <>
          With no salary, early retirees often pay little tax: long-term gains and qualified dividends are taxed at 0% up to a fairly high income for married couples, the
          standard deduction covers the first slice, and low-income years are a chance to convert traditional money to Roth cheaply. This plan taxes every dollar drawn as
          ordinary income, so it&apos;s on the cautious side.
        </>
      ),
    },
    {
      id: "order",
      title: "8. Order of saving",
      idea: (
        <>
          The usual order: take the full employer match, max the HSA (triple tax-advantaged), max the 401(k), fund Roth IRAs (backdoor if income is too high), then invest in
          taxable accounts — which double as the pre-59½ bridge. Keep fund costs low; a 1% fee can cost years of retirement.
        </>
      ),
      link: { href: "/tax-accounts", label: "Account limits: room left this year" },
    },
    {
      id: "health",
      title: "9. Plan for health insurance",
      idea: (
        <>
          Leaving a job means leaving its health plan. Before Medicare at 65, early retirees typically buy ACA marketplace coverage, where premium credits depend on reported
          income — another reason to manage taxable income carefully. Budget for premiums and out-of-pocket costs in retirement living cost.
        </>
      ),
    },
    {
      id: "creep",
      title: "10. Watch lifestyle creep",
      idea: (
        <>
          Spending that grows faster than inflation quietly moves the target every year. FIRE planners tie spending growth to inflation and treat raises as savings, not new
          lifestyle.
        </>
      ),
      yours: p && (
        <>
          Your plan grows living cost {pct(p.livingGrowth)} a year against {pct(p.inflation)} inflation
          {p.livingGrowth > p.inflation + 1e-9 ? ` — ${pct(p.livingGrowth - p.inflation)} of creep a year. Levers shows what it costs.` : " — no creep."}
        </>
      ),
    },
    {
      id: "fu",
      title: "11. F-you money and runway",
      idea: (
        <>
          Long before full FI, a pile of liquid savings buys options: leave a bad job, take a sabbatical, start something. Count it in years of spending.
        </>
      ),
      yours: n && (
        <>
          Your liquid money covers about <strong>{n.liquidYears.toFixed(1)} years</strong> of living cost; everything you own, {n.yearsOfSpending.toFixed(1)} years.
        </>
      ),
    },
    {
      id: "enough",
      title: "12. Know when it's enough",
      idea: (
        <>
          &quot;One more year&quot; syndrome is common: the goal keeps moving once you&apos;re close. Decide in advance what enough looks like — a number, a buffer, a date —
          and what you&apos;re retiring <em>to</em>, not just from.
        </>
      ),
    },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <p className="text-sm text-fg-2">
          <strong className="text-fg">FIRE — financial independence, retire early</strong> — is the idea that by saving a large share of income and investing it in low-cost funds,
          you can reach the point where your investments cover your living costs decades before a normal retirement age, and work becomes optional. These are its core ideas,
          with your own numbers where the plan has them.
        </p>
        <p className="mt-2 text-[11px] text-muted">General education, not personalized financial, tax or investment advice. Rules and limits change; check current figures before acting.</p>
      </Card>
      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        {principles.map((x) => (
          <Card key={x.id} title={x.title}>
            <p className="text-[13px] leading-relaxed text-fg-2">{x.idea}</p>
            {x.yours && <p className="mt-2 rounded-md bg-accent-soft px-2.5 py-1.5 text-xs leading-snug text-fg">{x.yours}</p>}
            {x.link && (
              <Link href={x.link.href} className={`${btn.link} mt-2 inline-block`}>
                {x.link.label} →
              </Link>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
