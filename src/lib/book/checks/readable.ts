import type { Book } from "../load.ts";
import type { Collector } from "./collector.ts";

/**
 * Every saved setting and data file the figures read could be read (Book.unreadable). A
 * damaged one stands in as its defaults or as nothing, so each is a failure over every day
 * the ledger covers, for every kind of figure it could change (load.ts says which).
 */
export function checkReadable(book: Book, c: Collector) {
  const from = book.ledger.firstDay ?? book.today;
  for (const u of book.unreadable ?? [])
    c.add({
      id: `data.readable:${u.source}`,
      check: "data.readable",
      status: "FAIL",
      title: `${u.what} can't be read`,
      detail: u.error,
      fix: u.fix,
      scope: { from, to: book.today, affects: [...u.affects] },
    });
}
