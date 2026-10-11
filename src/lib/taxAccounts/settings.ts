import { asObject, isNum } from "../settingsStore.ts";

/**
 * What pay stubs and statements can't say about tax-advantaged accounts: HSA coverage
 * (self-only or family decides the limit) and the employer's match formula. Per person;
 * nothing here changes a recorded figure.
 */
export type HsaCoverage = "SELF" | "FAMILY" | "NONE";

export type PersonRetirementInputs = {
  /** null: assumed from the stubs (HSA deductions → family with dependents, else self). */
  hsaCoverage: HsaCoverage | null;
  /** Employer matches `matchRate` of each dollar deferred, up to `matchUpTo` of pay (e.g. 1.0 up to 0.04). */
  matchRate: number | null;
  matchUpTo: number | null;
};

export type RetirementSettings = {
  version: 1;
  people: Record<string, PersonRetirementInputs>;
  /** Combined federal + state rate for "what a pre-tax dollar saves" (null: from the tax report). */
  marginalRate: number | null;
};

export const RETIREMENT_SETTINGS_KEY = "retirementAccounts.v1";

export const EMPTY_PERSON: PersonRetirementInputs = { hsaCoverage: null, matchRate: null, matchUpTo: null };

const ratio = (v: unknown, max = 1) => (isNum(v) && v >= 0 && v <= max ? v : null);

export function normalizeRetirementSettings(raw: unknown): RetirementSettings {
  const r = asObject(raw);
  const people: Record<string, PersonRetirementInputs> = {};
  for (const [id, v] of Object.entries(asObject(r.people))) {
    const o = asObject(v);
    people[id.slice(0, 60)] = {
      hsaCoverage: o.hsaCoverage === "SELF" || o.hsaCoverage === "FAMILY" || o.hsaCoverage === "NONE" ? o.hsaCoverage : null,
      matchRate: ratio(o.matchRate, 5),
      matchUpTo: ratio(o.matchUpTo, 0.5),
    };
  }
  return { version: 1, people, marginalRate: ratio(r.marginalRate, 0.7) };
}
