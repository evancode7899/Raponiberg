import { asObject, asString, isNum } from "../settingsStore.ts";

/**
 * What the owner adds to a policy that its text doesn't carry: the beneficiaries (they're
 * on the application, a scanned page with no text) and a note. Keyed by policy number.
 * Stored as one AppSetting, so it's in the database and its backups, never in the code.
 */

export type Beneficiary = { name: string; relationship: string; sharePct: number; type: "PRIMARY" | "CONTINGENT" };

export type PolicyNotes = { beneficiaries: Beneficiary[]; note: string };

export type InsuranceNotes = { version: 1; policies: Record<string, PolicyNotes> };

export const INSURANCE_NOTES_KEY = "insurance.notes.v1";

export function normalizePolicyNotes(raw: unknown): PolicyNotes {
  const o = asObject(raw);
  const list = Array.isArray(o.beneficiaries) ? o.beneficiaries : [];
  return {
    beneficiaries: list.slice(0, 20).flatMap((b) => {
      const x = asObject(b);
      const name = asString(x.name, 120).trim();
      if (!name) return [];
      const share = isNum(x.sharePct) ? Math.min(100, Math.max(0, x.sharePct)) : 0;
      return [{ name, relationship: asString(x.relationship, 60).trim(), sharePct: share, type: x.type === "CONTINGENT" ? "CONTINGENT" : "PRIMARY" } satisfies Beneficiary];
    }),
    note: asString(o.note, 2000),
  };
}

export function normalizeInsuranceNotes(raw: unknown): InsuranceNotes {
  const policies = asObject(asObject(raw).policies);
  return {
    version: 1,
    policies: Object.fromEntries(
      Object.entries(policies)
        .slice(0, 50)
        .map(([k, v]) => [k.slice(0, 40), normalizePolicyNotes(v)]),
    ),
  };
}
