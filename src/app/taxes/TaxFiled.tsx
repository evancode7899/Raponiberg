"use client";

import { Card } from "@/components/ledger/LedgerBits";
import { Badge, btn, EmptyState, table } from "@/components/ui/kit";
import type { CheckLine, CheckStatus, SourceCheck, Suggestion } from "@/lib/tax/filedCheck";
import type { TaxProfile } from "@/lib/tax/profile";
import { TAX_DOC_KIND_LABEL } from "@/lib/taxdocs/types";
import Link from "next/link";
import { useState } from "react";
import type { ProvenTaxResponse as TaxResponse } from "./TaxClient";
import { Callout, usd } from "./taxUi";

const STATUS: Record<CheckStatus, { label: string; tone: "pos" | "neutral" | "neg" | "warn" | "info" }> = {
  MATCH: { label: "matches", tone: "pos" },
  ROUNDING: { label: "rounding", tone: "neutral" },
  DIFFERENT: { label: "differs", tone: "neg" },
  FILED_ONLY: { label: "as filed", tone: "info" },
  MODEL_ONLY: { label: "not on return", tone: "warn" },
};

/**
 * The year's filed return against this app's figures, line by line; the W-2s, 1099s and
 * payments against the ledger; and the inputs that would close any gap, one click each.
 */
export function TaxFiled({ r, onSave }: { r: TaxResponse; onSave: (p: TaxProfile) => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const docs = r.documents;
  const check = docs?.check ?? null;

  const apply = async (list: Suggestion[], id: string) => {
    const profile = structuredClone(r.profile);
    const key = String(r.year);
    profile.years[key] ??= structuredClone(r.inputs);
    for (const s of list) {
      for (const { path, value } of s.set) {
        let o: Record<string, unknown> = profile as unknown as Record<string, unknown>;
        for (const k of path.slice(0, -1)) o = (o[String(k)] ??= {}) as Record<string, unknown>;
        o[String(path.at(-1))] = value;
      }
    }
    setBusy(id);
    setError(null);
    try {
      await onSave(profile);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (!docs) {
    return (
      <EmptyState title={`No tax documents for ${r.year}`}>
        Put the year&apos;s filed return and the W-2s, 1099s and K-1s behind it in the tax documents folder (a subfolder named {r.year}), then scan it from{" "}
        <Link href="/statements?tab=import" className="text-accent underline">
          Statements → Import
        </Link>
        . Finished years then use those forms as their figures, and this tab checks the app against the return line by line.
      </EmptyState>
    );
  }

  const headline = (what: string, status: CheckStatus | null) =>
    status == null ? null : status === "MATCH" ? `${what}: matches the filed return on every line, to the dollar.` : status === "ROUNDING" ? `${what}: matches the filed return within rounding.` : `${what}: differs from the filed return — see below.`;

  return (
    <div className="flex flex-col gap-4">
      {error && <Callout tone="warn">{error}</Callout>}
      {check ? (
        <Callout
          tone={check.summary.differences ? "warn" : "good"}
          title={check.summary.differences ? `${check.summary.differences} difference${check.summary.differences === 1 ? "" : "s"} from the filed ${r.year} returns` : `The app reproduces the filed ${r.year} returns`}
        >
          {[headline("Federal", check.summary.federal), headline("Connecticut", check.summary.ct), headline("New York", check.summary.ny)].filter(Boolean).join(" ")}
          {check.filingStatus === "MFS" && " The return was filed separately; the joint model is compared."}
        </Callout>
      ) : (
        <Callout tone="info" title={`No filed ${r.year} return on file`}>
          The year&apos;s forms are in the folder, but not the filed federal or Connecticut return, so there&apos;s nothing to check against yet.
        </Callout>
      )}

      {check && check.suggestions.length > 0 && (
        <Card title="Inputs that would close the gaps" subtitle="These figures aren't in any statement or form the app reads; the filed return says what they were.">
          <ul className="flex flex-col gap-2 text-sm">
            {check.suggestions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 text-fg-2">{s.text}</span>
                <button type="button" className={btn.secondary} disabled={busy !== null} onClick={() => void apply([s], s.id)}>
                  {busy === s.id ? "Saving…" : "Apply"}
                </button>
              </li>
            ))}
          </ul>
          {check.suggestions.length > 1 && (
            <button type="button" className={`${btn.primary} mt-3`} disabled={busy !== null} onClick={() => void apply(check.suggestions, "all")}>
              {busy === "all" ? "Saving…" : "Apply all"}
            </button>
          )}
        </Card>
      )}

      {check?.amendment && (
        <Callout tone="info" title="Amendment">
          {check.amendment.reason} It would change federal tax by {signed(check.amendment.federal)}, Connecticut tax by {signed(check.amendment.ct)}
          {check.amendment.ny ? ` and New York tax by ${signed(check.amendment.ny)}` : ""}.
        </Callout>
      )}

      {check && check.federal.length > 0 && <LineTable title={`Federal ${docs.filed.federal?.form ?? "1040"}`} lines={check.federal} file={docs.filed.federal ? fileOf(docs, "RETURN_FEDERAL") : null} />}
      {check && check.ct.length > 0 && <LineTable title={`Connecticut ${docs.filed.ct?.form}`} lines={check.ct} file={fileOf(docs, "RETURN_CT")} />}
      {check && check.ny.length > 0 && (
        <LineTable
          title={`New York ${docs.filed.ny?.form}`}
          lines={check.ny}
          file={fileOf(docs, "RETURN_NY")}
          subtitle={
            r.ny
              ? `New York State${r.ny.city !== "NONE" ? " and City" : ""} recomputed: ${r.ny.state === "RESIDENT" ? "a full-year resident" : r.ny.state === "PART_YEAR" ? `a part-year resident until ${r.ny.movedOut ?? "the move"}` : "a nonresident"}, from the W-2s' New York lines.`
              : "No New York residency is set for the year, so New York isn't computed."
          }
        />
      )}
      {check && check.sources.length > 0 && <SourceTable sources={check.sources} />}

      <Card title={`Documents for ${r.year}`} subtitle="Everything in the year's folder, as read. Superseded copies (rejected e-files, previews) are listed but not used.">
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Document</th>
                <th className={table.th}>Kind</th>
                <th className={table.th}>Whose</th>
                <th className={table.th}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {docs.files.map((f) => (
                <tr key={f.id} className={table.tr}>
                  <td className={`${table.td} break-all`}>{f.file}</td>
                  <td className={table.td}>
                    <Badge tone={f.superseded ? "neutral" : f.kind.startsWith("RETURN_") ? "pos" : "info"}>{TAX_DOC_KIND_LABEL[f.kind]}</Badge>
                  </td>
                  <td className={table.td}>{f.personId ? (r.profile.persons.find((p) => p.id === f.personId)?.name ?? f.personId) : "—"}</td>
                  <td className={`${table.td} text-xs text-muted`}>{[f.superseded, ...f.warnings].filter(Boolean).join(" ") || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

const signed = (cents: number) => `${cents >= 0 ? "+" : "−"}${usd(Math.abs(cents))}`;

function fileOf(docs: NonNullable<TaxResponse["documents"]>, kind: string): string | null {
  return docs.files.find((f) => f.kind === kind && !f.superseded)?.file ?? null;
}

const show = (l: CheckLine, v: number | null) => (v == null ? "—" : l.percent ? `${(v / 100).toFixed(2)}%` : usd(v));

function LineTable({ title, lines, file, subtitle }: { title: string; lines: CheckLine[]; file: string | null; subtitle?: string }) {
  return (
    <Card title={title} subtitle={[subtitle, file && `Filed copy: ${file}`].filter(Boolean).join(" ")}>
      <div className={table.wrap}>
        <table className={table.table}>
          <thead className={table.head}>
            <tr>
              <th className={table.th}>Line</th>
              <th className={table.th} />
              <th className={table.thR}>Filed</th>
              <th className={table.thR}>This app</th>
              <th className={table.th} />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.key + l.where} className={table.tr}>
                <td className={`${table.td} whitespace-nowrap text-xs text-muted`}>{l.where}</td>
                <td className={table.td}>
                  <div>{l.label}</div>
                  {l.note && <div className="mt-0.5 text-xs text-muted">{l.note}</div>}
                </td>
                <td className={table.tdR}>{show(l, l.filed)}</td>
                <td className={table.tdR}>{show(l, l.model)}</td>
                <td className={table.td}>
                  <Badge tone={STATUS[l.status].tone}>{STATUS[l.status].label}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function SourceTable({ sources }: { sources: SourceCheck[] }) {
  const tone = { MATCH: "pos", DIFFERENT: "neg", LEDGER_MISSING: "info" } as const;
  const label = { MATCH: "matches", DIFFERENT: "differs", LEDGER_MISSING: "form only" };
  return (
    <Card title="Forms against the ledger" subtitle="Each W-2 against the pay stubs, each 1099 against the statements, and the payments on the return against the bank. A difference means the ledger is missing something (a stub, a statement) or a form is.">
      <div className={table.wrap}>
        <table className={table.table}>
          <thead className={table.head}>
            <tr>
              <th className={table.th}>Figure</th>
              <th className={table.thR}>Form / return</th>
              <th className={table.thR}>Ledger</th>
              <th className={table.th} />
            </tr>
          </thead>
          <tbody>
            {sources.map((s, i) => (
              <tr key={i} className={table.tr}>
                <td className={table.td}>
                  <div>{s.label}</div>
                  {s.note && <div className="mt-0.5 text-xs text-muted">{s.note}</div>}
                </td>
                <td className={table.tdR}>{usd(s.documentValue)}</td>
                <td className={table.tdR}>{usd(s.ledgerValue)}</td>
                <td className={table.td}>
                  <Badge tone={tone[s.status]}>{label[s.status]}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
