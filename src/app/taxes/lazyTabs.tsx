"use client";

import { Loading } from "@/components/ui/kit";
import dynamic from "next/dynamic";

/**
 * The Taxes tabs past the first, each loaded when it's opened rather than with the page:
 * the page's first load carries only what the Overview draws (item 62: speed). A tab still
 * loading shows the same still skeleton as data still loading.
 */
// next/dynamic needs its options written out at each call.
export const TaxWorksheet = dynamic(() => import("./TaxWorksheet").then((m) => m.TaxWorksheet), { loading: () => <Loading /> });
export const TaxComparison = dynamic(() => import("./TaxComparison").then((m) => m.TaxComparison), { loading: () => <Loading /> });
export const TaxIncome = dynamic(() => import("./TaxIncome").then((m) => m.TaxIncome), { loading: () => <Loading /> });
export const TaxPayments = dynamic(() => import("./TaxPayments").then((m) => m.TaxPayments), { loading: () => <Loading /> });
export const TaxW4 = dynamic(() => import("./TaxW4").then((m) => m.TaxW4), { loading: () => <Loading /> });
export const TaxFiled = dynamic(() => import("./TaxFiled").then((m) => m.TaxFiled), { loading: () => <Loading /> });
