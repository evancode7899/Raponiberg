"use client";

import { mortgageFigures, type MortgageFigures } from "@/lib/mortgage/figures";
import type { MortgageInputs } from "@/lib/mortgage/inputs";
import { useEffect, useRef, useState } from "react";

export type WorkerFigures = Pick<MortgageFigures, "mc" | "values">;

type Asked = { eff: MortgageInputs; labels: Record<string, string> };

/**
 * Prepay vs invest's simulation and headline values, worked out in a Web Worker
 * (lib/mortgage/figures.worker.ts) so a slider drag never waits on the ~700 ms of simulated
 * markets. `pending` is true while the latest inputs are still being worked out (the page
 * shows the last answer beside a spinner). Without Workers it works them out here.
 */
export function useMortgageFigures(eff: MortgageInputs, labels: Record<string, string>): { fig: WorkerFigures | null; pending: boolean } {
  const worker = useRef<Worker | null>(null);
  const latest = useRef<{ id: number; asked: Asked } | null>(null);
  const [answer, setAnswer] = useState<(Asked & { fig: WorkerFigures }) | null>(null);

  useEffect(() => {
    if (typeof Worker === "undefined") return;
    const w = new Worker(new URL("../../lib/mortgage/figures.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<{ id: number } & WorkerFigures>) => {
      // Only the latest question's answer counts: an older one arriving late is dropped.
      const l = latest.current;
      if (l && e.data.id === l.id) setAnswer({ ...l.asked, fig: { mc: e.data.mc, values: e.data.values } });
    };
    worker.current = w;
    // Asked before the worker was up: ask again.
    if (latest.current) w.postMessage({ id: latest.current.id, ...latest.current.asked });
    return () => {
      w.terminate();
      worker.current = null;
    };
  }, []);

  useEffect(() => {
    const id = (latest.current?.id ?? 0) + 1;
    latest.current = { id, asked: { eff, labels } };
    const w = worker.current;
    if (w) {
      w.postMessage({ id, eff, labels });
      return;
    }
    // No Worker (an old browser, a test): work it out here, after this render.
    const t = setTimeout(() => {
      if (typeof Worker !== "undefined" || latest.current?.id !== id) return;
      const f = mortgageFigures(eff, labels);
      setAnswer({ eff, labels, fig: { mc: f.mc, values: f.values } });
    }, 0);
    return () => clearTimeout(t);
  }, [eff, labels]);

  return { fig: answer?.fig ?? null, pending: !answer || answer.eff !== eff || answer.labels !== labels };
}
