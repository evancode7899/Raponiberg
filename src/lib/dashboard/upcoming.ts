import { cardPerksDerived, perkKey } from "../book/derived/cardPerks.ts";
import { insuranceDerived } from "../book/derived/insurance.ts";
import { derivedTarget } from "../book/derived/types.ts";
import { unswept } from "../book/proof/clearance.ts";
import type { CardPerksPage } from "../cardPerks/page.ts";
import { addDays } from "../dates/isoDate.ts";
import { upcomingDates } from "../insurance/cover.ts";
import type { InsurancePage } from "../insurance/page.ts";
import type { BriefingDue } from "./briefing.ts";

/** How far ahead a card credit's close and a policy's date are worth a line. */
export const CREDIT_DAYS = 31;
export const POLICY_DAYS = 120;

/**
 * The Dashboard's Next up beyond the calendar: card credits about to close with money left in
 * them, and insurance premiums, renewals and dates. As the Card perks and Insurance pages list
 * them, each amount with that page's proof. Credits never used all year stay on the page.
 */
export function upcomingDue(perks: Pick<CardPerksPage, "act" | "year" | "totals" | "cards">, insurance: InsurancePage): BriefingDue[] {
  const out: BriefingDue[] = [];
  const credits = cardPerksDerived(perks);
  for (const a of perks.act) {
    if (a.neverUsed || a.leftCents <= 0 || a.daysLeft < 0 || a.daysLeft > CREDIT_DAYS) continue;
    out.push({
      id: `credit:${a.accountId}|${a.perkId}`,
      date: a.ends,
      title: `Use ${a.name}`,
      cents: a.leftCents,
      kind: "credit",
      href: "/card-perks",
      done: false,
      perPaycheck: false,
      detail: `${a.card}. ${a.how}`,
      proof: derivedTarget("card-perks", credits, "act", perkKey(perks.year, a.accountId, a.perkId, "left")),
    });
  }
  const policies = insuranceDerived(insurance);
  const until = addDays(insurance.today, POLICY_DAYS);
  for (const d of upcomingDates(insurance)) {
    if (d.date > until) continue;
    // Only a premium due states an amount: the policy's own.
    const due = d.line === "LIFE" ? insurance.policies.find((v) => v.policy.policyNumber === d.key && v.nextDue?.date === d.date && d.label.startsWith("Premium due"))?.nextDue : undefined;
    out.push({
      id: `policy:${d.line}:${d.key}:${d.date}:${d.label}`,
      date: d.date,
      title: `${d.insurer}: ${d.label.charAt(0).toLowerCase()}${d.label.slice(1)}`,
      cents: due?.cents ?? null,
      kind: "policy",
      href: `/insurance?tab=${d.line.toLowerCase()}`,
      done: false,
      perPaycheck: false,
      dateOnly: !due,
      detail: `${d.line === "LIFE" ? "Life" : d.line === "HOME" ? "Home" : "Auto"} policy, from its documents.`,
      proof: due ? derivedTarget("insurance", policies, "next-due", d.key) : unswept("no amount"),
    });
  }
  return out.sort((x, y) => x.date.localeCompare(y.date));
}
