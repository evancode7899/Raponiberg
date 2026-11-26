/// <reference lib="webworker" />
import { mortgageFigures } from "./figures.ts";
import type { MortgageInputs } from "./inputs.ts";

/**
 * Prepay vs invest's figures off the page's thread (Home & mortgage › Prepay vs invest): the
 * simulated markets take most of a second, so the page posts the inputs here and keeps
 * answering the sliders. The same function the proof sweep runs; only what can cross to the
 * page is sent back (the simulation and the headline values).
 */
self.onmessage = (e: MessageEvent<{ id: number; eff: MortgageInputs; labels: Record<string, string> }>) => {
  const { id, eff, labels } = e.data;
  const f = mortgageFigures(eff, labels);
  (self as unknown as Worker).postMessage({ id, mc: f.mc, values: f.values });
};
