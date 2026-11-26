import type { HomeSummary } from "@/lib/dashboard/homeSummary";

type Named = { name: string; descriptor: object; shownCents: number | null };

/**
 * The figures the command line finds by name: the Dashboard's headline figures, each with the
 * recipe of its proof (lib/dashboard/homeSummary.ts). The line shows only the name; picking one
 * opens its proof, which shows the number and whether it cleared.
 */
export function figuresOfSummary(s: Pick<HomeSummary, "netWorth" | "cashFlow">): Named[] {
  const out: Named[] = [];
  const add = (name: string, descriptor: object | null | undefined, cents: number | null | undefined) => {
    if (descriptor) out.push({ name, descriptor, shownCents: cents ?? null });
  };
  const nw = s.netWorth;
  if (nw.proofs) {
    add("Net worth", nw.proofs.total, nw.totalCents);
    add("Assets", nw.proofs.assets, nw.assetsCents);
    add("Debts", nw.proofs.debts, nw.debtsCents);
    add("Liquid (cash on hand)", nw.proofs.liquid, nw.liquidCents);
  }
  const ch = nw.change;
  if ("proof" in ch.month) add("Net worth change, last month", ch.month.proof, ch.month.cents);
  if ("proof" in ch.year) add("Net worth change, 12 months", ch.year.proof, ch.year.cents);
  if ("proof" in ch.ytd) add(`Net worth change, ${ch.ytdYear} so far`, ch.ytd.proof, ch.ytd.cents);
  if (nw.drivers) {
    add("Saved from pay, 12 months", nw.drivers.proofs.principal, nw.drivers.principalCents);
    add("Market growth, 12 months", nw.drivers.proofs.growth, nw.drivers.growthCents);
  }
  for (const g of nw.groups) add(`${g.group} balance`, g.proof, g.cents);
  const cf = s.cashFlow;
  if (cf.last12) {
    add("Income, 12 months", cf.last12.proofs.income, cf.last12.incomeCents);
    add("Spending, 12 months", cf.last12.proofs.spending, cf.last12.spendingCents);
    add("Saved, 12 months", cf.last12.proofs.net, cf.last12.netCents);
  }
  if (cf.lastMonth) add(`Spending, ${cf.lastMonth.label}`, cf.lastMonth.proof, cf.lastMonth.spendingCents);
  for (const c of cf.categories) {
    if (c.totalProof) add(`${c.category} spending, 12 months`, c.totalProof, c.totalCents);
    if (c.proof && cf.lastMonth) add(`${c.category} spending, ${cf.lastMonth.label}`, c.proof, c.lastMonthCents);
  }
  return out;
}
