"use client";

import { Loading } from "@/components/ui/kit";
import dynamic from "next/dynamic";

/**
 * The Cash flow tabs past the first, each loaded when it's opened rather than with the page:
 * the page's first load carries only what the Overview draws (item 62: speed). A tab still
 * loading shows the same still skeleton as data still loading.
 */
// next/dynamic needs its options written out at each call.
export const SpendingTab = dynamic(() => import("./SpendingTab").then((m) => m.SpendingTab), { loading: () => <Loading /> });
export const TrendsTab = dynamic(() => import("./TrendsTab").then((m) => m.TrendsTab), { loading: () => <Loading /> });
export const PatternsTab = dynamic(() => import("./PatternsTab").then((m) => m.PatternsTab), { loading: () => <Loading /> });
export const UnusualTab = dynamic(() => import("./UnusualTab").then((m) => m.UnusualTab), { loading: () => <Loading /> });
export const YoyTab = dynamic(() => import("./YoyTab").then((m) => m.YoyTab), { loading: () => <Loading /> });
export const MerchantsTab = dynamic(() => import("./MerchantsTab").then((m) => m.MerchantsTab), { loading: () => <Loading /> });
export const RecurringTab = dynamic(() => import("./RecurringTab").then((m) => m.RecurringTab), { loading: () => <Loading /> });
export const BudgetTab = dynamic(() => import("./BudgetTab").then((m) => m.BudgetTab), { loading: () => <Loading /> });
export const IncomeTab = dynamic(() => import("./IncomeTab").then((m) => m.IncomeTab), { loading: () => <Loading /> });
