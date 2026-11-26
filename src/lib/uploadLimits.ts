/**
 * How big an upload may be. The import page checks before sending, and the server checks
 * again before reading a byte (the request's Content-Length) and once more per file, so a
 * mistaken drop of a huge file (a video, a disk image) is refused rather than read into memory.
 * A scanned statement runs to a few MB; the caps leave room many times over.
 *
 * The proxy (src/proxy.ts) sees every request first, and Next.js gives it a copy of the body
 * cut at 10 MB unless told otherwise: MAX_REQUEST_BYTES is that size (next.config.ts), so an
 * upload under the caps arrives whole.
 */
const MB = 1024 * 1024;
export const MAX_STATEMENT_FILE_BYTES = 50 * MB;
export const MAX_STATEMENT_UPLOAD_BYTES = 250 * MB;
export const MAX_DATABASE_UPLOAD_BYTES = 250 * MB;
export const MAX_REQUEST_BYTES = Math.max(MAX_STATEMENT_UPLOAD_BYTES, MAX_DATABASE_UPLOAD_BYTES);

/** "50 MB", "2 GB". */
export function bytesLabel(n: number): string {
  return n >= 1024 * MB ? `${+(n / (1024 * MB)).toFixed(1)} GB` : n >= MB ? `${+(n / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Whether a request says it is bigger than `max` (a request that doesn't say is read, and its files checked). */
export function requestTooLarge(contentLength: string | null, max: number): boolean {
  const n = Number(contentLength);
  return Number.isFinite(n) && n > max;
}

/** The files over the per-file cap, as "name (size)". */
export function oversizedFiles(files: readonly { name: string; size: number }[], max = MAX_STATEMENT_FILE_BYTES): string[] {
  return files.filter((f) => f.size > max).map((f) => `${f.name} (${bytesLabel(f.size)})`);
}

/** Why a set of statement files can't be sent, or null when it can. */
export function statementUploadProblem(files: readonly { name: string; size: number }[]): string | null {
  const big = oversizedFiles(files);
  if (big.length) return `Over the ${bytesLabel(MAX_STATEMENT_FILE_BYTES)} a file may be: ${big.join(", ")}.`;
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > MAX_STATEMENT_UPLOAD_BYTES) return `${bytesLabel(total)} at once is over the ${bytesLabel(MAX_STATEMENT_UPLOAD_BYTES)} an import may be: import them in smaller batches.`;
  return null;
}
