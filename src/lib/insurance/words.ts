/**
 * Words back into text that a PDF printed without its spaces. State Farm's declarations
 * place every word by position, so their extracted text reads "DamagetothePropertyofOthers"
 * and "$500peroccurrence". The capitals, digits and punctuation give most word breaks; a
 * run of lowercase letters is split only when the insurance words below spell all of it,
 * and is otherwise left as printed rather than guessed at.
 */

const WORDS = new Set(
  (
    "additional address aid alarm alert all amendatory amount and attached auto available backup bank bed bugs building card " +
    "charge claim condominium cost counterfeit cov coverage coverages credit customer damage debris deductible department devices discount drain dwelling " +
    "each earthquake endorsement expenses extension fire firearms first for forgery form fuel fund fungus furs home homeowners identity incl " +
    "including index inflation item jewelry landscaping law liab liability limited line locks loss losses loyal medical mold money multiple new " +
    "occurrence of oil or ordinance others payments per person personal policy property protection protective rating record release " +
    "removal remote renters replacement restoration reward roof section service sewer shrubs silverware systems the to transfer trees unitowners " +
    "use utility water with"
  ).split(" "),
);
const LONGEST = Math.max(...[...WORDS].map((w) => w.length));

/** A run of letters as dictionary words, or null when they don't spell all of it. Fewest words wins ("others", not "other s"). */
export function segment(run: string): string[] | null {
  const s = run.toLowerCase();
  const best: (string[] | null)[] = [[]];
  for (let i = 1; i <= s.length; i++) {
    best[i] = null;
    for (let j = Math.max(0, i - LONGEST); j < i; j++) {
      const prev = best[j];
      if (!prev || !WORDS.has(s.slice(j, i))) continue;
      if (!best[i] || prev.length + 1 < best[i]!.length) best[i] = [...prev, s.slice(j, i)];
    }
  }
  return best[s.length] ?? null;
}

/** One word as printed, split into dictionary words when it is several, its capital kept. */
function spaceWord(w: string): string {
  const parts = segment(w);
  if (parts && parts.length > 1) {
    const out = parts.join(" ");
    return w[0] === w[0]!.toUpperCase() ? out[0]!.toUpperCase() + out.slice(1) : out;
  }
  // A coverage letter run into its word ("Bamount": Coverage B's amount).
  if (!parts && /^[A-Z][a-z]{2,}$/.test(w) && segment(w.slice(1))) return `${w[0]} ${spaceWord(w.slice(1))}`;
  return w;
}

/**
 * Text printed without spaces, spaced: "DamagetothePropertyofOthers" → "Damage to the Property
 * of Others", "Fungus(InclMold)LimitedCov" → "Fungus (Incl Mold) Limited Cov",
 * "10%ofCoverageBamount/$750peritem" → "10% of Coverage B amount / $750 per item".
 */
export function spaced(text: string): string {
  const broken = text
    // a lowercase letter before a capital, a letter before a digit or "$", a digit or "%" before a letter
    .replace(/([a-z])(?=[A-Z])/g, "$1 ")
    .replace(/([A-Za-z])(?=[\d$])/g, "$1 ")
    .replace(/([\d%])(?=[A-Za-z])/g, "$1 ")
    // punctuation: a space after a comma, around brackets and slashes
    .replace(/,(?=[^\s\d])/g, ", ")
    .replace(/([a-z])-(?=[A-Z])/g, "$1 - ")
    .replace(/\s*\(\s*/g, " (")
    .replace(/\s*\)(?=\S)/g, ") ")
    .replace(/\s*\/\s*/g, " / ")
    .trim();
  return broken
    .split(/(\s+)/)
    .map((tok) => tok.replace(/[A-Za-z]+/g, spaceWord))
    .join("")
    .replace(/^\(\s*/, "(")
    .replace(/\s+/g, " ");
}

/** Every dollar amount in a string, whole or with cents ("$25,000/$50,000" → [2_500_000, 5_000_000]). */
export function dollarAmounts(s: string): number[] {
  return [...s.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/g)].map((m) => Number(m[1]!.replace(/,/g, "")) * 100 + Number(m[2] ?? 0));
}

/** Title case for names printed in capitals ("PAT EXAMPLE" → "Pat Example"). */
export const titleCase = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s);

/** Business words at the end of a name printed in capitals without spaces ("…INSAGENCYINC" → "… INS AGENCY INC"). */
const BUSINESS = ["INSURANCE", "AGENCY", "INS", "INC", "LLC", "CORP", "GROUP", "AGCY", "CO"];
export function spacedName(name: string): string {
  let rest = name.trim();
  const tail: string[] = [];
  for (let found = true; found; ) {
    found = false;
    for (const w of BUSINESS) {
      if (rest.length > w.length + 2 && rest.endsWith(w)) {
        tail.unshift(w);
        rest = rest.slice(0, -w.length).trimEnd();
        found = true;
        break;
      }
    }
  }
  return [rest.replace(/,(?=\S)/g, ", "), ...tail].join(" ");
}

/**
 * A street line printed without spaces: "12ELMBLVDAPT4" → "12 ELM BLVD APT 4". A street word
 * is split off only where a unit number (or another street word and its number) follows, so
 * a name that merely contains one ("ANDREWS") is left whole.
 */
const STREET = "BLVD|AVE|APT|UNIT|SUITE|STE|RD|DR|LN|PKWY|HWY|PL|TER|CT|WAY|FL";
export function spacedStreet(line: string): string {
  const re = new RegExp(`(?<=[A-Z])(${STREET})(?=\\d|(?:${STREET})\\d)`, "g");
  return line
    .trim()
    .replace(/^(\d+)(?=[A-Z])/, "$1 ")
    .replace(re, " $1")
    .replace(new RegExp(`(${STREET})(?=\\d)`, "g"), "$1 ")
    .replace(/\s+/g, " ");
}

/** A city line printed without spaces: "SPRINGFIELDIL62701-1234" → "SPRINGFIELD IL 62701-1234". */
export const spacedCity = (line: string) =>
  line
    .trim()
    .replace(/\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)$/, " $1 $2")
    .trim();
