import { TAX_YEARS } from "../../tax/params.ts";
import { money } from "../coverage.ts";
import { accountRef } from "../findingKeys.ts";
import type { Book } from "../load.ts";
import { chetYear, iraYear, type CustodianTie } from "../taxAdvantaged.ts";
import type { FindingScope } from "../types.ts";
import type { Collector } from "./collector.ts";

/**
 * An IRA's or a 529's statements print what was contributed this year; the ledger has the
 * deposits themselves. Both are read from the same statements by different code (the
 * statement's summary line, its rows), so they must agree. When they don't, the year's
 * contributions (IRA limits, the Connecticut 529 deduction) rest on one side only: the
 * year's tax figures are withheld until the misread is fixed or explained.
 */
export function checkCustodianContributions(book: Book, c: Collector) {
  const currentYear = Number(book.today.slice(0, 4));
  const years = Object.keys(TAX_YEARS).map(Number).filter((y) => y <= currentYear);
  for (const year of years) {
    const ties: CustodianTie[] = [...book.persons.flatMap((p) => iraYear(book, p.id, year).custodian), ...chetYear(book, year).custodian];
    for (const t of ties) {
      const scope: FindingScope = { accountId: t.accountId, from: `${year}-01-01`, to: t.through, affects: ["TAX"] };
      const subject = `${t.name}: ${year} contributions`;
      if (t.statement === t.ledger) {
        c.pass("contributions.custodian", { subject, ...scope });
        continue;
      }
      const { ref, accounts } = accountRef(book, t.accountId);
      c.add({
        id: `contributions.custodian:${ref}:${year}`,
        accounts,
        check: "contributions.custodian",
        status: "FAIL",
        title: `${subject}: the statements say ${money(t.statement)}, the ledger's deposits ${money(t.ledger)}`,
        detail: `The custodian's contributions-this-year line (through ${t.through}) and the deposits the ledger shows into the account differ by ${money(Math.abs(t.statement - t.ledger))}. One side was misread, or a deposit is missing from the rows.`,
        fix: "Compare the statements' contributions line with the account's rows on Transactions. A row read wrong is a bug in the statement reader; a contribution the custodian books differently (a prior-year contribution made this year) belongs in an exception with a note.",
        scope,
      });
    }
  }
}
