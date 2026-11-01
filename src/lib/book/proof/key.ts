/**
 * A stable key for a proof descriptor, whatever order its keys (and its nested objects'
 * keys) come in: how the page matches its figures against the ones the proof sweep
 * flagged (sweep.ts). Pure; runs on the server and in the browser alike.
 */
export function descriptorKey(d: unknown): string {
  if (Array.isArray(d)) return `[${d.map(descriptorKey).join(",")}]`;
  if (d && typeof d === "object")
    return `{${Object.keys(d)
      .filter((k) => (d as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${descriptorKey((d as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(d);
}

/** The calculator pages whose figures run on inputs the owner types (sensitivities, what-ifs). */
const WHAT_IF_PAGES = new Set(["home", "fire", "mortgage"]);

/**
 * The model a calculator figure runs, apart from the inputs typed into it: the page, the
 * figure and its metric. The sweep holds each model to its proof on the saved inputs; a
 * figure the owner works out on other inputs runs the same model on the same Book, so it
 * stands on that proof (clearance.ts). Null for anything that isn't a calculator figure.
 */
export function whatIfModelKey(d: unknown): string | null {
  if (!d || typeof d !== "object") return null;
  const x = d as Record<string, unknown>;
  if (x.report !== "planning" || !WHAT_IF_PAGES.has(x.page as string)) return null;
  return descriptorKey({ report: "planning", page: x.page, figure: x.figure, metric: x.metric });
}
