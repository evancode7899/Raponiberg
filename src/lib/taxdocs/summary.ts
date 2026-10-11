import { TAX_YEARS } from "../tax/params.ts";
import { taxDocsDir } from "./store.ts";
import { TAX_DOC_KIND_LABEL, type TaxDocKind, type TaxDocsFile } from "./types.ts";

/**
 * What the tax documents folder holds, for the Statements page: per year, how many of
 * each kind were read, and anything that couldn't be. File names only, no figures.
 */
export type TaxDocsSummary = {
  folder: string | null;
  configured: boolean;
  scannedAt: string | null;
  /** `checkable`: the app has that year's tax tables, so the Taxes page checks it against the filed return. */
  years: { year: number | null; kinds: { kind: TaxDocKind; label: string; count: number }[]; filed: string[]; checkable: boolean }[];
  issues: { file: string; message: string }[];
  total: number;
};

export function summarizeTaxDocs(f: TaxDocsFile | null): TaxDocsSummary {
  const folder = taxDocsDir() ?? f?.folder ?? null;
  const docs = f?.docs ?? [];
  const byYear = new Map<number | null, typeof docs>();
  for (const d of docs) byYear.set(d.year, [...(byYear.get(d.year) ?? []), d]);
  return {
    folder,
    configured: taxDocsDir() != null,
    scannedAt: f?.scannedAt ?? null,
    years: [...byYear]
      .sort((a, b) => (b[0] ?? 0) - (a[0] ?? 0))
      .map(([year, ds]) => {
        const kinds = new Map<TaxDocKind, number>();
        for (const d of ds.filter((x) => !x.superseded)) kinds.set(d.kind, (kinds.get(d.kind) ?? 0) + 1);
        return {
          year,
          kinds: [...kinds].map(([kind, count]) => ({ kind, label: TAX_DOC_KIND_LABEL[kind], count })),
          filed: ds.filter((d) => d.kind.startsWith("RETURN_") && !d.superseded).map((d) => TAX_DOC_KIND_LABEL[d.kind]),
          checkable: year != null && !!TAX_YEARS[year],
        };
      }),
    issues: [
      ...(f?.errors ?? []).map((e) => ({ file: e.file, message: e.error })),
      ...docs.filter((d) => !d.superseded && d.warnings.length).map((d) => ({ file: d.file, message: d.warnings.join(" ") })),
    ],
    total: docs.length,
  };
}
