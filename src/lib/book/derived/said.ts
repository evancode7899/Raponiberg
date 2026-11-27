import type { Amount } from "../said.ts";
import { c, ln, r, type DerivedFigure } from "./types.ts";

/**
 * The amounts written into sentences (lib/book/said.ts) as derived figures ("amount", keyed
 * by the amount's own key): each at the value the sentence prints, worked out from the lines
 * the sayer recorded (a sum re-adds them; one line is the document it was read from).
 * Several sentences may print one amount: it's listed once.
 */
export function amountFigures(amounts: Iterable<Amount>): DerivedFigure[] {
  const seen = new Map<string, DerivedFigure>();
  for (const a of amounts) {
    if (seen.has(a.key)) continue;
    const value = "cents" in a.value ? c(a.value.cents) : r(a.value.ratio);
    const lines = a.lines?.length
      ? [
          // A line taken away is drawn as "−" and its size (the chain's convention); the first line may be one.
          ...a.lines.map((l, i) => ln(l.label, c(Math.abs(l.cents)), l.cents < 0 ? "−" : i ? "+" : undefined, { source: "proven", ...(l.link ? { link: l.link } : {}) })),
          ...(a.lines.length > 1 ? [ln(a.describes[0]!.toUpperCase() + a.describes.slice(1), value, "=")] : []),
        ]
      : [ln(a.describes[0]!.toUpperCase() + a.describes.slice(1), value)];
    seen.set(a.key, { figure: "amount", key: a.key, describes: a.describes, value, lines });
  }
  return [...seen.values()];
}
