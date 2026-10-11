const intFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

export function formatIntegerDisplay(n: number): string {
  if (!Number.isFinite(n)) {
    return "";
  }
  return intFormatter.format(Math.trunc(n));
}

/** Strip grouping; keep optional leading minus; digits only for integer mode. */
export function parseIntegerInput(raw: string): number {
  const s = raw.replace(/,/g, "").trim();
  if (s === "" || s === "-") {
    return 0;
  }
  const n = parseInt(s.replace(/[^\d-]/g, "").replace(/(?!^)-/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

export function clampInt(n: number, min?: number, max?: number): number {
  let x = Math.trunc(n);
  if (min !== undefined) {
    x = Math.max(min, x);
  }
  if (max !== undefined) {
    x = Math.min(max, x);
  }
  return x;
}

export function fractionDigitsForStep(step: number): number {
  if (!Number.isFinite(step) || step >= 1) {
    return 0;
  }
  const t = step.toString();
  const i = t.indexOf("e-");
  if (i >= 0) {
    return Math.max(0, parseInt(t.slice(i + 2), 10) || 0);
  }
  const d = t.split(".")[1];
  return d ? d.length : 2;
}

export function formatDecimalDisplay(n: number, maxFrac: number): string {
  if (!Number.isFinite(n)) {
    return "";
  }
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFrac,
  }).format(n);
}

export function parseDecimalInput(raw: string, maxFrac: number): number {
  const s = raw.replace(/,/g, "").trim();
  if (s === "" || s === "-" || s === ".") {
    return 0;
  }
  const cleaned = s.replace(/[^\d.-]/g, "").replace(/(?!^)-/g, "");
  const x = parseFloat(cleaned);
  if (!Number.isFinite(x)) {
    return 0;
  }
  const f = 10 ** maxFrac;
  return Math.round(x * f) / f;
}

export function clampDecimal(
  n: number,
  min?: number,
  max?: number,
  maxFrac?: number,
): number {
  let x = n;
  if (maxFrac !== undefined && maxFrac >= 0) {
    const f = 10 ** maxFrac;
    x = Math.round(x * f) / f;
  }
  if (min !== undefined) {
    x = Math.max(min, x);
  }
  if (max !== undefined) {
    x = Math.min(max, x);
  }
  return x;
}
