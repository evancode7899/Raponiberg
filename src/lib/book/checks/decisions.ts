import { addDays } from "../../dates/isoDate.ts";
import { sameLeg, type LegFingerprint } from "../../transfers/decisionStore.ts";
import { money } from "../coverage.ts";
import type { Book, BookRow } from "../load.ts";
import type { Collector } from "./collector.ts";

/**
 * The owner's saved transfer decisions (data/transfer-decisions.json) are in force: every
 * pairing they confirmed is paired in the ledger, and no pairing they rejected is. A
 * decision is re-applied on every refresh by the facts that identify its legs (account,
 * date, amount); when a leg can't be found, or matches more than one row, it silently
 * waits — this check says so, and why, instead of letting a settled question reopen
 * without explanation.
 */
export function checkDecisions(book: Book, c: Collector) {
  const firstDay = book.ledger.firstDay ?? book.today;
  if ("error" in book.decisions) {
    c.add({
      id: "transfer.decisions:file",
      check: "transfer.decisions",
      status: "FAIL",
      title: "Your saved transfer decisions can't be read",
      detail: book.decisions.error,
      fix: "Restore data/transfer-decisions.json from the journal beside it (each line is one decision as it was made), then refresh.",
      scope: { from: firstDay, to: book.today, affects: ["CASH_FLOW", "NET_WORTH"] },
    });
    return;
  }

  // Each Book row as a decision would identify it.
  const amounts = new Set([...book.decisions.confirmed, ...book.decisions.rejected].flatMap((d) => d.legs.map((l) => l.amountCents)));
  const accountOf = new Map(book.accounts.map((a) => [a.id, a]));
  const rows = book.rows
    .filter((r) => amounts.has(r.amountCents))
    .map((r) => ({ row: r, fp: { institution: accountOf.get(r.accountId)?.institution ?? "", identifiers: accountOf.get(r.accountId)?.identifiers ?? [], date: r.date, amountCents: r.amountCents } }));
  const hits = (leg: LegFingerprint) => rows.filter((x) => sameLeg(leg, x.fp)).map((x) => x.row);
  const describe = (leg: LegFingerprint) => `${leg.date} ${money(leg.amountCents)} (${leg.institution} ••${leg.identifiers[0]?.slice(-4) ?? "?"})`;
  const keyOf = (legs: LegFingerprint[]) =>
    legs
      .map((l) => `${l.institution.trim().toUpperCase()}#${[...l.identifiers].sort()[0] ?? "?"}:${l.date}:${l.amountCents}`)
      .sort()
      .join("+");
  const scopeOf = (legs: LegFingerprint[]) => {
    const dates = legs.map((l) => l.date).sort();
    return { from: addDays(dates[0] ?? book.today, -3), to: addDays(dates.at(-1) ?? book.today, 3), affects: ["CASH_FLOW" as const, "NET_WORTH" as const] };
  };
  const pairedTogether = (rs: BookRow[]) => rs.length > 1 && rs[0]!.transferMatchId != null && rs.every((r) => r.transferMatchId === rs[0]!.transferMatchId);

  for (const d of book.decisions.confirmed) {
    const found = d.legs.map((leg) => ({ leg, rows: hits(leg) }));
    const label = d.legs.map(describe).join(" ↔ ");
    const missing = found.filter((f) => f.rows.length === 0);
    const ambiguous = found.filter((f) => f.rows.length > 1);
    const rs = found.map((f) => f.rows[0]).filter((r): r is BookRow => !!r);
    const match = rs[0]?.transferMatchId ? book.matches.find((m) => m.id === rs[0]!.transferMatchId) : undefined;
    if (!missing.length && !ambiguous.length && pairedTogether(rs) && match?.status === "CONFIRMED") {
      c.pass("transfer.decisions", { subject: `Your confirmed pairing ${label}`, ...scopeOf(d.legs) });
      continue;
    }
    const why = missing.length
      ? `${missing.map((f) => describe(f.leg)).join(" and ")} isn't on any statement in the ledger (removed, re-read with a different date or amount, or held for review)`
      : ambiguous.length
        ? `${ambiguous.map((f) => `${describe(f.leg)} matches ${f.rows.length} rows`).join("; ")}, so it can't tell which one you meant`
        : "the rows are on file but aren't paired together — the ledger hasn't been refreshed since they were imported";
    c.add({
      id: `transfer.decisions:confirmed:${keyOf(d.legs)}`,
      check: "transfer.decisions",
      status: "FAIL",
      title: `Your confirmed pairing ${label} isn't applied`,
      detail: `You confirmed it on ${d.confirmedAt.slice(0, 10)}${d.note ? ` ("${d.note}")` : ""}, but ${why}.`,
      fix: missing.length || ambiguous.length
        ? "Check the statements for those dates in Statements → Documents; once both legs are on file once each, the pairing re-applies itself."
        : "Refresh the ledger (Settings → Data → Re-run classifier) and it re-applies itself.",
      scope: scopeOf(d.legs),
    });
  }

  for (const d of book.decisions.rejected) {
    const rs = d.legs.map((leg) => hits(leg));
    if (rs.some((x) => x.length !== 1) || !pairedTogether(rs.map((x) => x[0]!))) {
      c.pass("transfer.decisions", { subject: `Your rejected pairing ${d.legs.map(describe).join(" ↔ ")} stays unpaired`, ...scopeOf(d.legs) });
      continue;
    }
    c.add({
      id: `transfer.decisions:rejected:${keyOf(d.legs)}`,
      check: "transfer.decisions",
      status: "FAIL",
      title: `A pairing you rejected is paired again: ${d.legs.map(describe).join(" ↔ ")}`,
      detail: `You rejected it on ${d.rejectedAt.slice(0, 10)}, but the ledger pairs those rows.`,
      fix: "Refresh the ledger (Settings → Data → Re-run classifier); if it's still paired, unpair it on Review → Transfers.",
      scope: scopeOf(d.legs),
    });
  }
}
