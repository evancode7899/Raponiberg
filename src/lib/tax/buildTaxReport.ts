import { noteBook, type Amount, type NoteBook } from "../book/said.ts";
import { taxBlockers, taxYearThrough, yearProvenToEnd } from "../book/blockers.ts";
import { type Book, type BookStub } from "../book/load.ts";
import { personPayYear } from "../book/pay.ts";
import { refs } from "../book/reports/blockerRef.ts";
import { chetYear, excessDeferral, excessDeferralMessage, iraYear, k401Limit, taxableConversion } from "../book/taxAdvantaged.ts";
import { taxRows } from "../book/taxPayments.ts";
import { bonusChecksOf } from "./bonusGap.ts";
import { type TaxForecastLink } from "../forecast/forecast.ts";
import { type K1Form } from "../taxdocs/types.ts";
import { additionalIncome, computeReturn, installmentsDue, safeHarbor, type PersonIncome, type SafeHarbor, type W2 } from "./computeReturn.ts";
import { filedBalance, matchW2s, NYC_LOCALITY, safeHarborTax, w2FromForm, yearDocs, type DocRef } from "./documents.ts";
import { taxPaymentsFrom, type FiledBalances, type TaxPaymentRow } from "./facts/payments.ts";
import { amountsFromLines, w2FromAmounts, ZERO_AMOUNTS } from "./facts/payroll.ts";
import { checkFiled } from "./filedCheck.ts";
import { annualizedK1, expectedK1, k1Adds, k1Gaps, k1Items, K1_OWN_FIELDS, type K1AddField } from "./k1.ts";
import { passiveCarryforwards, passiveKey, passiveLimit } from "./passive.ts";
import { k1DetailFor, type K1Detail } from "./k1DetailStore.ts";
import { estimateInstallments, filingDate } from "../dates/taxDates.ts";
import { NY_SAFE_HARBOR, TAX_YEARS, taxYearParams } from "./params.ts";
import { bestSeparate } from "./scenarios.ts";
import { ageAtYearEnd, EXTRA_FIELDS, yearInputs, type TaxPerson } from "./profile.ts";

import { ZERO_INV, type InvestmentFigures, type K1Use, type PayrollEntry, type PersonReport, type TaxReport, type TruePlan, type TaxReportBlocked } from "./taxReportTypes.ts";
import { hsaCheck, formOnlyPayroll, applyBrokerage1099s, beforeMove, nyFor, residencyFor, addAmounts, sumW2, bumpWages, projectEmployers, investmentAccounts, childIncome, pos, usd } from "./taxReportParts.ts";

export * from "./taxReportTypes.ts";
export { investmentAccounts, childIncome } from "./taxReportParts.ts";

const minIso = (a: string, b: string) => (a < b ? a : b);

/**
 * Income tax on one more dollar of the top earner's wages: federal (which already holds the
 * 0.9% Additional Medicare surtax) + Connecticut + New York. The one "marginal rate" every
 * page means by it (Account limits' pre-tax steps, the HSA's tax saved); payroll tax is
 * `marginal.payroll`, apart. A 401(k) or HSA dollar avoids all three: New York follows the
 * federal treatment of both.
 */
export const incomeTaxMarginal = (t: Pick<TaxReport, "marginal">): number => t.marginal.federal + t.marginal.ct + t.marginal.ny;

export function buildTaxReport(
  book: Book,
  year: number,
  opts: { estimatePriorYear?: boolean; forecast?: TaxForecastLink | null } = {},
): TaxReport | TaxReportBlocked {
  const today = book.today;
  const params = taxYearParams(year);
  const fp = params.federal;
  const profile = book.taxProfile;
  const inputs = yearInputs(profile, year);
  const warnings: string[] = [];
  const assumptions: string[] = [];
  // Notes that print amounts write them through this, so the page draws each as a figure.
  const notes = noteBook(`tax:${year}`);
  const isCurrentYear = Number(today.slice(0, 4)) === year;
  // The current year runs through the data edge: stubs after it count once the bank
  // statements showing their deposits are on file.
  const through = taxYearThrough(book, year);

  // ---------------------------------------------------------------- proof
  // Pay, investment income and the bank accounts holding interest and tax payments must
  // all be proven for the year (through the cash-flow horizon for the current year). A
  // finished year with open findings shows only its blockers; the year in progress is a
  // forecast, so its open findings are listed alongside it instead of hiding it.
  const bankIds = book.accounts.filter((a) => a.group === "Cash").map((a) => a.id);
  const blockers = refs(taxBlockers(book, year));
  const isForecast = Number(today.slice(0, 4)) <= year;
  // A finished year's W-2s, 1099s and filed return (tax documents folder) are its figures of
  // record: with the filed return on file, open ledger findings don't hide the year.
  const docs = yearDocs(book.taxDocs, year, profile.persons);
  const lastYearDocs = yearDocs(book.taxDocs, year - 1, profile.persons);
  const useDocs = !isForecast;
  // A K-1 whose partner name is no one's in the household (a trust, an entity, a misread
  // name) would otherwise drop out of the return without a word.
  // A scan from before the reader kept a K-1's lettered boxes can't say what is still unread.
  const staleK1Scan = (book.taxDocs?.version ?? 4) < 4;
  // The K-1 details file can say whose it is where the partner's name doesn't.
  const k1Owner = (k: { personId: string | null; form: K1Form }, y: number) => k1DetailFor(book.k1Details, k.form.ein, y)?.owner ?? k.personId;
  for (const k of (useDocs ? docs : lastYearDocs).k1s.filter((x) => k1Owner(x, useDocs ? year : year - 1) == null && !(isForecast && x.form.final)))
    warnings.push(`The K-1 from ${k.form.partnership || "a partnership"} (${k.doc.file}) names a partner the app can't match to anyone in the household, so its income isn't on this return. Check the partner's name against Inputs.`);
  // A finished year whose statements don't reach December 31st yet (the spring, before every
  // account's December statement is on file) would show part of a year as the whole: it
  // waits for them, unless its filed return is on file as the year's figures of record.
  if (!isForecast && !yearProvenToEnd(book, year) && !docs.federal)
    blockers.push({
      id: `tax.year-awaiting:${year}`,
      status: "MISSING",
      title: `${year} is proven only through ${through}`,
      fix: `Add every account's statements through December 31, ${year}: until then the year's pay, interest and payments would cover only part of it.`,
    });
  if (blockers.length && !isForecast && !docs.federal) return { blocked: true, year, today, profile, inputs, blockers };
  // A Single year (its filed return says so) is the filer's return alone: the person whose
  // W-2s are on file, else the first. Everyone's names still decide whose accounts and forms
  // are left off it.
  const filingStatus: TaxReport["filingStatus"] = useDocs && docs.federal?.filingStatus === "SINGLE" ? "SINGLE" : "MFJ";
  const w2Owners = [...new Set(docs.w2s.flatMap((w) => (w.personId ? [w.personId] : [])))];
  const filers = filingStatus === "SINGLE" ? [profile.persons.find((p) => w2Owners.length === 1 && p.id === w2Owners[0]) ?? profile.persons[0]!] : profile.persons;

  const personFor = (text: string): TaxPerson | undefined => {
    const u = text.toUpperCase();
    return profile.persons.find((p) => p.match.some((m) => u.includes(m)));
  };

  // ---------------------------------------------------------------- payroll
  const stubsByPerson = new Map<string, BookStub[]>();
  const partialByPerson = new Map<string, string[]>();
  const partialAmountsByPerson = new Map<string, Amount[]>();
  for (const p of profile.persons) {
    const pay = personPayYear(book, p.id, year, through);
    stubsByPerson.set(p.id, pay.employers.flatMap((e) => e.stubs));
    partialByPerson.set(p.id, pay.partial.map((i) => i.title));
    partialAmountsByPerson.set(p.id, pay.partial.flatMap((i) => (i.amounts ?? []).filter((a) => a.field === "title")));
  }

  // ---------------------------------------------------------------- payments
  // The filed returns say whether a spring payment settled last year or started this one.
  const filedBalances: FiledBalances = {};
  for (const d of [lastYearDocs, docs]) {
    filedBalances[d.year] = { FEDERAL: filedBalance(d.federal), CT: filedBalance(d.ct), OTHER_STATE: filedBalance(d.ny) };
  }
  const payments = taxPaymentsFrom(taxRows(book, `${year}-01-01`, minIso(`${year + 1}-04-30`, book.horizon.cashFlow)), inputs.paymentOverrides, filedBalances);
  const forYear = (a: TaxPaymentRow["authority"], kind: string) =>
    payments.filter((p) => p.authority === a && p.attribution.taxYear === year && p.attribution.kind === kind);
  const estFederal = forYear("FEDERAL", "ESTIMATE").reduce((s, p) => s + p.amount, 0);
  const estCt = forYear("CT", "ESTIMATE").reduce((s, p) => s + p.amount, 0);
  const estFederalToDate = forYear("FEDERAL", "ESTIMATE").filter((p) => p.date <= today).reduce((s, p) => s + p.amount, 0);
  const estCtToDate = forYear("CT", "ESTIMATE").filter((p) => p.date <= today).reduce((s, p) => s + p.amount, 0);
  const estNy = forYear("OTHER_STATE", "ESTIMATE").reduce((s, p) => s + p.amount, 0);
  const estNyToDate = forYear("OTHER_STATE", "ESTIMATE").filter((p) => p.date <= today).reduce((s, p) => s + p.amount, 0);
  // CT balance-due payments made during this calendar year are deductible SALT this year.
  const ctPaidForPrior = payments
    .filter((p) => p.authority !== "FEDERAL" && p.date.startsWith(String(year)) && p.attribution.kind === "BALANCE_DUE" && p.attribution.taxYear < year)
    .reduce((s, p) => s + p.amount, 0);

  // ---------------------------------------------------------------- investments
  const accounts = investmentAccounts(book.brokerage, year, profile, personFor, warnings);
  applyBrokerage1099s(accounts, useDocs ? docs : null, lastYearDocs, profile, warnings);
  const children = childIncome(accounts, fp.kiddie, year, isForecast, warnings, assumptions, notes);

  // Bank interest (1099-INT): an account named for one person is theirs, else joint. A
  // finished year's 1099-INT replaces the ledger's interest for its account.
  const interestThrough = minIso(`${year}-12-31`, book.horizon.cashFlow);
  const interestByAccount = new Map<string, number>();
  const interestRows = new Map<string, string[]>();
  for (const r of book.rows) {
    if (r.lane !== "INCOME" || r.category !== "Interest" || !bankIds.includes(r.accountId) || r.date < `${year}-01-01` || r.date > interestThrough) continue;
    interestByAccount.set(r.accountId, (interestByAccount.get(r.accountId) ?? 0) + r.amountCents);
    interestRows.set(r.accountId, [...(interestRows.get(r.accountId) ?? []), r.id]);
  }
  // Each part as counted, for the estimate's proof (book/proof/taxEstimateProof).
  const interestParts: TaxReport["bankInterest"]["parts"] = [];
  const interestYtd = new Map<string, number>();
  const interestForms = new Set<string>();
  const add = (owner: string, cents: number, part: Omit<TaxReport["bankInterest"]["parts"][number], "ownerId" | "cents">) => {
    interestYtd.set(owner, (interestYtd.get(owner) ?? 0) + cents);
    interestParts.push({ ...part, ownerId: owner, cents });
  };
  const ownerOfAccount = (id: string) => {
    const name = book.accounts.find((a) => a.id === id)?.name.toUpperCase() ?? "";
    return profile.persons.find((p) => p.match.some((m) => name.includes(m)))?.id ?? "JOINT";
  };
  const intForms = useDocs ? docs.ints : [];
  for (const id of bankIds) {
    const acct = book.accounts.find((a) => a.id === id)!;
    const form = intForms.find((f) => f.form.account && acct.identifiers.some((i) => i.endsWith(f.form.account!)));
    if (form) {
      interestForms.add(form.doc.id);
      add(form.personId ?? ownerOfAccount(id), form.form.interest, { accountId: id, name: acct.name, doc: form.doc, rowIds: [], ledgerCents: interestByAccount.get(id) ?? 0 });
    } else if (interestByAccount.has(id)) add(ownerOfAccount(id), interestByAccount.get(id)!, { accountId: id, name: acct.name, doc: null, rowIds: interestRows.get(id)! });
  }
  // A 1099-INT for an account the ledger doesn't track still counts.
  for (const f of intForms.filter((f) => !interestForms.has(f.doc.id))) add(f.personId ?? "JOINT", f.form.interest, { accountId: null, name: `${f.form.payer} ••${f.form.account ?? "?"}`, doc: f.doc, rowIds: [], ledgerCents: null });
  const daysIn = (Date.parse(interestThrough) - Date.parse(`${year}-01-01`)) / 86_400_000 + 1;
  const interestFactor = isCurrentYear && daysIn > 0 ? 365 / daysIn : 1;
  const bankInterest = (personId: string, pick: "ytd" | "projected") => {
    const own = (interestYtd.get(personId) ?? 0) + (interestYtd.get("JOINT") ?? 0) / filers.length;
    return Math.round(pick === "ytd" ? own : own * interestFactor);
  };

  // Connecticut residency: as entered, else what the year's filed CT return shows (a
  // CT-1040NR/PY is a part-year return; a New York return and no CT one, a nonresident).
  const residency = residencyFor(inputs.residency, docs, year);
  // New York: as entered, else the filed New York return, else New York withholding this year.
  const nyWithheld = { state: false, city: false };
  for (const w of useDocs ? docs.w2s : []) {
    if (w.form.states.some((s) => s.state === "NY" && (s.wages > 0 || s.withheld > 0))) nyWithheld.state = true;
    if (w.form.locals.some((l) => NYC_LOCALITY.test(l.name) && l.withheld > 0)) nyWithheld.city = true;
  }
  for (const stubs of stubsByPerson.values()) {
    for (const st of stubs) {
      const a = amountsFromLines(st.lines, "current");
      if (a.nyWithheld > 0) nyWithheld.state = true;
      if (a.nycWithheld > 0) nyWithheld.city = true;
    }
  }
  const ny = nyFor(inputs.nyResidency, docs, residency, nyWithheld, year);
  const nyFiling = ny?.filing ?? null;

  // CHET 529 contributions, the same figures the Tax-advantaged accounts page shows.
  const chet = chetYear(book, year);
  warnings.push(...chet.mismatches);
  const chetByAccount = new Map(chet.accounts.map((a) => [a.accountNumber, a.cents]));

  const nPeople = filers.length;
  const k1sOf = (person: TaxPerson): K1Use[] => {
    // Partnership K-1s: a finished year's forms; for the year in progress, last year's again
    // (an estimate) for any partnership that didn't mark its K-1 final.
    const k1s: K1Use[] = [];
    const countK1 = (form: K1Form, doc: DocRef, detail: K1Detail | null, basis: K1Use["basis"]) => {
      const gaps = basis !== "DOCUMENT" ? [] : staleK1Scan ? [{ box: "", code: "", why: "It was scanned before the reader kept the lettered boxes: scan the tax documents folder again (Statements)." }] : k1Gaps(form, detail);
      k1s.push({ partnership: form.partnership, doc, estimate: basis !== "DOCUMENT", basis, form, detail, gaps, items: k1Items(form, detail), passive: null, adds: {}, qbi: null });
    };
    if (useDocs) {
      for (const k of docs.k1s.filter((k) => k1Owner(k, year) === person.id)) countK1(k.form, k.doc, k1DetailFor(book.k1Details, k.form.ein, year), "DOCUMENT");
    } else if (isForecast) {
      const repeated = lastYearDocs.k1s.filter((k) => !k.form.final && k1Owner(k, year - 1) === person.id);
      for (const k of repeated) {
        const lastDetail = k1DetailFor(book.k1Details, k.form.ein, year - 1);
        const now = k1DetailFor(book.k1Details, k.form.ein, year);
        // What the partnership says to expect beats last year again; a K-1 that covered part of last year is scaled to a full one.
        if (now?.expected) {
          countK1(expectedK1(k.form, k.form.partnership, k.form.ein!, now.expected), k.doc, now, "EXPECTED");
          continue;
        }
        const full = annualizedK1(k.form);
        if (!full) {
          countK1(k.form, k.doc, lastDetail, "REPEATED");
          continue;
        }
        const scale = (c: number) => Math.round((c * 365) / full.days);
        countK1(full.form, k.doc, lastDetail && { ...lastDetail, lines: lastDetail.lines.map((l) => ({ ...l, cents: scale(l.cents) })) }, "ANNUALIZED");
        assumptions.push(`${person.name}'s ${year - 1} K-1 from ${k.form.partnership} covered ${full.days} days; ${year} counts it at the same rate for the full year, as an estimate, until the partnership's expected figures or the ${year} K-1 are on file.`);
      }
      // A partnership joined this year: only its expected figures exist.
      const file = book.k1Details && !("error" in book.k1Details) ? book.k1Details : null;
      for (const d of file?.k1s ?? []) {
        if (d.year !== year || !d.expected || d.owner !== person.id || lastYearDocs.k1s.some((k) => k.form.ein === d.ein)) continue;
        const name = d.partnership ?? `the partnership ${d.ein}`;
        countK1(expectedK1(null, name, d.ein, d.expected), { id: `k1-expected:${d.ein}:${year}`, file: "the K-1 details file" }, d, "EXPECTED");
      }
    }
    return k1s;
  };
  const k1ByPerson = new Map(filers.map((person) => [person.id, k1sOf(person)]));
  // Form 8582 across the household's passive partnerships, starting from what earlier years left suspended.
  {
    const uses = [...k1ByPerson.values()].flat();
    const carryIn = passiveCarryforwards(
      Object.keys(TAX_YEARS).map(Number).filter((y) => y < year || (useDocs && y === year)).map((y) => ({ year: y, k1s: yearDocs(book.taxDocs, y, profile.persons).k1s })),
      book.k1Details,
    )(year);
    const outcome = passiveLimit(
      uses.filter((k) => k.items.passive).map((k) => ({ key: passiveKey(k.form), net: k.items.activity, publiclyTraded: k.form.publiclyTraded, final: k.form.final })),
      carryIn,
    );
    for (const k of uses) {
      k.passive = k.items.passive ? (outcome[passiveKey(k.form)] ?? null) : null;
      const made = k1Adds(k.partnership, k.items, k.passive ? k.passive.allowed : k.items.activity, k.detail?.activity === "TRADER_FUND");
      k.adds = made.adds;
      k.qbi = made.qbi;
    }
  }
  const people: PersonReport[] = filers.map((person) => {
    const { extras, pay: typedPay } = inputs.people[person.id]!;
    const stubs = stubsByPerson.get(person.id) ?? [];
    // The year in progress follows the forecast: its paycheck basis, and the bonuses it pays after the latest stub counted here.
    const lastStub = stubs.reduce((m, s) => (s.payDate > m ? s.payDate : m), "");
    const link = isCurrentYear && opts.forecast ? opts.forecast : null;
    const items = (link?.bonuses ?? []).filter((b) => b.personId === person.id && b.key.startsWith(`${year}-`) && (b.date ? b.date > lastStub : b.key >= lastStub.slice(0, 7)));
    const fromForecast: PersonReport["fromForecast"] = link
      ? { paycheck: link.paycheck[person.id] ?? typedPay.paycheck, bonus: items.reduce((t, b) => t + b.gross, 0), items: items.map((b) => ({ label: b.label, gross: b.gross, key: b.key, date: b.date, source: b.source, ...(b.window ? { window: b.window } : {}) })) }
      : null;
    const pay = fromForecast ? { ...typedPay, paycheck: fromForecast.paycheck } : typedPay;
    if (!stubs.length && isForecast) warnings.push(`No ${year} pay stubs for ${person.name}, so the forecast counts no wages for them. Upload their latest stub.`);
    const payroll: PayrollEntry[] = projectEmployers(stubs, params, extras.expectedBonus + (fromForecast?.bonus ?? 0), pay, isCurrentYear, through, warnings, person.name, !!fromForecast, notes).map(
      (p) => ({ ...p, w2Doc: null, stubW2: null }),
    );
    // A finished year's W-2 forms replace what the stubs imply (each paired to its payroll by wages).
    const w2Forms = useDocs ? docs.w2s.filter((w) => w.personId === person.id) : [];
    if (w2Forms.length) {
      const { pairs, formsOnly, stubsOnly } = matchW2s(payroll, w2Forms);
      for (const [p, f] of pairs) {
        p.stubW2 = p.w2Ytd;
        p.w2Ytd = p.w2Projected = w2FromForm(f.form, p.w2Ytd);
        p.w2Doc = f.doc;
      }
      for (const f of formsOnly) payroll.push(formOnlyPayroll(f.form, f.doc, person.name));
      for (const p of stubsOnly) warnings.push(`${person.name}'s ${year} pay from ${p.employer} has no W-2 in the tax documents folder, so the pay stubs' figures are used. Add the W-2.`);
    } else if (useDocs && docs.federal && stubs.length) {
      warnings.push(`No ${year} W-2s for ${person.name} are in the tax documents folder; wages come from the pay stubs.`);
    }
    const payrollSource: PersonReport["payrollSource"] = payroll.some((p) => p.w2Doc) ? "W2" : stubs.length ? "STUBS" : "NONE";

    const mine = accounts.flatMap((a) => (a.ownerId === person.id ? [{ a, share: 1 }] : a.ownerId === "JOINT" ? [{ a, share: 1 / nPeople }] : []));
    const inv = (pick: "ytd" | "projected") => {
      const t = { ...ZERO_INV };
      for (const { a, share } of mine) {
        if (a.kind !== "TAXABLE") continue;
        for (const k of Object.keys(t) as (keyof InvestmentFigures)[]) t[k] += Math.round(a[pick][k] * share);
      }
      return t;
    };
    const invP = inv("projected");
    const invY = inv("ytd");

    // IRA: Roth conversions are taxable beyond basis (non-deductible contributions);
    // direct rollovers to an employer plan never are.
    const iras = mine.filter(({ a }) => ["TRADITIONAL_IRA", "ROLLOVER_IRA", "ROTH_IRA"].includes(a.kind)).map(({ a }) => a);
    const dists = iras.flatMap((a) => a.distributions);
    // Contributions and conversions come from the IRAs' ledger rows (every custodian's
    // statements carry them), shared with the Tax-advantaged accounts page.
    const ira = iraYear(book, person.id, year);
    warnings.push(...ira.mismatches);
    const conversions = ira.conversions;
    const rollovers = dists.filter((d) => d.kind === "ROLLOVER").reduce((s, d) => s + d.amount, 0);
    const otherDistributions = iras
      .filter((a) => a.kind !== "ROTH_IRA")
      .flatMap((a) => a.distributions)
      .filter((d) => d.kind === "DISTRIBUTION")
      .reduce((s, d) => s + d.amount, 0);
    const basis = ira.traditionalContributions + extras.iraBasisCarryforward;
    const pretaxLeft = ira.pretaxAccounts.reduce((s, a) => s + a.cents, 0);
    if (conversions > 0 && pretaxLeft > 100_000) {
      warnings.push(
        `${person.name} converted to Roth this year but still holds pre-tax IRA money (≈$${Math.round(pretaxLeft / 100).toLocaleString()}). The pro-rata rule makes part of the conversion taxable (Form 8606); this estimate applies it with the December 31 balance, or the latest one for a year in progress.`,
      );
    }
    if (otherDistributions > 0) warnings.push(`${person.name} took IRA withdrawals that aren't rollovers or conversions; they're counted as fully taxable (a 10% penalty may also apply before age 59½).`);
    // A finished year's 1099-Rs are what was reported; a rollover (code G/H) is never taxable,
    // and an undetermined taxable amount falls back to the statements' conversion arithmetic.
    const rForms = useDocs ? docs.rs.filter((r) => r.personId === person.id) : [];
    const fromStatementsTaxable = taxableConversion(conversions, basis, pretaxLeft) + otherDistributions;
    const retirementTaxable = rForms.length
      ? rForms.reduce((s, r) => s + (/[GH]/.test(r.form.codes) ? 0 : r.form.taxableNotDetermined ? 0 : r.form.taxable), 0) +
        (rForms.some((r) => r.form.taxableNotDetermined) ? fromStatementsTaxable : 0)
      : fromStatementsTaxable;

    // Partnership K-1s (gathered for the whole household above, where the passive-loss limit is applied across them).
    const k1s = k1ByPerson.get(person.id) ?? [];
    const k1 = (f: K1AddField) => k1s.reduce((t, k) => t + (k.adds[f] ?? 0), 0);
    const k1Qbi = k1s.flatMap((k) => (k.qbi ? [k.qbi] : []));
    for (const k of k1s.filter((x) => x.passive && (x.passive.suspended || x.passive.carryIn))) {
      const o = k.passive!;
      const which = k.basis === "EXPECTED" ? " (its expected figures)" : k.estimate ? " (last year's, as an estimate)" : "";
      const loss = (x: Parameters<Parameters<NoteBook["say"]>[0]>[0], cents: number, what: string) => x.usd(cents, `the passive loss ${what}, ${k.partnership}`, undefined, usd);
      if (o.suspended)
        assumptions.push(notes.say((x) => `${person.name}'s K-1 from ${k.partnership}${which} leaves a ${loss(x, o.suspended, "the year can't use")} passive loss the year can't use${o.carryIn ? ` (${loss(x, o.carryIn, "carried in from earlier years")} of it carried in from earlier years)` : ""}: there isn't enough passive income to absorb it, so it's carried forward (Form 8582), not deducted.`));
      else assumptions.push(notes.say((x) => `${person.name}'s K-1 from ${k.partnership}${which} uses the ${loss(x, o.carryIn, "carried in from earlier years")} passive loss carried in from earlier years${k.form.final ? " (a final K-1 releases it in full)" : ""}.`));
    }

    const chetCents = mine.filter(({ a }) => a.isChet).reduce((s, { a, share }) => s + Math.round((chetByAccount.get(a.accountNumber) ?? 0) * share), 0);

    // 401(k) deferrals above the limit (all employers together) are income for this year,
    // whether or not the plan hands the excess back; the return only decides whether it's
    // taxed a second time. Shared, word for word, with the Tax-advantaged accounts page.
    // Birth years come from the Book (Settings → Household), the copy every page's return reads.
    const birthYear = book.birthYears?.[person.id];
    const { limit: k401Cap } = k401Limit(fp, birthYear ? year - birthYear : null);
    const deferred = (w: "w2Ytd" | "w2Projected") => payroll.reduce((s, p) => s + p[w].box12.D + p[w].box12.AA, 0);
    const k401Deferred = { ytd: deferred("w2Ytd"), projected: deferred("w2Projected") };
    const k401Excess = { ytd: pos(k401Deferred.ytd - k401Cap), projected: pos(k401Deferred.projected - k401Cap) };
    const k401: PersonReport["k401"] = { limit: k401Cap, deferred: k401Deferred, excess: k401Excess, excessDeferral: excessDeferral(book, person.id, year, k401Excess.projected) };
    if (k401.excessDeferral) {
      let ok = false;
      const text = notes.say((x) => {
        const m = excessDeferralMessage(person.name, year, k401Cap, k401Deferred.projected, k401.excessDeferral!, x);
        ok = m.ok;
        return m.text;
      });
      (ok ? assumptions : warnings).push(text);
    }
    const w2s: W2[] = payroll.map((p) => p.w2Projected);
    const half = (n: number) => Math.round(n / nPeople);
    const projectedIncome: PersonIncome = {
      id: person.id,
      name: person.name,
      w2s,
      taxableInterest: invP.interest + bankInterest(person.id, "projected") + k1("taxableInterest") + extras.extraInterest,
      ordinaryDividends: invP.ordinaryDividends + invP.capGainDistShort + k1("ordinaryDividends"),
      qualifiedDividends: invP.qualifiedDividends + k1("qualifiedDividends"),
      section199aDividends: invP.section199a + k1("section199aDividends"),
      taxExemptInterest: invP.taxExempt + k1("taxExemptInterest"),
      usObligationIncome: Math.round(invP.moneyMarketDividends * profile.moneyMarketUsGovShare) + invP.usTreasury + extras.usObligationIncome + k1("usObligationIncome"),
      capitalGainDistributions: invP.capGainDistLong,
      shortTermGain: invP.shortTermGain + extras.extraShortTermGain - extras.capitalLossCarryover + k1("shortTermGain"),
      longTermGain: invP.longTermGain + extras.extraLongTermGain + k1("longTermGain"),
      foreignTaxPaid: invP.foreignTax + k1("foreignTaxPaid"),
      retirementTaxable,
      otherIncome: extras.otherIncome + k401Excess.projected,
      businessIncome: 0,
      adjustments: extras.hsaOutsidePayroll + extras.otherAdjustments,
      ctChetContributions: chetCents,
      ctOtherSubtractions: k1("ctOtherSubtractions"),
      ctOtherAdditions: k1("ctOtherAdditions"),
      estimatedFederal: half(estFederal) + extras.estimatedFederalExtra,
      estimatedCt: half(estCt) + extras.estimatedCtExtra + k1("estimatedCt"),
      estimatedNy: nyFiling ? half(estNy) + k1("estimatedNy") : 0,
      mortgageInterest: half(inputs.household.mortgageInterest),
      propertyTax: half(inputs.household.propertyTax),
      charitableCash: half(inputs.household.charitableCash),
      charitableOther: half(inputs.household.charitableOther),
      otherItemized: 0,
      dependentCareExpenses: half(inputs.household.dependentCareExpenses),
      dependentCareFsa: payroll.reduce((s, p) => s + p.w2Projected.box10, 0),
      otherStateTax: extras.otherStateTax + k1("otherStateTax"),
      ...Object.fromEntries(K1_OWN_FIELDS.map((f) => [f, k1(f)])),
      qbiBusinesses: k1Qbi,
      priorYearStateTaxPaid: half(ctPaidForPrior),
    };
    // Year to date: stubs and statements as they stand, no expected bonus or future sales.
    const incomeYtd: PersonIncome = {
      ...projectedIncome,
      w2s: payroll.map((p) => p.w2Ytd),
      taxableInterest: invY.interest + bankInterest(person.id, "ytd") + (useDocs ? k1("taxableInterest") : 0) + extras.extraInterest,
      ordinaryDividends: invY.ordinaryDividends + invY.capGainDistShort + (useDocs ? k1("ordinaryDividends") : 0),
      qualifiedDividends: invY.qualifiedDividends + (useDocs ? k1("qualifiedDividends") : 0),
      section199aDividends: invY.section199a,
      taxExemptInterest: invY.taxExempt,
      usObligationIncome: Math.round(invY.moneyMarketDividends * profile.moneyMarketUsGovShare) + invY.usTreasury + extras.usObligationIncome + (useDocs ? k1("usObligationIncome") : 0),
      capitalGainDistributions: invY.capGainDistLong,
      shortTermGain: invY.shortTermGain - extras.capitalLossCarryover + (useDocs ? k1("shortTermGain") : 0),
      longTermGain: invY.longTermGain + (useDocs ? k1("longTermGain") : 0),
      foreignTaxPaid: invY.foreignTax + (useDocs ? k1("foreignTaxPaid") : 0),
      otherIncome: extras.otherIncome + k401Excess.ytd,
      ...(useDocs ? {} : { ...Object.fromEntries([...K1_OWN_FIELDS, "ctOtherSubtractions", "ctOtherAdditions"].map((f) => [f, 0])), qbiBusinesses: [], otherStateTax: extras.otherStateTax }),
      estimatedFederal: half(estFederalToDate) + extras.estimatedFederalExtra,
      estimatedCt: half(estCtToDate) + extras.estimatedCtExtra,
      estimatedNy: nyFiling ? half(estNyToDate) : 0,
      dependentCareFsa: payroll.reduce((s, p) => s + p.w2Ytd.box10, 0),
    };
    // Schedule CT-SI and IT-203's New York column work in whole dollars, line by line.
    const whole = (c: number) => Math.round(c / 100) * 100;
    // Part-year / nonresident Connecticut (CT-1040NR/PY): income from Connecticut sources.
    // Wages: a W-2's Connecticut state line, else stubs paid while a resident (as a
    // nonresident, stubs with Connecticut withholding); investment income: the resident
    // share of the year's; other income (Schedule 1): all of it while a part-year resident.
    let ctSource: PersonReport["ctSource"] = null;
    if (residency.ct !== "FULL") {
      const wages = payroll.reduce((s, p) => {
        if (p.w2Doc) return s + whole(p.w2Projected.box16StateWages);
        const own = stubs.filter((st) => st.employer === p.employer);
        const paidHere = own.filter((st) => (residency.ct === "PART_YEAR" ? !!residency.movedIn && st.payDate >= residency.movedIn : amountsFromLines(st.lines, "current").stateWithheld > 0));
        return s + paidHere.reduce((t, st) => t + w2FromAmounts(p.employer, amountsFromLines(st.lines, "current"), fp).box1Wages, 0);
      }, 0);
      const i = projectedIncome;
      const share = residency.investmentShare ?? 0;
      const investment = [i.taxableInterest, i.ordinaryDividends, i.capitalGainDistributions + i.shortTermGain + i.longTermGain].reduce((s, x) => s + whole(x * share), 0);
      const other = residency.ct === "PART_YEAR" ? additionalIncome(i) : 0;
      ctSource = { total: wages + investment + other, wages, investment, other, investmentShare: share };
      // An entered CT-source total replaces the worked-out one (all of it on the first person's return).
      if (residency.sourceIncome != null) ctSource = { ...ctSource, total: person.id === filers[0]!.id ? residency.sourceIncome : 0 };
      projectedIncome.ctSourceIncome = ctSource.total;
      incomeYtd.ctSourceIncome = ctSource.total;
    }
    // Part-year or nonresident New York (IT-203): the New York amount column. Wages: the W-2s'
    // New York lines, else stubs paid while a resident or with New York withholding;
    // investment income: the share of the year lived there; other income: a part-year
    // resident's, unless Connecticut's part-year return already counts it as Connecticut's.
    let nySource: PersonReport["nySource"] = null;
    if (ny && ny.state !== "RESIDENT") {
      const residentOn = (d: string) => ny.state === "PART_YEAR" && !!ny.movedOut && d < ny.movedOut;
      const wages = payroll.reduce((s, p) => {
        if (p.w2Doc) return s + whole(p.w2Projected.nyStateWages ?? 0);
        const own = stubs.filter((st) => st.employer === p.employer);
        const latest = own.reduce<BookStub | null>((m, st) => (!m || st.payDate > m.payDate ? st : m), null);
        // A nonresident still working in New York: the projection's paychecks are New York's too.
        if (ny.state === "NONRESIDENT" && latest && amountsFromLines(latest.lines, "current").nyWithheld > 0) return s + whole(p.w2Projected.box1Wages);
        const here = own.filter((st) => residentOn(st.payDate) || amountsFromLines(st.lines, "current").nyWithheld > 0);
        return s + whole(here.reduce((t, st) => t + w2FromAmounts(p.employer, amountsFromLines(st.lines, "current"), fp).box1Wages, 0));
      }, 0);
      const i = projectedIncome;
      const share = ny.state === "PART_YEAR" ? (residency.ct === "PART_YEAR" ? 1 - (residency.investmentShare ?? 0) : (beforeMove(ny.movedOut, year) ?? 0)) : 0;
      const investment = [i.taxableInterest, i.ordinaryDividends, i.capitalGainDistributions + i.shortTermGain + i.longTermGain].reduce((s, x) => s + whole(x * share), 0);
      const other = ny.state === "PART_YEAR" && residency.ct !== "PART_YEAR" ? whole(additionalIncome(i) * share) : 0;
      nySource = { total: wages + investment + other, wages, investment, other, investmentShare: share };
      projectedIncome.nySourceIncome = nySource.total;
      incomeYtd.nySourceIncome = nySource.total;
    }
    const ytd = payroll.reduce((acc, p) => addAmounts(acc, p.ytd), { ...ZERO_AMOUNTS });
    const projectedPay = payroll.reduce((acc, p) => addAmounts(acc, p.projected), { ...ZERO_AMOUNTS });
    return {
      id: person.id,
      name: person.name,
      fromForecast,
      bonusChecks: bonusChecksOf(stubs, fromForecast?.items ?? []),
      payrollSource,
      partial: partialByPerson.get(person.id) ?? [],
      partialAmounts: partialAmountsByPerson.get(person.id) ?? [],
      payroll,
      accounts: mine.map(({ a }) => a),
      retirement: { conversions, basis, rollovers, otherDistributions, taxable: retirementTaxable, source: rForms.length ? "1099-R" : "STATEMENTS" },
      k401,
      k1s,
      ctSource,
      nySource,
      income: projectedIncome,
      incomeYtd,
      payrollTotals: { ytd, projected: projectedPay },
      paidToDate: {
        federal: ytd.federalWithheld,
        socialSecurity: ytd.ssWithheld,
        medicare: ytd.medicareWithheld,
        ct: ytd.stateWithheld,
        ctPfml: ytd.statePayroll,
        otherState: ytd.otherStateWithheld,
        estimatesFederal: half(estFederalToDate),
        estimatesCt: half(estCtToDate),
      },
    };
  });

  // ---------------------------------------------------------------- scenarios
  // A child born after the year isn't that year's dependent.
  const dependents = profile.dependents.map((d) => ({ name: d.name, age: ageAtYearEnd(d, year) })).filter((d) => d.age >= 0);
  const incomes = people.map((p) => p.income);
  const mfj = computeReturn({ params, filingStatus, people: incomes, dependents, ny: nyFiling });
  const mfjNoDependents = computeReturn({ params, filingStatus, people: incomes, dependents: [], ny: nyFiling });
  const mfs = bestSeparate(params, incomes, dependents, profile.mfsDependentClaimant, nyFiling);
  const mfsNoDependents = bestSeparate(params, incomes, [], profile.mfsDependentClaimant, nyFiling);

  // Marginal rates: one more $1,000 of wages for the highest earner.
  const top = [...people].sort((a, b) => sumW2(b.income) - sumW2(a.income))[0];
  const bumped = incomes.map((i) => (i.id === top?.id && i.w2s.length ? bumpWages(i, 100_000) : i));
  const mfjBumped = computeReturn({ params, filingStatus, people: bumped, dependents, ny: nyFiling });
  const marginal = {
    federal: (mfjBumped.federal.totalTax - mfj.federal.totalTax) / 100_000,
    ct: (mfjBumped.ct.totalTax - mfj.ct.totalTax) / 100_000,
    ny: ((mfjBumped.ny?.totalTax ?? 0) - (mfj.ny?.totalTax ?? 0)) / 100_000,
    payroll: (mfjBumped.fica.socialSecurity + mfjBumped.fica.medicare - mfj.fica.socialSecurity - mfj.fica.medicare) / 100_000,
  };

  // Figures typed under Inputs stand on the owner's word alone (no statement, stub or tax
  // document shows them): listed, so none of them passes for a proven figure.
  const typedNow = [
    ...filers.flatMap((p) =>
      EXTRA_FIELDS.filter(([k]) => inputs.people[p.id]!.extras[k]).map(([k, label]) => `${p.name}: ${label.toLowerCase()} ${usd(inputs.people[p.id]!.extras[k])}`),
    ),
    ...(
      [
        ["mortgage interest", inputs.household.mortgageInterest],
        ["property tax", inputs.household.propertyTax],
        ["charity (cash)", inputs.household.charitableCash],
        ["charity (other)", inputs.household.charitableOther],
        ["dependent care expenses", inputs.household.dependentCareExpenses],
      ] as const
    )
      .filter(([, v]) => v)
      .map(([label, v]) => `${label} ${usd(v)}`),
  ];
  if (typedNow.length) assumptions.push(`Typed under Inputs, not shown by any statement, stub or tax document: ${typedNow.join("; ")}.`);

  // ---------------------------------------------------------------- safe harbor & plan
  const py = inputs.priorYear;
  // Until last year's filed figures are entered, the model's own estimate of last year
  // (when that year is proven) stands in for the prior-year safe harbor.
  // Last year's filed return (tax documents folder) is the figure of record: it wins over
  // anything typed under Inputs, which counts only for a figure no filed return prints.
  let priorYearSource: TaxReport["priorYearSource"] = "NONE";
  const filedFederalTax = safeHarborTax(lastYearDocs.federal);
  const filedAgi = lastYearDocs.federal?.federal?.agi ?? null;
  const filedCt = lastYearDocs.ct?.state?.totalTax ?? null;
  let priorFederal = { tax: filedFederalTax ?? py.federalTotalTax, agi: filedAgi ?? py.federalAgi };
  let priorCt = filedCt ?? py.ctTotalTax;
  if (filedFederalTax != null) priorYearSource = "FILED";
  else if (py.federalTotalTax != null) priorYearSource = "ENTERED";
  const typedAgainstFiled: [string, number | null, number | null][] = [
    ["federal total tax (Form 1040 line 24)", py.federalTotalTax, filedFederalTax],
    ["federal AGI", py.federalAgi, filedAgi],
    ["Connecticut income tax", py.ctTotalTax, filedCt],
  ];
  for (const [what, typed, filed] of typedAgainstFiled)
    if (typed != null && filed != null && Math.abs(typed - filed) > 100)
      warnings.push(`${year - 1}'s ${what} typed under Inputs (${usd(typed)}) differs from the filed return in the tax documents folder (${usd(filed)}); the filed return is used. Clear the typed figure.`);
  if (priorYearSource === "NONE" && opts.estimatePriorYear !== false && TAX_YEARS[year - 1]) {
    const prev = buildTaxReport(book, year - 1, { estimatePriorYear: false });
    if (!prev.blocked) {
      const f = prev.scenarios.mfj.federal;
      priorFederal = { tax: f.totalTax - f.refundableChildCredit, agi: py.federalAgi ?? f.agi };
      priorCt ??= prev.scenarios.mfj.ct.totalTax;
      priorYearSource = "ESTIMATED";
    }
  }
  const priorYear: TaxReport["priorYear"] = {
    federalTax: priorFederal.tax,
    federalAgi: priorFederal.agi,
    ctTax: priorCt,
    file: lastYearDocs.federal?.doc.file ?? null,
    ctFile: lastYearDocs.ct?.doc.file ?? null,
  };
  const fedWithholding = mfj.federal.withholding + mfj.federal.additionalMedicareWithheld + mfj.federal.excessSsCredit;
  const federal = safeHarbor({
    currentYearTax: mfj.federal.totalTax - mfj.federal.refundableChildCredit,
    withholding: fedWithholding,
    estimatesPaid: mfj.federal.estimatedPayments,
    priorYearTax: priorFederal.tax,
    priorYearAgi: priorFederal.agi,
    highAgiThreshold: fp.safeHarborHighAgi[filingStatus],
    rules: fp.safeHarborRules,
  });
  const ct = safeHarbor({
    currentYearTax: mfj.ct.totalTax,
    withholding: mfj.ct.withholding,
    estimatesPaid: mfj.ct.estimatedPayments,
    priorYearTax: priorCt,
    priorYearAgi: null,
    highAgiThreshold: null,
    rules: fp.safeHarborRules,
  });
  // New York's: the same tests on the New York (and City) tax, against last year's filed New York return.
  const filedNy = lastYearDocs.ny?.state ?? null;
  const nyHarbor = mfj.ny
    ? safeHarbor({
        // Less the refundable credits (school tax, pass-through entity tax), as the penalty form counts tax.
        currentYearTax: mfj.ny.totalTax - (mfj.ny.totalPayments - mfj.ny.withholding - mfj.ny.cityWithholding - mfj.ny.estimatedPayments),
        withholding: mfj.ny.withholding + mfj.ny.cityWithholding,
        estimatesPaid: mfj.ny.estimatedPayments,
        priorYearTax: filedNy?.totalTax ?? null,
        priorYearAgi: filedNy?.stateAgi ?? null,
        highAgiThreshold: NY_SAFE_HARBOR.highAgi[filingStatus],
        rules: NY_SAFE_HARBOR,
      })
    : null;
  if (filedCt != null && priorCt === filedCt && lastYearDocs.ct?.form === "CT-1040NR/PY") {
    assumptions.push(`Connecticut's prior-year safe harbor uses ${year - 1}'s part-year return (under Inputs). It covered all twelve months, but only part of the income; check CT-2210 before leaning on it.`);
  }
  if (priorYearSource === "NONE") {
    warnings.push(`No ${year - 1} return is in the tax documents folder, so the prior-year safe harbor isn't used (only the this-year test is). Add the filed return to the folder, or type its figures under Inputs.`);
  } else if (priorYearSource === "ESTIMATED") {
    warnings.push(
      `The prior-year safe harbor uses this app's estimate of ${year - 1} federal tax (under Inputs): no filed ${year - 1} return is in the tax documents folder yet. Add it (or type Form 1040 line 24 under Inputs) before relying on it.`,
    );
  }
  // A W-4 change only reaches paychecks still to come.
  const active = people.flatMap((p) => p.payroll.filter((x) => x.active).map((x) => ({ person: p.name, n: x.remainingPayDates.filter((d) => d > today).length })));
  const main = active.sort((a, b) => b.n - a.n)[0];
  const remaining = main?.n ?? 0;
  const per = (amount: number) => (remaining > 0 && amount > 0 ? Math.ceil(amount / remaining / 100) * 100 : null);
  // The estimated-tax dates still to come: the year's last is due the January after it.
  const datesLeft = estimateInstallments(year).filter((x) => x.date >= today);
  const planOf = (sh: SafeHarbor, balanceDue: number): TruePlan => {
    const dues = installmentsDue(sh, datesLeft.map((x) => x.quarter));
    return {
      safeHarborShortfall: sh.underDeMinimis ? 0 : sh.shortfall,
      projectedBalanceDue: balanceDue,
      perPaycheckForSafeHarbor: per(sh.underDeMinimis ? 0 : sh.shortfall),
      perPaycheckToBreakEven: per(balanceDue),
      installments: datesLeft.map((x, i) => ({ quarter: x.quarter, date: x.date, cents: dues[i]! })),
    };
  };
  const plan = {
    remainingPaychecks: remaining,
    paycheckPerson: main?.person ?? null,
    federal: planOf(federal, mfj.federal.balanceDue),
    ct: planOf(ct, mfj.ct.balanceDue),
    ny: nyHarbor && mfj.ny ? planOf(nyHarbor, mfj.ny.balanceDue) : null,
    q4DueDate: estimateInstallments(year)[3]!.date,
    filingDate: filingDate(year),
  };

  // The rules the estimate follows: tax law and the choices under Inputs, never a figure read from the data.
  const rules = [
    "Paychecks after the latest stub repeat the latest regular (non-bonus) paycheck, or the typical recent one where chosen under Inputs; 401(k) deferrals stop at the annual limit and Social Security at the wage base.",
    "Expected bonuses are withheld at the 22% federal supplemental rate and 6.99% CT.",
    "Dividends and interest are projected to year end from last year's month-by-month pattern in the same account (or a straight-line run rate); realized gains are not projected — add expected sales under Inputs.",
    `Fund and stock dividends are treated as ${Math.round(profile.qualifiedDividendShare * 100)}% qualified; money-market and bond-fund dividends as ordinary.`,
    filingStatus === "SINGLE"
      ? `Filed Single (the ${year} federal return names no spouse): only ${filers[0]!.name}'s wages, accounts and forms are on it; joint accounts count in full.`
      : "Married filing separately: each spouse reports their own wages and accounts; joint accounts, joint estimated payments, and household deductions are split evenly; both spouses itemize or both take the standard deduction, whichever costs less in total.",
    `Additional Medicare tax and the 3.8% net investment income tax are included in federal tax. The 0.9% employers withhold above $200k is credited back against the ${filingStatus === "SINGLE" ? "return's" : "joint"} liability.`,
    "Connecticut: 2025 CT-1040 schedule (Connecticut does not index its brackets); CHET 529 contributions are subtracted up to the per-return cap; the CT property-tax credit is not modeled.",
  ];
  if (isCurrentYear && through < today)
    assumptions.push(`Pay and bank figures run through ${through}, the latest date every account's statements reach; later pay stubs count once the bank statements showing their deposits are on file.`);
  if (!isCurrentYear && Number(today.slice(0, 4)) > year) {
    assumptions.push(
      docs.all.length
        ? `${year} is a past year: figures are the year's W-2s, 1099s and K-1s in the tax documents folder where they're on file, else what the stubs and statements show through year end.`
        : `${year} is a past year: figures are what the stubs and statements show through year end, no projection.`,
    );
  }
  if (residency.ct === "PART_YEAR") {
    assumptions.push(
      notes.say(
        (x) =>
          `Connecticut part-year resident${residency.movedIn ? ` from ${residency.movedIn}` : ""} (CT-1040NR/PY): the tax on the whole year's income is cut to the Connecticut-source share — wages from the W-2s' Connecticut lines${useDocs ? "" : " (else stubs paid after the move)"} and ${x.pct(residency.investmentShare ?? 0, "the Connecticut-source share of investment income", 1)} of investment income.`,
      ),
    );
  } else if (residency.ct === "NONRESIDENT") {
    assumptions.push("Not a Connecticut resident this year: Connecticut taxes only Connecticut-source income (CT-1040NR/PY).");
  }
  if (ny) {
    const where = ny.source === "FILED_RETURN" ? `the filed ${docs.ny?.form ?? "New York return"}` : ny.source === "INPUTS" ? "Inputs" : "New York withholding on the W-2s and pay stubs";
    const city = ny.city === "RESIDENT" ? " and New York City resident tax" : ny.city === "PART_YEAR" ? ` and part-year New York City tax (IT-360.1, ${ny.filing.cityMonths} months)` : "";
    assumptions.push(
      ny.state === "RESIDENT"
        ? notes.say((x) => `New York: full-year resident (IT-201, per ${where}) — State tax${city} on all income, with the tax computation worksheets' recapture above ${x.usd(10_765_000, "New York's recapture threshold of AGI, set by law", undefined, usd)} of AGI, the standard deduction and the NYC school tax credit.`)
        : notes.say((x) => `New York: ${ny.state === "PART_YEAR" ? `part-year resident${ny.movedOut ? ` until ${ny.movedOut}` : ""}` : "nonresident"} (IT-203, per ${where}) — the tax on all income is cut to the New York share: wages from the W-2s' New York lines and ${x.pct(people[0]?.nySource?.investmentShare ?? 0, "the New York share of investment income", 1)} of investment income${city}.`),
      "New York itemized deductions and credits other than the NYC school tax credit (household, child, college tuition) aren't modeled; they phase out well below this household's income.",
    );
  }
  hsaCheck(people, fp, warnings);
  // The household's own caveats for the year (household file), e.g. part of it lived in another state.
  const caveat = book.household.taxYearWarnings[String(year)];
  if (caveat) warnings.push(caveat);

  const report: TaxReport = {
    blocked: false,
    year,
    today,
    isCurrentYear,
    paramsNotes: params.notes,
    profile,
    inputs,
    people,
    accounts,
    chet,
    children,
    dependents,
    payments,
    filingStatus,
    scenarios: { mfj, mfjNoDependents, mfs, mfsNoDependents },
    marginal,
    safeHarbor: { federal, ct, ny: nyHarbor },
    priorYearSource,
    priorYear,
    residency,
    ny,
    documents: null,
    unverified: blockers,
    bankInterest: { through: interestThrough, factor: interestFactor, parts: interestParts },
    dataThrough: {
      payStubs: people.flatMap((p) => p.payroll.filter((x) => x.active).map((x) => ({ person: p.name, employer: x.employer, date: x.latestPayDate }))),
      statements: accounts.filter((a) => a.kind === "TAXABLE").reduce<string | null>((m, a) => (m == null || a.latestStatement < m ? a.latestStatement : m), null),
      bank: interestThrough,
    },
    plan,
    warnings,
    assumptions,
    said: notes.amounts,
    rules,
  };
  if (docs.all.length) {
    const ownerOfDoc = new Map<string, string | null>();
    for (const list of [docs.w2s, docs.brokerage, docs.ints, docs.rs, docs.k1s] as { doc: DocRef; personId: string | null }[][]) for (const o of list) ownerOfDoc.set(o.doc.id, o.personId);
    report.documents = {
      files: docs.all.map((d) => ({ id: d.id, file: d.file, kind: d.kind, superseded: d.superseded, warnings: d.warnings, personId: ownerOfDoc.get(d.id) ?? null })),
      filed: { federal: docs.federal, ct: docs.ct, ny: docs.ny },
      check: docs.federal || docs.ct ? checkFiled(report, docs, notes) : null,
    };
  }
  return report;
}
