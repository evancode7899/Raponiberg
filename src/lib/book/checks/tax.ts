import { TAX_YEARS } from "../../tax/params.ts";
import { accountRef } from "../findingKeys.ts";
import type { Book } from "../load.ts";
import type { Collector } from "./collector.ts";

/**
 * The tax law the estimates need is in the app: this year's (to project it) and last
 * year's (to file it). Each January a new year's brackets, deductions, limits and
 * Connecticut tables have to be added; until they are, that year's taxes are withheld
 * with what to do, rather than estimated with another year's law.
 */
export function checkTaxParams(book: Book, c: Collector) {
  const year = Number(book.today.slice(0, 4));
  for (const y of [year - 1, year]) {
    if (TAX_YEARS[y]) {
      c.pass("tax.params", { subject: `${y} tax law`, from: `${y}-01-01`, to: `${y}-12-31`, affects: ["TAX"] });
      continue;
    }
    c.add({
      id: `tax.params:${y}`,
      check: "tax.params",
      status: "MISSING",
      title: `Tax law for ${y} isn't in the app yet`,
      detail: `The ${y} federal brackets, standard deduction, credits and contribution limits and the Connecticut tables haven't been added (the app has ${Object.keys(TAX_YEARS).join(", ")}), so ${y}'s taxes can't be estimated.`,
      fix: `Ask Claude to add the ${y} federal and Connecticut tax parameters (src/lib/tax/params.ts), from the IRS's and CT DRS's published ${y} figures.`,
      scope: { from: `${y}-01-01`, to: `${y}-12-31`, affects: ["TAX"] },
    });
  }
}

/**
 * Taxable investment accounts must have their year's tax figures (dividends, interest,
 * realized gains) on file for every year they were open; without them the year's
 * investment income — and so its taxes — can't be known.
 */
export function checkTaxCoverage(book: Book, c: Collector) {
  const currentYear = Number(book.today.slice(0, 4));
  for (const a of book.ledger.accounts) {
    if (a.subtype !== "BROKERAGE") continue;
    const ids = book.accounts.find((x) => x.id === a.id)?.identifiers ?? [];
    const facts = book.brokerage.filter((b) => ids.includes(b.accountNumber));
    const firstYear = Number(a.timeline.firstDay!.slice(0, 4));
    const lastYear = Math.min(currentYear, Number((a.closed ? a.timeline.lastDay! : book.today).slice(0, 4)));
    for (let y = firstYear; y <= lastYear; y++) {
      if (facts.some((b) => b.periodEnd.startsWith(String(y)) && b.income)) {
        c.pass("tax.brokerage-coverage", { subject: `${a.name}: ${y} investment income figures`, accountId: a.id, from: `${y}-01-01`, to: `${y}-12-31`, affects: ["TAX"] });
        continue;
      }
      c.add({
        id: `tax.brokerage-coverage:${accountRef(book, a.id).ref}:${y}`,
        accounts: accountRef(book, a.id).accounts,
        check: "tax.brokerage-coverage",
        status: "MISSING",
        title: `${a.name}: no ${y} investment income figures`,
        detail:
          facts.length === 0
            ? `None of this account's statements carry tax figures the app can read (only Fidelity and Vanguard brokerage statements are read for dividends, interest and gains today).`
            : `No statement dated in ${y} prints its year-to-date income.`,
        fix: facts.length === 0 ? `Reading ${a.institution ?? "this institution"}'s tax figures needs extractor support — ask Claude to add it.` : `Download the ${y} statements (ideally the year-end report).`,
        scope: { accountId: a.id, from: `${y}-01-01`, to: `${y}-12-31`, affects: ["TAX"] },
      });
    }
  }
}
