import { buildTaxReport } from "../../tax/buildTaxReport.ts";
import { yearDocs } from "../../tax/documents.ts";
import { documentTies } from "../../tax/filedCheck.ts";
import { TAX_YEARS } from "../../tax/params.ts";
import { money } from "../coverage.ts";
import type { Book } from "../load.ts";
import type { FindingScope } from "../types.ts";
import type { Collector } from "./collector.ts";

/**
 * A finished year's tax documents against the ledger, figure by figure (tax/filedCheck.ts
 * documentTies): W-2 boxes against the pay stubs, 1099s against the statements, 1099-INTs
 * against the bank's interest rows, and the filed return's payments against the bank. The
 * tax report treats a finished year's documents as its figures of record, so a document
 * that disagrees with the ledger — or that nothing in the ledger can corroborate — would
 * otherwise win silently. Here the disagreement is a failure and the uncorroborated
 * document missing data, each withholding that year's tax figures (and, for a W-2, its pay).
 *
 * The year's report is built for the comparison only, before any finding exists, so the
 * figures compared are the raw ones on both sides.
 */
export function checkTaxDocuments(book: Book, c: Collector) {
  const currentYear = Number(book.today.slice(0, 4));
  const years = [...new Set((book.taxDocs?.docs ?? []).map((d) => d.year).filter((y): y is number => y != null))].filter((y) => y < currentYear && TAX_YEARS[y]).sort();
  for (const year of years) {
    const docs = yearDocs(book.taxDocs, year, book.taxProfile.persons);
    if (!docs.w2s.length && !docs.brokerage.length && !docs.ints.length && !docs.federal && !docs.ct) continue;
    const report = buildTaxReport(book, year, { estimatePriorYear: false, birthYears: {} });
    if (report.blocked) continue;
    // Statements never print the qualified share of dividends: the ledger side of that line
    // is the app's estimate, so it's no contradiction (the Filed return tab still shows it).
    for (const s of documentTies(report, docs).filter((x) => !/qualified dividends/.test(x.label))) {
      const pay = /W-2/.test(s.label);
      const scope: FindingScope = { from: `${year}-01-01`, to: `${year}-12-31`, affects: pay ? ["PAY", "TAX"] : ["TAX"] };
      const subject = `${s.label} (${s.document})`;
      if (s.status === "MATCH") {
        c.pass("tax.documents-tie", { subject, ...scope });
        continue;
      }
      const missing = s.status === "LEDGER_MISSING";
      c.add({
        id: `tax.documents-tie:${year}:${s.label}`,
        check: "tax.documents-tie",
        status: missing ? "MISSING" : "FAIL",
        title: missing ? `${year}: ${s.label} is on ${s.document} only` : `${year}: ${s.label} differs from the ledger by ${money(Math.abs(s.documentValue - (s.ledgerValue ?? 0)))}`,
        detail: missing
          ? `${s.document} prints ${money(s.documentValue)}, and nothing in the ledger can confirm it${s.note ? `: ${s.note}` : "."}`
          : `${s.document} prints ${money(s.documentValue)}; the ledger shows ${money(s.ledgerValue ?? 0)}.${s.note ? ` ${s.note}` : ""}`,
        fix: missing
          ? "Add the pay stubs or statements this document covers, or accept it as an exception (Statements → Issues) with a note on why it can't be corroborated."
          : "One side was read wrong or is incomplete: check the document in the tax documents folder against the stubs or statements (Taxes → Filed return lists both). A payment from an account the app doesn't track belongs in an exception with a note.",
        scope,
      });
    }
  }
}
