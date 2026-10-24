"use client";

import { cachedResponse, type Api } from "@/components/ledger/useApi";
import { Badge, btn, Card, StatCell, StatGrid, table } from "@/components/ui/kit";
import type { SweepReport } from "@/lib/book/proof/sweep";
import type { AcceptedFinding, Finding, RetiredException, StaleException } from "@/lib/book/types";
import { formatDisplayDateFromYmd } from "@/lib/displayTime";
import { useEffect, useMemo, useState } from "react";
import type { BookReport, OnAccept, OnRetire } from "./useBookReport";

const date = (iso: string) => formatDisplayDateFromYmd(iso);

const KIND_WORDS: Record<SweepReport["problems"][number]["kind"], string> = {
  DIFFERS: "page and proof differ",
  SELF_CHECK: "parts don't re-add",
  CHAIN: "a step doesn't add up",
  WITHHELD: "shown though withheld",
  LINK: "a link fails",
  ERROR: "couldn't be built",
};

/**
 * The proof sweep: every figure every page shows held to its proof (lib/book/proof/sweep.ts).
 * A problem here is a bug in the app, never in the documents, and the page withholds that figure.
 */
function SweepCard({ api }: { api: Api }) {
  const [r, setR] = useState<SweepReport | null>(() => cachedResponse<SweepReport>("/api/proof/sweep"));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .call<SweepReport>("/api/proof/sweep")
      .then((x) => live && setR(x))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [api]);
  const bad = r?.problems.length ?? 0;
  return (
    <Card
      title="Figures vs their proofs"
      subtitle={
        r
          ? `Every figure on every page, opened and re-derived from the statements: ${r.figures.toLocaleString()} figures and ${r.links.toLocaleString()} linked proofs, in ${(r.ms / 1000).toFixed(1)}s.`
          : error
            ? `Couldn't run: ${error}`
            : "Opening every figure's proof…"
      }
    >
      {r && (
        <>
          <p className={`mb-2 text-sm ${bad ? "font-semibold text-neg" : "text-pos"}`}>
            {bad ? `${bad} figure${bad === 1 ? "" : "s"} disagree with their proofs: a bug in the app, not your documents. Each one is withheld on its page.` : "Every figure ties to its proof, to the cent."}
          </p>
          <div className={table.wrap}>
            <table className={`${table.table} min-w-[32rem]`}>
              <thead className={table.head}>
                <tr>
                  <th className={table.th}>Page</th>
                  <th className={table.thR}>Figures</th>
                  <th className={table.thR}>Problems</th>
                </tr>
              </thead>
              <tbody>
                {r.pages.map((p) => (
                  <tr key={p.page} className={table.tr}>
                    <td className={table.td}>{p.page}</td>
                    <td className={table.tdR}>{p.figures.toLocaleString()}</td>
                    <td className={`${table.tdR} ${p.problems ? "font-semibold text-neg" : ""}`}>{p.problems || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {bad > 0 && (
            <ul className="mt-3 flex flex-col gap-2 text-xs">
              {r.problems.map((p, i) => (
                <li key={i}>
                  <Badge tone="neg">{KIND_WORDS[p.kind]}</Badge> <span className="font-medium text-fg">{p.page}</span>
                  <span className="text-muted"> — {p.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

/** Open findings inside the data edge: what withholds figures today. */
export function openIssues(r: BookReport) {
  const inRange = r.findings.filter((f) => !f.atEdge);
  return { inRange, failing: inRange.filter((f) => f.status === "FAIL"), missing: inRange.filter((f) => f.status === "MISSING") };
}

/**
 * What to fix: every open finding (each one withholds the figures in its scope until
 * it's resolved), what's awaited past the data edge, and accepted exceptions whose
 * finding no longer arises.
 */
export function IssuesPanel({ r, onAccept, onRetire, onGo }: { r: BookReport; onAccept: OnAccept; onRetire: OnRetire; onGo: (tab: "plan") => void }) {
  // Findings past the data edge are listed apart: what's awaited, not what's broken.
  const { inRange, failing, missing } = openIssues(r);
  const edge = r.findings.filter((f) => f.atEdge);
  const passingChecks = r.checks.filter((c) => c.failed === 0 && c.missing === 0).length;
  return (
    <>
      <StatGrid cols={6}>
        <StatCell label="Failing" value={String(failing.length)} tone={failing.length ? "neg" : "pos"} sub="data that contradicts itself" />
        <StatCell label="Missing" value={String(missing.length)} tone={missing.length ? "warn" : "pos"} sub="statements or stubs not on file" />
        <StatCell
          label="Proven through"
          value={date(r.horizon.netWorth)}
          sub={`the data edge${r.horizon.cashFlow > r.horizon.netWorth ? ` · cash flow through ${date(r.horizon.cashFlow)}` : ""}${edge.length ? ` · ${edge.length} awaiting newer statements` : ""}`}
        />
        <StatCell label="Checks fully passing" value={`${passingChecks} / ${r.checks.length}`} tone={passingChecks === r.checks.length ? "pos" : "neutral"} sub="details on Checks" />
        <StatCell label="Inferred" value={String(r.inferences.length)} sub="proven from two other sources" />
        <StatCell
          label="Accepted exceptions"
          value={String(r.accepted.length)}
          tone={r.stale.length ? "warn" : "neutral"}
          sub={r.stale.length ? `explained by you · ${r.stale.length} to review` : "explained by you"}
        />
      </StatGrid>

      {r.stale.length > 0 && <StaleList stale={r.stale} onRetire={onRetire} />}

      {failing.length > 0 && (
        <FindingList
          title={`Failing (${failing.length})`}
          subtitle="The data contradicts itself: a statement or stub read wrong, a transfer that doesn't pair, totals that don't tie. Every figure these touch is withheld until fixed."
          findings={failing}
          onAccept={onAccept}
        />
      )}
      {missing.length > 0 && (
        <FindingList
          title={`Missing data (${missing.length})`}
          subtitle="Statements and pay stubs that aren't on file. Drop them in the statements folder and scan it on the Import tab; the figures they block appear once every check passes."
          findings={missing}
          onAccept={onAccept}
        />
      )}
      {edge.length > 0 && <EdgeList r={r} findings={edge} onAccept={onAccept} onGo={onGo} />}
      {inRange.length === 0 && (
        <Card title={edge.length ? `Everything through ${date(r.horizon.netWorth)} is proven` : "Everything is proven"}>
          <p className="text-sm text-muted">Every check passes: every figure in the app is backed by statements and pay stubs that agree with each other.</p>
        </Card>
      )}
    </>
  );
}

/**
 * What stands behind every figure: each check with its tally, every figure inferred from
 * two sources, and every exception you accepted or retired by hand.
 */
export function ChecksPanel({ r, onRetire, api }: { r: BookReport; onRetire: OnRetire; api: Api }) {
  return (
    <>
      <SweepCard api={api} />
      <Card title="Checks" subtitle="What stands behind every figure. Counts are items checked (statements, stubs, transfers, years…).">
        <div className={table.wrap}>
          <table className={`${table.table} min-w-[48rem]`}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Check</th>
                <th className={table.thR}>Passed</th>
                <th className={table.thR}>Inferred</th>
                <th className={table.thR}>Failing</th>
                <th className={table.thR}>Missing</th>
                <th className={table.thR} title="Past the data edge: statements still on their way">
                  Awaiting
                </th>
                <th className={table.thR}>Accepted</th>
              </tr>
            </thead>
            <tbody>
              {r.checks.map((c) => (
                <tr key={c.id} className={table.tr}>
                  <td className={table.td}>
                    <div className="font-medium text-fg">{c.title}</div>
                    <div className="text-xs text-muted">{c.description}</div>
                  </td>
                  <td className={table.tdR}>{c.passed || "—"}</td>
                  <td className={table.tdR}>{c.inferred || "—"}</td>
                  <td className={`${table.tdR} ${c.failed ? "font-semibold text-neg" : ""}`}>{c.failed || "—"}</td>
                  <td className={`${table.tdR} ${c.missing ? "font-semibold text-warn" : ""}`}>{c.missing || "—"}</td>
                  <td className={table.tdR}>{c.awaiting || "—"}</td>
                  <td className={table.tdR}>{c.accepted || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {r.inferences.length > 0 && (
        <Card
          title={`Inferred (${r.inferences.length})`}
          subtitle="Figures not read directly from one document: proven by two sources that agree, or — tagged partial — taken from year-to-date totals because the earlier documents aren't available."
        >
          <ul className="flex flex-col gap-2 text-xs">
            {r.inferences.map((i) => (
              <li key={i.id}>
                {i.partial && (
                  <>
                    <Badge tone="warn">partial</Badge>{" "}
                  </>
                )}
                <span className="font-medium text-fg">{i.title}</span>
                <span className="text-muted"> — {i.detail}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {r.accepted.length > 0 && <AcceptedList accepted={r.accepted} onRetire={onRetire} />}
      {r.retired.length > 0 && <RetiredList retired={r.retired} />}
    </>
  );
}

/**
 * Past the data edge: the statements after it haven't all arrived, so what's open there
 * is mostly the other half of something already on file. Pages stop at the edge, so
 * none of it withholds a figure; listed quietly. Which statements settle them is on
 * the To download tab.
 */
function EdgeList({ r, findings, onAccept, onGo }: { r: BookReport; findings: Finding[]; onAccept: OnAccept; onGo: (tab: "plan") => void }) {
  const [open, setOpen] = useState(false);
  const fails = findings.filter((f) => f.status === "FAIL").length;
  return (
    <Card
      title={`After ${date(r.horizon.netWorth)}: awaiting statements (${findings.length})`}
      subtitle={`Every account has statements through ${date(r.horizon.netWorth)}, the data edge. Past it some have arrived and some haven't, so the pages stop there and nothing here withholds a figure. These clear as the statements on the To download tab come in.`}
    >
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <button type="button" className={`${btn.link} text-xs`} onClick={() => setOpen(!open)}>
          {open ? "Hide what's waiting" : `Show what's waiting (${findings.length}${fails ? `, ${fails} that won't pair even with both statements on file` : ""})`}
        </button>
        <button type="button" className={`${btn.link} text-xs`} onClick={() => onGo("plan")}>
          What to download →
        </button>
      </div>
      {open && (
        <ul className="mt-2 flex flex-col divide-y divide-line">
          {groupByFix(findings).map(([fix, fs]) => (
            <FindingGroup key={fix} fix={fix} findings={fs} onAccept={onAccept} />
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Grouped by what to do, so one download clears every finding it explains. */
function groupByFix(findings: Finding[]): [string, Finding[]][] {
  const m = new Map<string, Finding[]>();
  for (const f of findings) m.set(f.fix, [...(m.get(f.fix) ?? []), f]);
  return [...m];
}

function FindingList({ title, subtitle, findings, onAccept }: { title: string; subtitle: string; findings: Finding[]; onAccept: OnAccept }) {
  const groups = useMemo(() => groupByFix(findings), [findings]);
  return (
    <Card title={title} subtitle={subtitle}>
      <ul className="flex flex-col divide-y divide-line">
        {groups.map(([fix, fs]) => (
          <FindingGroup key={fix} fix={fix} findings={fs} onAccept={onAccept} />
        ))}
      </ul>
    </Card>
  );
}

function FindingGroup({ fix, findings, onAccept }: { fix: string; findings: Finding[]; onAccept: OnAccept }) {
  const [all, setAll] = useState(false);
  const shown = all ? findings : findings.slice(0, 3);
  return (
    <li className="py-2.5">
      <div className="text-[13px] font-medium text-fg">
        {fix}
        {findings.length > 1 && <span className="ml-2 text-xs font-normal text-muted">({findings.length} findings)</span>}
      </div>
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {shown.map((f) => (
          <FindingRow key={f.id} f={f} onAccept={onAccept} />
        ))}
      </ul>
      {findings.length > 3 && (
        <button type="button" className={`${btn.link} mt-1.5 text-xs`} onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${findings.length}`}
        </button>
      )}
    </li>
  );
}

function FindingRow({ f, onAccept }: { f: Finding; onAccept: OnAccept }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const affects = f.scope.affects.map((a) => ({ CASH_FLOW: "cash flow", NET_WORTH: "net worth", PAY: "pay", TAX: "taxes", HOLDINGS: "positions", BONUS: "bonus letters" })[a]).join(", ");
  return (
    <li className="rounded-md bg-surface-2 px-2.5 py-2 text-xs">
      <div className="flex flex-wrap items-start gap-2">
        <Badge tone={f.status === "FAIL" ? "neg" : f.atEdge ? "neutral" : "warn"}>{f.status === "FAIL" ? "failing" : f.atEdge ? "awaiting" : "missing"}</Badge>
        <span className="min-w-0 flex-1 font-medium text-fg">{f.title}</span>
        <button type="button" className={btn.link} onClick={() => setOpen(!open)}>
          {open ? "Cancel" : "Accept as explained…"}
        </button>
      </div>
      <p className="mt-1 text-muted">{f.detail}</p>
      <p className="mt-0.5 text-faint">
        {f.atEdge
          ? "Past the data edge: withholds nothing the pages show."
          : `Withholds ${affects} for ${f.scope.from === f.scope.to ? f.scope.from : `${f.scope.from} – ${f.scope.to}`}.`}
      </p>
      {open && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            className="min-w-[16rem] flex-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-xs"
            placeholder="Why this is fine (required) — e.g. employer true-up deposited by the plan"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            type="button"
            className={btn.secondary}
            disabled={!note.trim() || busy}
            onClick={async () => {
              setBusy(true);
              await onAccept(f.id, note);
              setBusy(false);
            }}
          >
            Accept
          </button>
          <span className="w-full text-faint">An accepted finding stops withholding figures but stays listed on the Checks tab, with your note.</span>
        </div>
      )}
    </li>
  );
}

/**
 * Retiring an exception is the owner's call, with a reason (the one way an exception
 * leaves the permanent list). The reason starts from the evidence, when there is some.
 */
function RetireForm({ id, initial, label, onRetire, onDone }: { id: string; initial: string; label: string; onRetire: OnRetire; onDone: () => void }) {
  const [reason, setReason] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-2 flex flex-wrap items-start gap-2">
      <textarea
        className="min-h-[3.5rem] min-w-[16rem] flex-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-xs"
        placeholder="Why it's no longer needed (required) — e.g. the missing statement is now on file"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button
        type="button"
        className={btn.danger}
        disabled={!reason.trim() || busy}
        onClick={async () => {
          setBusy(true);
          await onRetire(id, reason);
          setBusy(false);
          onDone();
        }}
      >
        {label}
      </button>
      <span className="w-full text-faint">The exception moves to Retired with your reason; it&apos;s never deleted.</span>
    </div>
  );
}

function AcceptedList({ accepted, onRetire }: { accepted: AcceptedFinding[]; onRetire: OnRetire }) {
  return (
    <Card
      title={`Accepted exceptions (${accepted.length})`}
      subtitle="Findings you explained by hand. They don't withhold figures, and they're kept outside the database, so a rebuild applies them again."
    >
      <ul className="flex flex-col gap-2 text-xs">
        {accepted.map((f) => (
          <AcceptedRow key={f.id} f={f} onRetire={onRetire} />
        ))}
      </ul>
    </Card>
  );
}

function AcceptedRow({ f, onRetire }: { f: AcceptedFinding; onRetire: OnRetire }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-md bg-surface-2 px-2.5 py-2">
      <div className="flex flex-wrap items-start gap-2">
        <Badge tone="info">accepted</Badge>
        <span className="min-w-0 flex-1 font-medium text-fg">{f.title}</span>
        <button type="button" className={btn.link} onClick={() => setOpen(!open)}>
          {open ? "Cancel" : "Withdraw…"}
        </button>
      </div>
      <p className="mt-1 text-muted">{f.detail}</p>
      <p className="mt-0.5 text-fg-2">
        Your note: “{f.note}” · {date(f.acceptedAt.slice(0, 10))}
      </p>
      {open && <RetireForm id={f.exceptionId} initial="" label="Withdraw" onRetire={onRetire} onDone={() => setOpen(false)} />}
    </li>
  );
}

function StaleList({ stale, onRetire }: { stale: StaleException[]; onRetire: OnRetire }) {
  return (
    <Card
      title={`Exceptions to review (${stale.length})`}
      subtitle="You accepted these, but their finding no longer arises. Nothing is removed until you approve it: read why below, then retire it — or leave it, and it stays on the list."
    >
      <ul className="flex flex-col gap-2 text-xs">
        {stale.map((e) => (
          <StaleRow key={e.id} e={e} onRetire={onRetire} />
        ))}
      </ul>
    </Card>
  );
}

function StaleRow({ e, onRetire }: { e: StaleException; onRetire: OnRetire }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-md bg-surface-2 px-2.5 py-2">
      <div className="flex flex-wrap items-start gap-2">
        <Badge tone="warn">to review</Badge>
        <span className="min-w-0 flex-1 font-medium text-fg">{e.finding.title}</span>
        <button type="button" className={btn.link} onClick={() => setOpen(!open)}>
          {open ? "Cancel" : "Approve retiring…"}
        </button>
      </div>
      <p className="mt-1 text-muted">{e.finding.detail}</p>
      <p className="mt-0.5 text-fg-2">
        Your note: “{e.note}” · {date(e.acceptedAt.slice(0, 10))}
      </p>
      <div className="mt-1.5 font-medium text-fg">Why it no longer arises</div>
      <ul className="mt-0.5 list-disc pl-4 text-muted">
        {e.evidence.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      {open && <RetireForm id={e.id} initial={e.evidence.join(" ")} label="Retire" onRetire={onRetire} onDone={() => setOpen(false)} />}
    </li>
  );
}

function RetiredList({ retired }: { retired: RetiredException[] }) {
  return (
    <Card title={`Retired exceptions (${retired.length})`} subtitle="Exceptions you retired, with why. Kept as a permanent record; they no longer apply.">
      <details className="text-xs">
        <summary className="cursor-pointer text-muted">Show</summary>
        <ul className="mt-2 flex flex-col gap-2">
          {[...retired].reverse().map((e) => (
            <li key={`${e.id}@${e.retiredAt}`} className="rounded-md bg-surface-2 px-2.5 py-2">
              <div className="font-medium text-fg">{e.finding.title}</div>
              <p className="mt-0.5 text-fg-2">
                Your note: “{e.note}” · accepted {date(e.acceptedAt.slice(0, 10))}
              </p>
              <p className="mt-0.5 text-muted">
                Retired {date(e.retiredAt.slice(0, 10))}: {e.reason}
              </p>
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}
