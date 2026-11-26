/**
 * How the Dashboard's panels link (components/ui/Panel.tsx): a row is about a category or a
 * month when the page it opens says so in its address (?category=Dining, ?from=2031-05-01).
 * Picking such a row narrows every other panel's rows to the same category or month, where
 * they have any. Read off what the rows already link to: no panel says it twice.
 */
export type DeskLink = { kind: "category" | "month"; value: string };

/** What a row's link is about, from the address it opens. */
export function linkOf(href: string | null | undefined): DeskLink | null {
  if (!href) return null;
  const q = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
  const sp = new URLSearchParams(q);
  const category = sp.get("category");
  if (category) return { kind: "category", value: category };
  const from = sp.get("from") ?? sp.get("start") ?? sp.get("month");
  if (from && /^\d{4}-\d{2}/.test(from)) return { kind: "month", value: from.slice(0, 7) };
  return null;
}

export const sameLink = (a: DeskLink | null, b: DeskLink | null) => !!a && !!b && a.kind === b.kind && a.value === b.value;

/**
 * Which of a panel's rows show while a link is picked: all of them when none is picked, or
 * when none of its rows is about that kind of thing; otherwise only the matching ones.
 */
export function rowsShown(rows: readonly (DeskLink | null)[], pick: DeskLink | null): boolean[] {
  if (!pick || !rows.some((r) => r?.kind === pick.kind)) return rows.map(() => true);
  return rows.map((r) => sameLink(r, pick));
}

/** Rows a panel's own command line keeps: those whose words hold every word typed. */
export function rowsMatching(texts: readonly string[], typed: string): boolean[] {
  const words = typed.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return texts.map((t) => words.every((w) => t.toLowerCase().includes(w)));
}
