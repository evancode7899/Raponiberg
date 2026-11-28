"use client";

import { Badge, Callout, Card, NotFigure, StatGrid, table, WordsCell } from "@/components/ui/kit";

import type { MedicalPage } from "@/lib/medical/page";

import type { Coverage } from "@/lib/medical/types";
import { Fragment } from "react";

import { COVERAGE_LABEL, shortDate, plural, Fig, Amt } from "./parts";

// ---------------------------------------------------------------------------- documents

export function CheckList({ checks }: { checks: MedicalPage["checks"] }) {
  return (
    <ul className="space-y-1 text-xs">
      {checks.map((c) => (
        <li key={c.id} className="flex items-start gap-2">
          <Badge tone={c.ok ? "pos" : "neg"}>{c.ok ? "Pass" : "Fail"}</Badge>
          <span>
            <span className="font-medium">{c.subject}</span>{" "}
            <span className="text-fg-2">
              <NotFigure why="A check's finding, in words">{c.detail}</NotFigure>
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Documents({ data, coverage, fig }: { data: MedicalPage; coverage: Coverage; fig: Fig }) {
  const statements = data.statements.filter((s) => s.coverage === coverage);
  const planDocs = data.planDocs.filter((d) => d.coverage === coverage);
  const pending = data.pending.filter((d) => d.coverage === coverage);
  const files = new Set([...statements.map((s) => s.file), ...planDocs.map((d) => d.file)]);
  // A statement's checks with its coverage; premiums by the cover they pay for; HSA eligibility with medical.
  const checks = data.checks.filter((c) => (c.file ? files.has(c.file) : c.id.startsWith("medical.premiums:") ? c.id.endsWith(`:${coverage}`) : c.id !== "medical.hsa-eligible" || coverage === "MEDICAL"));
  const failing = checks.filter((c) => !c.ok);
  const unread = planDocs.filter((d) => !d.read);
  return (
    <>
      <StatGrid cols={4}>
        <WordsCell label="Explanations of benefits" value={String(statements.length)} sub={statements[0] ? `Latest ${shortDate(statements[0].statementDate)}` : "None yet"} />
        <WordsCell label="Plan documents" value={String(planDocs.length)} sub={unread.length ? `${unread.length} not read into the plan file yet` : planDocs.length ? "All read into the plan file" : "None yet"} tone={unread.length ? "warn" : "neutral"} />
        <WordsCell label="Waiting for a reader" value={String(pending.length)} sub={pending.length ? "Kept aside until their reader lands" : "Nothing waiting"} />
        <WordsCell label="Checks" value={failing.length ? `${failing.length} failing` : "All pass"} sub={`${checks.length} checks over these documents`} tone={failing.length ? "neg" : "pos"} />
      </StatGrid>

      {unread.length > 0 && (
        <Callout tone="info" title="Plan documents not read yet">
          {plural(unread.length, "plan document")} in the folder {unread.length === 1 ? "isn't" : "aren't"} a source of any plan in <code>data/medical-plans.json</code>. Ask Claude to read {unread.length === 1 ? "it" : "them"} in.
        </Callout>
      )}

      <Card title="Checks" subtitle="Each EOB held to itself (lines add to each claim's totals; the payment summary is its claims), each plan's limits to the ones its EOBs count against, the pay stubs' premiums to the plans on file, and HSA money from pay to an HSA-eligible plan. The same checks run in Statements › Checks.">
        {checks.length === 0 ? (
          <p className="text-sm text-muted">No documents to check yet.</p>
        ) : (
          <div className="space-y-2">
            {failing.length > 0 && <CheckList checks={failing} />}
            {checks.length > failing.length && (
              <details className="text-xs">
                <summary className="cursor-pointer text-fg-2">{plural(checks.length - failing.length, "check")} pass</summary>
                <div className="mt-2">
                  <CheckList checks={checks.filter((c) => c.ok)} />
                </div>
              </details>
            )}
          </div>
        )}
      </Card>

      {statements.length > 0 && (
        <Card title="Explanations of benefits" subtitle="Each statement as read, newest first">
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr className={table.head}>
                  <th className={table.th}>Statement</th>
                  <th className={table.th}>File</th>
                  <th className={table.thR}>Claims</th>
                  <th className={table.thR}>Plan paid</th>
                  <th className={table.thR}>You owe</th>
                </tr>
              </thead>
              <tbody>
                {statements.map((s) => (
                  <tr key={s.file} className={table.tr}>
                    <td className={`${table.td} whitespace-nowrap`}>
                      {shortDate(s.statementDate)} <span className="text-muted">· {s.insurer}</span>
                    </td>
                    <td className={`${table.td} max-w-[16rem] truncate text-fg-2`} title={s.file}>
                      {s.file.split("/").at(-1)}
                    </td>
                    <td className={table.tdR}>{s.claims}</td>
                    <td className={table.tdR}>
                      <Amt fig={fig} figure="statement-plan" k={s.file} cents={s.planCents} />
                    </td>
                    <td className={table.tdR}>
                      <Amt fig={fig} figure="statement-you" k={s.file} cents={s.yourShareCents} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {(planDocs.length > 0 || pending.length > 0) && (
        <Card title="Other documents found">
          <ul className="space-y-1 text-sm">
            {planDocs.map((d) => (
              <li key={d.file} className="flex flex-wrap items-center gap-2">
                <Badge tone={d.read ? "pos" : "warn"}>{d.read ? "Read" : "Not read yet"}</Badge>
                <span>
                  {d.title}
                  {d.insurer && <span className="text-muted"> · {d.insurer}</span>}
                  {d.periodFrom && d.periodTo && <span className="text-muted"> · {shortDate(d.periodFrom)} – {shortDate(d.periodTo)}</span>}
                </span>
                <code className="truncate text-xs text-muted" title={d.file}>
                  {d.file}
                </code>
              </li>
            ))}
            {pending.map((d) => (
              <li key={d.file} className="flex flex-wrap items-center gap-2">
                <Badge tone="info">Waiting for reader</Badge>
                <span>
                  {COVERAGE_LABEL[d.coverage]} EOB{d.statementDate && ` of ${shortDate(d.statementDate)}`}
                  {d.insurer && <span className="text-muted"> · {d.insurer}</span>}
                </span>
                <code className="truncate text-xs text-muted" title={d.file}>
                  {d.file}
                </code>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
