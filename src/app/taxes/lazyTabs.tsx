"use client";

import { Loading } from "@/components/ui/kit";
import dynamic from "next/dynamic";

/**
 * The Taxes tabs past the first, each loaded when it's opened rather than with the page:
 * the page's first load carries only what the Overview draws (item 62: speed). A tab still
 * loading shows the same still skeleton as data still loading.
 */
const opts = { loading: () => <Loading /> };
export const TaxWorksheet = dynamic(() => import("./TaxWorksheet").then((m) => m.TaxWorksheet), opts);
export const TaxComparison = dynamic(() => import("./TaxComparison").then((m) => m.TaxComparison), opts);
export const TaxIncome = dynamic(() => import("./TaxIncome").then((m) => m.TaxIncome), opts);
export const TaxPayments = dynamic(() => import("./TaxPayments").then((m) => m.TaxPayments), opts);
export const TaxW4 = dynamic(() => import("./TaxW4").then((m) => m.TaxW4), opts);
export const TaxFiled = dynamic(() => import("./TaxFiled").then((m) => m.TaxFiled), opts);
