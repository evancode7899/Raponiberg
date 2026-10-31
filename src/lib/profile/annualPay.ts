import type { PayDescriptor, PayLine } from "../book/proof/payProof.ts";
import type { PersonYear, YearProfile } from "./buildAnnualProfile.ts";

/**
 * A person's pay line on the annual statement, as its proof re-derives it: the stub's year
 * to date through the year's last cash day, or (a partner's merge year) the checks paid from
 * the merge on. The page and the proof sweep both build it here.
 */
export const annualPayDescriptor = (y: Pick<YearProfile, "year" | "asOf">, p: Pick<PersonYear, "personId" | "from">, line: PayLine): PayDescriptor =>
  p.from ? { report: "pay", basis: "paid", personId: p.personId, start: p.from, end: y.asOf, lines: [line] } : { report: "pay", basis: "ytd", personId: p.personId, year: y.year, through: y.asOf, lines: [line] };
