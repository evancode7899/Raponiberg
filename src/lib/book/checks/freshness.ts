import { CLASSIFIER_VERSION } from "../../classifier/version.ts";
import { FACT_PARSERS, FACTS_VERSION, PAYSTUB_PARSERS, TAX_FACT_PARSERS } from "../../ingest/factsVersion.ts";
import { PARSER_VERSIONS } from "../../ingest/parsers/index.ts";
import type { Book, BookDocument } from "../load.ts";
import type { FindingScope } from "../types.ts";
import type { Collector } from "./collector.ts";

/**
 * Everything in the Book was read and filed by the app's current code. A parser or
 * extractor fix reaches only the documents read after it, and a rule change only the rows
 * classified after it; until the stored data is refreshed, figures built from it aren't
 * what the current code would produce, so they're withheld with what to run:
 *
 *  - documents read by an older version of their parser (re-import them);
 *  - pay stub and brokerage tax facts read by an older extractor (re-read on the next
 *    refresh, automatically);
 *  - rows filed by older classification rules (re-run on the next refresh).
 */
export function checkFreshness(book: Book, c: Collector) {
  const firstDay = book.ledger.firstDay ?? book.today;
  const span = (docs: BookDocument[]) => {
    const starts = docs.map((d) => d.periodStart ?? d.periodEnd).filter((d): d is string => !!d).sort();
    const ends = docs.map((d) => d.periodEnd ?? d.periodStart).filter((d): d is string => !!d).sort();
    return { from: starts[0] ?? firstDay, to: ends.at(-1) ?? book.today };
  };
  const affects = (parserId: string): FindingScope["affects"] =>
    PAYSTUB_PARSERS.includes(parserId) ? ["PAY", "TAX"] : TAX_FACT_PARSERS.includes(parserId) ? ["CASH_FLOW", "NET_WORTH", "TAX"] : ["CASH_FLOW", "NET_WORTH"];
  const titles = (docs: BookDocument[]) => `${docs.slice(0, 3).map((d) => d.title).join(", ")}${docs.length > 3 ? ` and ${docs.length - 3} more` : ""}`;

  // Documents read by an older parser. Supporting documents carry no figures; hand-parsed
  // ("manual") ones have no parser to be outdated by.
  const outdated = new Map<string, BookDocument[]>();
  for (const d of book.documents) {
    const current = PARSER_VERSIONS[d.parserId];
    if (current == null || d.parserId === "supporting-document") continue;
    if (d.parserVersion >= current) continue;
    outdated.set(d.parserId, [...(outdated.get(d.parserId) ?? []), d]);
  }
  for (const [parserId, docs] of outdated) {
    const current = PARSER_VERSIONS[parserId]!;
    c.add({
      id: `ledger.freshness:parser:${parserId}:v${current}`,
      check: "ledger.freshness",
      status: "FAIL",
      title: `${docs.length} document(s) were read by an older ${parserId} parser`,
      detail: `They were read by version ${Math.min(...docs.map((d) => d.parserVersion))} of the parser; the app now has version ${current}, which reads them differently: ${titles(docs)}.`,
      fix: "Click Scan statements folder (Statements → Import) or restart the app: they're read again from the statements folder, keeping your decisions and exceptions. A file no longer in the folder has to be put back first.",
      scope: { ...span(docs), affects: affects(parserId) },
    });
  }
  if (outdated.size === 0) c.pass("ledger.freshness", { subject: `Every document read by its current parser`, from: firstDay, to: book.today, affects: ["CASH_FLOW", "NET_WORTH", "PAY", "TAX"] });

  // Facts read by an older extractor.
  const staleFacts = book.documents.filter((d) => FACT_PARSERS.includes(d.parserId) && d.factsVersion < FACTS_VERSION && !outdated.has(d.parserId));
  if (staleFacts.length === 0) c.pass("ledger.freshness", { subject: `Pay stub, tax and holdings figures from the current extractor`, from: firstDay, to: book.today, affects: ["CASH_FLOW", "PAY", "TAX"] });
  else
    c.add({
      id: `ledger.freshness:facts:v${FACTS_VERSION}`,
      check: "ledger.freshness",
      status: "FAIL",
      title: `${staleFacts.length} document(s) hold pay stub, tax or holdings figures from an older extractor`,
      detail: `Their figures were read by version ${Math.min(...staleFacts.map((d) => d.factsVersion))} of the extractor; the app now has version ${FACTS_VERSION}: ${titles(staleFacts)}.`,
      fix: "Refresh the ledger — Settings → Data → Re-run classifier, or scan the statements folder — and they're re-read from the stored files.",
      scope: {
        ...span(staleFacts),
        // Pay stub facts feed pay and taxes; brokerage tax figures feed taxes and dividend
        // income; holdings alone (the Investments page) withhold none of these.
        affects: [
          ...(staleFacts.some((d) => PAYSTUB_PARSERS.includes(d.parserId)) ? (["PAY"] as const) : []),
          ...(staleFacts.some((d) => PAYSTUB_PARSERS.includes(d.parserId) || TAX_FACT_PARSERS.includes(d.parserId)) ? (["TAX"] as const) : []),
          ...(staleFacts.some((d) => TAX_FACT_PARSERS.includes(d.parserId)) ? (["CASH_FLOW"] as const) : []),
        ],
      },
    });

  // Rows filed by older classification rules. Lanes and categories decide cash flow, pay
  // and taxes; balances (net worth) don't depend on them.
  const rulesCurrent = (book.classifiedWith ?? 0) >= CLASSIFIER_VERSION;
  const householdCurrent = (book.classifiedWithHousehold ?? "") === book.household.fingerprint;
  if ((rulesCurrent && householdCurrent) || book.rows.length === 0)
    c.pass("ledger.freshness", { subject: `Transactions filed by the current classification rules and household file`, from: firstDay, to: book.today, affects: ["CASH_FLOW", "PAY", "TAX"] });
  else if (rulesCurrent)
    c.add({
      id: `ledger.freshness:household:${book.household.fingerprint || "none"}`,
      check: "ledger.freshness",
      status: "FAIL",
      title: "Transactions were filed before the household file changed",
      detail:
        "data/household.json (the household's names, partner accounts, funds and local merchants) changed after the rows were last filed, so some rows may sit in a lane or category it would now change.",
      fix: "Settings → Data → Re-run classifier (or scan the statements folder). Rows you corrected by hand are kept.",
      scope: { from: firstDay, to: book.today, affects: ["CASH_FLOW", "PAY", "TAX"] },
    });
  else
    c.add({
      id: `ledger.freshness:rules:v${CLASSIFIER_VERSION}`,
      check: "ledger.freshness",
      status: "FAIL",
      title: "Transactions were filed by older classification rules",
      detail:
        book.classifiedWith == null
          ? `The ledger hasn't been refreshed since the app began recording which rules filed it (now version ${CLASSIFIER_VERSION}), so some rows may sit in a lane or category the current rules would change.`
          : `The rows were filed by version ${book.classifiedWith} of the rules; the app now has version ${CLASSIFIER_VERSION}, so some rows may sit in a lane or category the current rules would change.`,
      fix: "Settings → Data → Re-run classifier (or scan the statements folder). Rows you corrected by hand are kept.",
      scope: { from: firstDay, to: book.today, affects: ["CASH_FLOW", "PAY", "TAX"] },
    });
}
