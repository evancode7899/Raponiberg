import { accountAliases, withoutAccount } from "./findingKeys.ts";
import type { Book } from "./load.ts";
import type { IntegrityReport, StandingException } from "./types.ts";

type Keyed = { id: string; accounts?: string[] };

/**
 * Whether an accepted exception covers a finding: the same id, or the same id but for an
 * account that was reissued under another number (the two share an identifier).
 */
export function exceptionMatches(ex: Keyed, f: Keyed): boolean {
  if (ex.id === f.id) return true;
  if (!ex.accounts?.length || !f.accounts?.length) return false;
  return withoutAccount(ex.id) === withoutAccount(f.id) && ex.accounts.some((a) => f.accounts!.includes(a));
}

/** Every dollar amount some words state, in order ("$1,234.56", "−$50.00"). */
const amounts = (text: string): string[] => text.match(/[−-]?\$[\d,]+(?:\.\d+)?/g) ?? [];
/** Checks whose finding ids already hold the amount (bonus/letterFindings bonusFindingId: `…|gapCents`). */
const ID_HOLDS_AMOUNT = new Set<string>(["bonus.letters"]);
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Whether a finding is still the one the owner accepted: the same status and the same
 * amounts. Ids carry no amount (a month's net worth not reconciling, a W-2 box that
 * differs), so a $3 gap accepted by id would otherwise go on covering it once it's $30,000.
 * The title's amounts are compared always; the detail's when the snapshot's detail states
 * any (an exception carried over from an older store kept only a note there). Null when
 * it's unchanged; else what changed, in plain words.
 */
export function exceptionDrift(ex: Pick<StandingException, "finding" | "check">, f: { status: string; title: string; detail: string }): string | null {
  // A bonus letter's finding id already holds its gap (a changed gap is a new finding).
  if (ID_HOLDS_AMOUNT.has(ex.check)) return null;
  if (ex.finding.status !== f.status) return `it was ${ex.finding.status === "FAIL" ? "a failure" : "missing data"} when you accepted it`;
  const wasDetail = amounts(ex.finding.detail);
  if (same(amounts(ex.finding.title), amounts(f.title)) && (!wasDetail.length || same(wasDetail, amounts(f.detail)))) return null;
  return `you accepted it when it read “${ex.finding.title}”`;
}

const overlaps = (aFrom: string, aTo: string, bFrom: string, bTo: string) => aFrom <= bTo && bFrom <= aTo;

/**
 * Why an exception's finding no longer arises, in plain words, from what the Book holds
 * now: the figure is proven another way, the problem changed shape, or documents
 * imported since it was accepted cover it. When none of those explain it, says so — the
 * check itself changed — so the owner never retires an exception on a guess.
 */
export function staleEvidence(book: Book, report: Pick<IntegrityReport, "findings" | "inferences">, ex: StandingException): string[] {
  const out: string[] = [];
  const since = ex.acceptedAt;
  const { from, to, employerKey } = ex.finding.scope;
  const accountIds = new Set(book.accounts.filter((a) => accountAliases(book, a.id).some((x) => ex.accounts?.includes(x))).map((a) => a.id));

  for (const i of report.inferences) {
    if (i.id !== ex.id) continue;
    out.push(i.partial ? `Now taken from one source and labelled partial: ${i.title}. ${i.detail}` : `Now proven from two sources: ${i.title}. ${i.detail}`);
  }
  for (const f of report.findings) {
    if (f.check !== ex.check) continue;
    const sameAccount = !!f.accounts?.some((a) => ex.accounts?.includes(a));
    const sameEmployer = !!employerKey && f.scope.employerKey === employerKey;
    if ((sameAccount || sameEmployer) && overlaps(f.scope.from, f.scope.to, from, to)) out.push(`The problem changed shape — it's now: “${f.title}”.`);
  }

  const imported: string[] = [];
  for (const s of book.statements) {
    if (s.importedAt <= since || !accountIds.has(s.accountId) || !overlaps(s.periodStart, s.periodEnd, from, to)) continue;
    imported.push(`${s.documentTitle} (statement ${s.periodStart} – ${s.periodEnd}, imported ${s.importedAt.slice(0, 10)})`);
  }
  if (employerKey) {
    for (const s of book.stubs) {
      if (s.importedAt <= since || s.employerKey !== employerKey || s.payDate < from || s.payDate > to) continue;
      imported.push(`${s.documentTitle} (${s.employer} stub ${s.payDate}, imported ${s.importedAt.slice(0, 10)})`);
    }
  }
  const unique = [...new Set(imported)];
  if (unique.length > 0) out.push(`Imported since you accepted it: ${unique.slice(0, 5).join("; ")}${unique.length > 5 ? `; and ${unique.length - 5} more` : ""}.`);

  if (ex.accounts?.length && accountIds.size === 0) out.push(`The account it's about (${ex.accounts.join(", ")}) isn't in the ledger any more.`);
  if (out.length === 0)
    out.push(
      "No document touching it was imported since you accepted it, so the check most likely stopped flagging it because the app's code changed. Make sure that's expected before retiring it.",
    );
  return out;
}
