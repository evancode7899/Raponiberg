"use client";

import type { Api } from "@/components/ledger/useApi";
import { notifyLedgerChanged } from "@/components/shell/AppShell";
import { btn, Card, ErrorNote, Field, inputCls, Loading, selectCls } from "@/components/ui/kit";
import type { FinancialProfileSettings } from "@/lib/profile/settings";
import type { TaxProfile } from "@/lib/tax/profile";
import { useEffect, useMemo, useState } from "react";

/** Keeps the raw text while typing; commits only a complete, plausible year (or clears when emptied). */
function BirthYearInput({ value, onCommit }: { value: number | undefined; onCommit: (n: number | undefined) => void }) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => {
    setText((cur) => (Number(cur) === value || (cur.trim() === "" && value === undefined) ? cur : value === undefined ? "" : String(value)));
  }, [value]);
  return (
    <input
      inputMode="numeric"
      className={`${inputCls} num`}
      value={text}
      onChange={(e) => {
        const raw = e.target.value.replace(/\D/g, "").slice(0, 4);
        setText(raw);
        if (!raw) onCommit(undefined);
        else if (raw.length === 4 && Number(raw) > 1900 && Number(raw) < 2100) onCommit(Number(raw));
      }}
    />
  );
}

/**
 * Facts about the household that several pages share: who's who (matched on pay stubs
 * and brokerage owner lines), birth years and bonus timing (FIRE), dependents (Taxes),
 * and the date finances merged (how partner transfers are labeled).
 */
export function HouseholdPanel({ api }: { api: Api }) {
  const [tax, setTax] = useState<TaxProfile | null>(null);
  const [profile, setProfile] = useState<FinancialProfileSettings | null>(null);
  const [mergeDate, setMergeDate] = useState("");
  const [saved, setSaved] = useState<{ tax: string; profile: string; mergeDate: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    Promise.all([
      api.call<TaxProfile>("/api/tax/profile"),
      api.call<FinancialProfileSettings>("/api/profile/settings"),
      api.call<{ mergeDate: string }>("/api/settings/household"),
    ])
      .then(([t, p, h]) => {
        setTax(t);
        setProfile(p);
        setMergeDate(h.mergeDate);
        setSaved({ tax: JSON.stringify(t), profile: JSON.stringify(p), mergeDate: h.mergeDate });
      })
      .catch((e: Error) => setError(e.message));
  }, [api, version]);

  const dirty = useMemo(() => {
    if (!saved || !tax || !profile) return { tax: false, profile: false, merge: false, any: false };
    const d = { tax: JSON.stringify(tax) !== saved.tax, profile: JSON.stringify(profile) !== saved.profile, merge: mergeDate !== saved.mergeDate };
    return { ...d, any: d.tax || d.profile || d.merge };
  }, [tax, profile, mergeDate, saved]);

  if (error && !tax) return <ErrorNote>{error}</ErrorNote>;
  if (!tax || !profile) return <Loading />;

  const editTax = (f: (t: TaxProfile) => void) =>
    setTax((cur) => {
      const next = structuredClone(cur!);
      f(next);
      return next;
    });
  const editProfile = (f: (p: FinancialProfileSettings) => void) =>
    setProfile((cur) => {
      const next = structuredClone(cur!);
      f(next);
      return next;
    });

  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const notes: string[] = [];
      if (dirty.tax) await api.call("/api/tax/profile", { method: "PUT", json: tax });
      if (dirty.profile) await api.call("/api/profile/settings", { method: "PUT", json: profile });
      if (dirty.merge) {
        const r = await api.call<{ reclassified: number }>("/api/settings/household", { method: "PUT", json: { mergeDate } });
        notes.push(`${r.reclassified} rows relabeled for the new merge date`);
        notifyLedgerChanged();
      }
      setNotice(`Saved${notes.length ? ` — ${notes.join("; ")}` : ""}.`);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="sticky top-[46px] z-10 flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 shadow-sm">
        <button type="button" className={btn.primary} disabled={!dirty.any || busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save household"}
        </button>
        <button type="button" className={btn.secondary} disabled={!dirty.any || busy} onClick={() => setVersion((v) => v + 1)}>
          Discard changes
        </button>
        {notice && <span className="text-xs text-pos">{notice}</span>}
        {error && <span className="text-xs text-neg">{error}</span>}
      </div>

      <Card title="People" subtitle="Names are matched (case-insensitive) against pay-stub employee names and brokerage account owner lines.">
        <div className="flex flex-col gap-4">
          {tax.persons.map((p, i) => (
            <div key={p.id} className="grid gap-3 rounded-md border border-line p-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Name">
                <input className={inputCls} value={p.name} onChange={(e) => editTax((t) => void (t.persons[i]!.name = e.target.value))} />
              </Field>
              <Field label="Matches on documents" hint="Comma-separated">
                <input
                  className={inputCls}
                  value={p.match.join(", ")}
                  onChange={(e) =>
                    editTax(
                      (t) =>
                        void (t.persons[i]!.match = e.target.value
                          .split(",")
                          .map((s) => s.trim().toUpperCase())
                          .filter(Boolean)),
                    )
                  }
                />
              </Field>
              <Field label="Birth year" hint="For ages on FIRE and Account limits">
                <BirthYearInput
                  value={profile.birthYears[p.id]}
                  onCommit={(n) =>
                    editProfile((d) => {
                      if (n === undefined) delete d.birthYears[p.id];
                      else d.birthYears[p.id] = n;
                    })
                  }
                />
              </Field>
            </div>
          ))}
        </div>
      </Card>

      <Card
        title="Dependents"
        actions={
          <button type="button" className={btn.secondary} onClick={() => editTax((t) => void t.dependents.push({ name: "", birthYear: new Date().getFullYear() }))}>
            Add dependent
          </button>
        }
      >
        {tax.dependents.length === 0 ? (
          <p className="text-sm text-muted">None.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {tax.dependents.map((d, i) => (
              <div key={i} className="grid grid-cols-[1fr_8rem_auto] items-end gap-2">
                <Field label="Name">
                  <input className={inputCls} value={d.name} onChange={(e) => editTax((t) => void (t.dependents[i]!.name = e.target.value))} />
                </Field>
                <Field label="Birth year">
                  <input
                    inputMode="numeric"
                    className={`${inputCls} num`}
                    value={String(d.birthYear)}
                    onChange={(e) => editTax((t) => void (t.dependents[i]!.birthYear = Number(e.target.value.replace(/\D/g, "")) || t.dependents[i]!.birthYear))}
                  />
                </Field>
                <button type="button" className={btn.ghost} onClick={() => editTax((t) => void t.dependents.splice(i, 1))}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        <Field label="When filing separately, who claims the dependents?" className="mt-4 max-w-sm">
          <select className={`${selectCls} !py-2`} value={tax.mfsDependentClaimant} onChange={(e) => editTax((t) => void (t.mfsDependentClaimant = e.target.value))}>
            <option value="AUTO">Whoever saves more</option>
            {tax.persons.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      </Card>

      <Card
        title="Accounts with no statements available"
        subtitle="Accounts the household had whose statements can't be obtained (e.g. a closed pre-marriage account). Pay deposited to them is taken from the pay stubs, and card payments from them count as outside money; every figure that relies on them is labelled partial instead of withheld."
        actions={
          <button type="button" className={btn.secondary} onClick={() => editTax((t) => void (t.unavailableAccounts ??= []).push({ last4: "", note: "" }))}>
            Add account
          </button>
        }
      >
        {(tax.unavailableAccounts ?? []).length === 0 ? (
          <p className="text-sm text-muted">None.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {(tax.unavailableAccounts ?? []).map((a, i) => (
              <div key={i} className="grid grid-cols-[8rem_1fr_auto] items-end gap-2">
                <Field label="Last 4 digits">
                  <input
                    inputMode="numeric"
                    maxLength={4}
                    className={`${inputCls} num`}
                    value={a.last4}
                    onChange={(e) => editTax((t) => void (t.unavailableAccounts![i]!.last4 = e.target.value.replace(/\D/g, "").slice(0, 4)))}
                  />
                </Field>
                <Field label="Why there are no statements">
                  <input className={inputCls} value={a.note} onChange={(e) => editTax((t) => void (t.unavailableAccounts![i]!.note = e.target.value))} />
                </Field>
                <button type="button" className={btn.ghost} onClick={() => editTax((t) => void t.unavailableAccounts!.splice(i, 1))}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Finances merged on"
        subtitle="Before this date, money from the partner's own accounts counts as partner contributions into the books; after it, it's household money that isn't tracked yet. Charts mark this date. Saving a new date relabels those transfers."
      >
        <input type="date" className={inputCls} value={mergeDate} onChange={(e) => setMergeDate(e.target.value)} aria-label="Finances merged on" />
      </Card>
    </>
  );
}
