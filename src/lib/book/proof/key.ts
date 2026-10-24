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
