"use client";

import type { Api } from "@/components/ledger/useApi";
import { notify } from "@/components/ui/Feedback";
import { btn, selectCls, table } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { vsActualDerived, vsKey } from "@/lib/book/derived/forecast";
import { derivedTarget } from "@/lib/book/derived/types";
import { formatDisplayDateFromYmd } from "@/lib/displayTime";
import { formatPercentRatio, usd0, usdDelta } from "@/lib/formatMoney";
import { calibration, leaning, VS_LABEL, type VsSnapshot } from "@/lib/forecast/vsActual";
import { useEffect, useMemo, useState } from "react";

type VsReport = { kept: number; latest: string | null; vs: VsSnapshot[] };
const VS = "/api/forecast/vs-actual";

/**
 * Forecast › vs actual: each kept forecast held to the months proven since, line by line, and
 * which way it leans. Kept forecasts are never rebuilt: what was projected then is what's held.
 */
export function VsActual({ api, dirty }: { api: Api; dirty: boolean }) {
  const [r, setR] = useState<VsReport | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!api.ready) return;
    api.call<VsReport>(VS).then(setR).catch(() => setR(null));
  }, [api, version]);
  const derived = useMemo(() => vsActualDerived(r?.vs ?? []), [r]);
  const cal = useMemo(() => calibration(r?.vs ?? []), [r]);
  if (!r) return null;
  const s = r.vs.find((x) => x.id === pick) ?? r.vs.at(-1);
  const keep = async () => {
    setBusy(true);
    try {
      await api.call(VS, { method: "POST" });
      notify("Kept: it's held to each month as it's proven");
      setVersion((v) => v + 1);
    } catch (e) {
      notify(e instanceof Error ? e.message : "Couldn't keep it", { tone: "bad" });
    } finally {
      setBusy(false);
    }
  };
  const dp = (figure: string, line: string) => derivedTarget("forecast", derived, figure, vsKey(s!.id, line));
  return (
    <section aria-label="Forecast vs actual" className="rounded-lg border border-line bg-surface shadow-[var(--shadow)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Forecast vs actual</span>
        <span className="truncate text-[11px] text-faint">
          {r.kept ? `${r.kept} kept forecast${r.kept === 1 ? "" : "s"}, each held as it was` : "a forecast is kept each time you save the drivers"}
        </span>
        {r.vs.length > 1 && (
          <select data-audit-view="" aria-label="Kept forecast" className={`${selectCls} ml-auto !py-0.5 text-[11px]`} value={s?.id ?? ""} onChange={(e) => setPick(e.target.value)}>
            {[...r.vs].reverse().map((x) => (
              <option key={x.id} value={x.id}>
                kept {x.savedAt.slice(0, 10)}
              </option>
            ))}
          </select>
        )}
        <button type="button" className={`${btn.ghost} !px-2 !py-0.5 text-[11px] ${r.vs.length > 1 ? "" : "ml-auto"}`} disabled={dirty || busy} title={dirty ? "Save the drivers first: what's kept is the saved forecast" : "Keep the saved forecast as it stands, to hold to the months that come"} onClick={() => void keep()}>
          Keep this forecast
        </button>
      </div>
      {!s ? (
        <p className="px-3 py-2 text-xs text-muted">{r.kept ? "No month a kept forecast projected is proven yet." : "Nothing kept yet."}</p>
      ) : (
        <div className={table.wrap}>
          <table className={`${table.table} text-[12.5px]`}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>
                  Kept {formatDisplayDateFromYmd(s.savedAt.slice(0, 10))} · {s.months} month{s.months === 1 ? "" : "s"} proven, {s.from} to {s.through}
                </th>
                <th className={table.thR}>Projected</th>
                <th className={table.thR}>Actual</th>
                <th className={table.thR} title="Projected less actual: above zero, the forecast ran high">Miss</th>
                <th className={table.th}>Leaning</th>
              </tr>
            </thead>
            <tbody>
              {s.rows.map((row) => (
                <tr key={row.line} className={table.trHover}>
                  <td className={table.td} title={`Projected as: ${s.forecastWords[row.line]}`}>
                    {VS_LABEL[row.line]}
                  </td>
                  <td className={`${table.tdR} text-muted`}>
                    <ProofValue proof={dp("vs-forecast", row.line)}>{usd0(row.forecastCents)}</ProofValue>
                  </td>
                  <td className={table.tdR}>
                    <ProofValue proof={dp("vs-actual", row.line)}>{usd0(row.actualCents)}</ProofValue>
                  </td>
                  <td className={`${table.tdR} font-medium`}>
                    <ProofValue proof={dp("vs-miss", row.line)}>{usdDelta(row.missCents)}</ProofValue>
                  </td>
                  <td className={`${table.td} text-xs text-muted`}>
                    {leaning(row)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cal && (
        <div className="border-t border-line px-3 py-2">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted" title="Each proven month any kept forecast projected, held to the newest forecast kept before the month began: what to expect of today's">
            Calibration · {cal[0]!.months.length} proven month{cal[0]!.months.length === 1 ? "" : "s"}, the forecast as it stood going in
          </p>
          <ul className="grid gap-x-6 gap-y-0.5 text-xs sm:grid-cols-2">
            {cal.map((row) => (
              <li key={row.line} className="flex justify-between gap-3">
                <span className="text-muted">{VS_LABEL[row.line]}</span>
                <span>
                  <ProofValue proof={derivedTarget("forecast", derived, "vs-cal-miss", row.line)}>{usdDelta(row.missCents)}</ProofValue>
                  {row.share != null && (
                    <>
                      {" · "}
                      {row.share >= 0 ? "runs high by " : "runs low by "}
                      <ProofValue proof={derivedTarget("forecast", derived, "vs-cal-share", row.line)}>{formatPercentRatio(Math.abs(row.share), 1)}</ProofValue>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
