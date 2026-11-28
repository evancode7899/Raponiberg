import { buildCoverReport } from "./cover.ts";
import type { PremiumRow } from "./report.ts";
import type { AutoPolicy, AutoRenewal, BillingNotice, InsuranceDocsFile, PaymentReceipt, PolicyForm, PolicyStatus, PropertyPolicy, TermPolicy } from "./types.ts";

/**
 * The insurance documents as last scanned (store.ts), sorted by kind, with no PDF library
 * loaded: what the Insurance page and the Car page read.
 */
/** The scan's documents, sorted by file, by kind. */
export function docsByKind(docs: InsuranceDocsFile | null) {
  const entries = Object.entries(docs?.files ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const policies: { file: string; policy: TermPolicy }[] = [];
  const bills: { file: string; bill: BillingNotice }[] = [];
  const receipts: { file: string; receipt: PaymentReceipt }[] = [];
  const statuses: { file: string; status: PolicyStatus }[] = [];
  const homes: { file: string; policy: PropertyPolicy }[] = [];
  const autos: { file: string; policy: AutoPolicy }[] = [];
  const renewals: { file: string; renewal: AutoRenewal }[] = [];
  const forms: { file: string; form: PolicyForm }[] = [];
  for (const [file, e] of entries) {
    const d = e.doc;
    if (d?.kind === "TERM_LIFE") policies.push({ file, policy: d });
    else if (d?.kind === "BILL") bills.push({ file, bill: d });
    else if (d?.kind === "RECEIPT") receipts.push({ file, receipt: d });
    else if (d?.kind === "STATUS") statuses.push({ file, status: d });
    else if (d?.kind === "PROPERTY") homes.push({ file, policy: d });
    else if (d?.kind === "AUTO") autos.push({ file, policy: d });
    else if (d?.kind === "AUTO_RENEWAL") renewals.push({ file, renewal: d });
    else if (d?.kind === "FORM") forms.push({ file, form: d });
  }
  return { policies, bills, receipts, statuses, homes, autos, renewals, forms };
}

/**
 * Which statement charges the declarations on file say are premiums for a home (renters,
 * homeowners) or for a car, by row id: the same matching as the Home and Auto tabs
 * (cover.ts). The Car page counts the car's and never a home's, whatever the payee's name.
 */
export function premiumLines(docs: InsuranceDocsFile | null, rows: readonly PremiumRow[], today: string): Map<string, "HOME" | "AUTO"> {
  const { homes, autos, renewals, forms } = docsByKind(docs);
  const out = new Map<string, "HOME" | "AUTO">();
  if (!homes.length && !autos.length) return out;
  const cover = buildCoverReport({ homes, autos, renewals, forms, rows: [...rows], today });
  for (const h of cover.homes) for (const p of h.payments) out.set(p.rowId, "HOME");
  for (const a of cover.autos) for (const p of a.payments) out.set(p.rowId, "AUTO");
  return out;
}
